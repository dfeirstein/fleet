// `fleet watch [--until-idle]` — poll the fleet, print state transitions, mirror
// to the cmux sidebar, and (with --until-idle) block until the fleet is quiet.
//
// Designed to be launched in the background by the orchestrator: it exits when
// no worker is still running, so the orchestrator is notified the moment the
// wave is done — replacing ad-hoc polling loops.
import { execFileSync } from "node:child_process";
import { snapshot, type FleetRow } from "./status.js";
import { updateSidebar } from "../dashboard.js";

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
  const attention = rows.filter((r) => r.status === "awaiting-input" || r.status === "error");
  const out = ["Fleet digest:", ...lines];
  if (attention.length) {
    out.push("", `⚠ ${attention.length} need attention: ${attention.map((a) => a.label).join(", ")}`);
  }
  return out.join("\n");
}

export function watch(opts: WatchOptions): void {
  const start = Date.now();
  const prev = new Map<string, string>();
  let quietStreak = 0;

  for (;;) {
    const rows = snapshot(); // reconciles registry, classifies, returns rows
    updateSidebar(rows);

    // Print any status changes since the last poll.
    for (const r of rows) {
      const was = prev.get(r.agentId);
      if (was !== r.status) {
        console.log(`${ts()}  ${r.label}: ${was ?? "—"} → ${r.status}`);
        prev.set(r.agentId, r.status);
      }
    }
    // Forget agents that disappeared.
    for (const id of [...prev.keys()]) {
      if (!rows.find((r) => r.agentId === id)) prev.delete(id);
    }

    const running = rows.filter((r) => r.status === "running").length;

    if (opts.untilIdle) {
      // Debounce transient blank/unknown reads: require two consecutive quiet polls.
      if (running === 0) {
        quietStreak++;
        if (quietStreak >= 2) {
          console.log(`${ts()}  fleet quiescent (${rows.length} agents).`);
          console.log(digest(rows));
          return;
        }
      } else {
        quietStreak = 0;
      }
    }

    if (Date.now() - start > opts.timeoutSec * 1000) {
      console.log(`${ts()}  watch timed out after ${opts.timeoutSec}s.`);
      console.log(digest(rows));
      return;
    }

    sleepSeconds(running > 0 ? opts.intervalActive : opts.intervalIdle);
  }
}
