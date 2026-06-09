// `fleet watch [--until-idle]` — poll the fleet, print state transitions, mirror
// to the cmux sidebar, and (with --until-idle) block until the fleet is quiet.
//
// Designed to be launched in the background by the orchestrator: it exits when
// no worker is still running, so the orchestrator is notified the moment the
// wave is done — replacing ad-hoc polling loops.
import { execFileSync } from "node:child_process";
import { snapshot, type FleetRow } from "./status.js";
import { updateSidebar } from "../dashboard.js";
import { streamEvents, eventsSupported, type EventStreamHandle } from "../cmux.js";
import { FleetEventReactor, type EventFrame, type AckFrame } from "../events.js";
import { IdleDwell, DWELL_DEFAULTS } from "../quiescence.js";

function sleepSeconds(s: number): void {
  execFileSync("sleep", [String(s)]);
}

function ts(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS (UTC)
}

const ICON: Record<string, string> = {
  running: "●",
  idle: "◉",
  "awaiting-input": "◍",
  "blocked-on-you": "◍",
  "rate-limited": "⏳",
  error: "✗",
  dead: "☠",
  unknown: "◌",
};

export interface WatchOptions {
  untilIdle: boolean; // exit once no worker is running
  intervalActive: number; // poll seconds while a worker is running
  intervalIdle: number; // poll seconds while nothing is running
  timeoutSec: number; // hard cap
}

export const WATCH_DEFAULTS: WatchOptions = {
  untilIdle: true,
  intervalActive: 4,
  intervalIdle: 10,
  timeoutSec: 900,
};

function digest(rows: FleetRow[]): string {
  if (rows.length === 0) return "Fleet empty.";
  const lines = rows.map((r) => `  ${ICON[r.status] ?? "◌"} ${r.agentId}  ${r.label}  ${r.status}`);
  const attention = rows.filter(
    (r) => r.status === "awaiting-input" || r.status === "blocked-on-you" || r.status === "error",
  );
  const out = ["Fleet digest:", ...lines];
  if (attention.length) {
    out.push("", `⚠ ${attention.length} need attention: ${attention.map((a) => a.label).join(", ")}`);
  }
  return out.join("\n");
}

// "active" = not safely quiescent. Includes "unknown" (booting/indeterminate is
// NOT done), "blocked-on-you" (a worker waiting on the user keeps watch alive
// so the block stays surfaced until it's resolved — Plan §3), and
// "rate-limited" (mid-task, merely waiting out a limit before resuming — S4).
export function activeCount(rows: FleetRow[]): number {
  return rows.filter(
    (r) =>
      r.status === "running" ||
      r.status === "unknown" ||
      r.status === "blocked-on-you" ||
      r.status === "rate-limited",
  ).length;
}

/** Print status changes since the last reconcile and prune vanished agents. */
function printTransitions(rows: FleetRow[], prev: Map<string, string>): void {
  for (const r of rows) {
    const was = prev.get(r.agentId);
    if (was !== r.status) {
      console.log(`${ts()}  ${r.label}: ${was ?? "—"} → ${r.status}`);
      prev.set(r.agentId, r.status);
    }
  }
  for (const id of [...prev.keys()]) {
    if (!rows.find((r) => r.agentId === id)) prev.delete(id);
  }
}

/**
 * Watch the fleet until it's idle. Event-driven when cmux supports the event
 * stream (reacts to a transition in ~1s, not on the poll tick); falls back to
 * the periodic poll loop on an older cmux — same exit/timeout semantics either
 * way. Resolves when the fleet goes quiescent (or on timeout).
 */
export async function watch(opts: WatchOptions): Promise<void> {
  if (eventsSupported()) return watchEventDriven(opts);
  return watchPolling(opts);
}

/** The original poll loop — the capability-gated fallback (no event stream). */
function watchPolling(opts: WatchOptions): void {
  const start = Date.now();
  const prev = new Map<string, string>();
  const dwell = new IdleDwell();

  for (;;) {
    const rows = snapshot(); // reconciles registry, classifies, returns rows
    updateSidebar(rows);
    printTransitions(rows, prev);
    const active = activeCount(rows);

    if (opts.untilIdle) {
      // Stable-idle dwell (B1): one misattributed all-idle read must not end
      // the watch — require sustained idleness + no fresh dispatch.
      if (dwell.beat(active === 0, rows.map((r) => r.lastDispatchAt), Date.now())) {
        console.log(`${ts()}  fleet quiescent (${rows.length} agents).`);
        console.log(digest(rows));
        return;
      }
    }

    if (Date.now() - start > opts.timeoutSec * 1000) {
      console.log(`${ts()}  watch timed out after ${opts.timeoutSec}s.`);
      console.log(digest(rows));
      return;
    }

    sleepSeconds(active > 0 ? opts.intervalActive : opts.intervalIdle);
  }
}

/** Event-driven watch: a reactor turns the cmux stream into reconcile triggers;
 *  a low-frequency timer covers the slow path (stuck/zombie) + timeout. */
function watchEventDriven(opts: WatchOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const start = Date.now();
    const prev = new Map<string, string>();
    const dwell = new IdleDwell();
    let stopped = false;
    let lastReconcile = 0;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (rows: FleetRow[], why: string): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (confirmTimer) clearTimeout(confirmTimer);
      stream.stop();
      console.log(`${ts()}  ${why}`);
      console.log(digest(rows));
      resolve();
    };

    // Debounced so an event burst collapses to one reconcile; the timer path is
    // always allowed through (force) so the timeout/quiescence checks still run.
    const reconcile = (force = false): void => {
      if (stopped) return;
      const now = Date.now();
      if (!force && now - lastReconcile < 800) return;
      lastReconcile = now;

      const rows = snapshot();
      updateSidebar(rows);
      printTransitions(rows, prev);
      const active = activeCount(rows);

      if (opts.untilIdle) {
        if (active === 0) {
          // Stable-idle dwell (B1): exit only after sustained all-idle beats
          // spanning the dwell window with no fresh dispatch.
          if (dwell.beat(true, rows.map((r) => r.lastDispatchAt), Date.now())) {
            return finish(rows, `fleet quiescent (${rows.length} agents).`);
          }
          // Schedule the confirming reconcile past the dwell span WITHOUT
          // waiting for the slow tick — keeps exit prompt when no more events flow.
          if (confirmTimer) clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => reconcile(true), DWELL_DEFAULTS.minSpanMs + 500);
        } else {
          dwell.reset();
          if (confirmTimer) clearTimeout(confirmTimer);
        }
      }
      if (Date.now() - start > opts.timeoutSec * 1000) {
        return finish(rows, `watch timed out after ${opts.timeoutSec}s.`);
      }
    };

    const reactor = new FleetEventReactor({ onGap: () => reconcile(true) });
    const stream: EventStreamHandle = streamEvents({
      onAck: (a) => reactor.handleAck(a as AckFrame),
      onFrame: (f) => {
        if (reactor.handleFrame(f as EventFrame)) reconcile();
      },
      onExit: () => {
        /* --reconnect handles drops; nothing to do here */
      },
    });
    // Slow path: periodic reconcile so quiescence/timeout are caught even with
    // no events flowing (also the two-poll quiet debounce makes progress).
    const timer = setInterval(() => reconcile(true), opts.intervalIdle * 1000);
    reconcile(true); // initial snapshot
  });
}
