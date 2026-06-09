// The heartbeat loop (`fleet daemon run`). ONE shared daemon watches ALL live
// Captains: each tick it enumerates them and runs the existing per-Captain
// checks over the SET, routing each session's events to ITS orchestrator.
// Token-free: timers + cmux socket calls + our existing snapshot/notifications.
// Each beat per Captain: reconcile, classify, take bounded auto-actions,
// escalate anything that needs the orchestrator, refresh the sidebar.
import { spawn as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readScreen, cmuxBin, workspaceExists, closeWorkspace, type Target } from "../cmux.js";
import { listAgents, target } from "../registry.js";
import { snapshot } from "../commands/status.js";
import { resume } from "../commands/resume.js";
import { acceptBypassDialog } from "../commands/spawn.js";
import { updateSidebar, setHeartbeat } from "../dashboard.js";
import {
  loadSharedSettings,
  writeSharedState,
  removeSharedState,
  acquireSharedLock,
  releaseSharedLock,
  type DaemonConfig,
  type SharedSettings,
} from "./config.js";
import { loadAllOrchestrators, type OrchestratorRecord } from "../orchestrator-record.js";
import { routeMessage } from "./channel.js";
import { newMemory, evaluate, waveCompleteMessage, type DaemonMemory } from "./policy.js";

/** Every Captain whose workspace is still live — the set the daemon watches. */
export function liveCaptains(): OrchestratorRecord[] {
  return loadAllOrchestrators().filter((o) => o.workspaceId && workspaceExists(o.workspaceId));
}

/** Build a per-Captain DaemonConfig from its record + the shared tunables. */
function configForCaptain(o: OrchestratorRecord, s: SharedSettings): DaemonConfig {
  return {
    orchestrator: { workspace: o.workspaceId, surface: o.surfaceId },
    session: o.session,
    heartbeatSec: s.heartbeatSec,
    stuckMinutes: s.stuckMinutes,
    alertCooldownSec: s.alertCooldownSec,
    proactive: s.proactive,
  };
}

/** Run `fn` with FLEET_SESSION pinned to `session` so the registry/inbox the
 *  per-Captain checks read & route to are THIS Captain's, then restore. */
function withSession<T>(session: string, fn: () => T): T {
  const prev = process.env.FLEET_SESSION;
  process.env.FLEET_SESSION = session;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FLEET_SESSION;
    else process.env.FLEET_SESSION = prev;
  }
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function isBypassDialog(screen: string): boolean {
  return /Bypass Permissions mode/i.test(screen) && /Yes, I accept/i.test(screen);
}

function beat(cfg: DaemonConfig, mem: DaemonMemory): void {
  const rows = snapshot(); // reconcile + classify (marks dead)
  // Draw the dashboard + heartbeat on the ORCHESTRATOR's workspace (the daemon's
  // own CMUX_WORKSPACE_ID is the daemon pane, not where the user is watching).
  const orchWs = cfg.orchestrator.workspace;
  updateSidebar(rows, orchWs);
  setHeartbeat(rows, orchWs);

  const now = Date.now();
  const stuckThreshMs = cfg.stuckMinutes * 60_000;
  const cooldownMs = cfg.alertCooldownSec * 1000;
  const agents = listAgents();

  for (const a of agents) {
    if (a.status === "dead") continue;
    const t: Target = target(a);
    let screen = "";
    try {
      screen = readScreen(t, 40);
    } catch {
      // unreadable this tick — skip
    }

    // Bounded auto-action: clear a stuck --yolo bypass dialog instead of escalating.
    if (isBypassDialog(screen)) {
      try {
        acceptBypassDialog(t);
        console.log(`[daemon] auto-cleared bypass dialog for ${a.label}`);
      } catch {
        /* ignore */
      }
      continue;
    }

    // Stuck detection: track how long a running worker's screen is unchanged.
    const hash = sha1(screen);
    const prev = mem.screenSince[a.agentId];
    if (!prev || prev.hash !== hash) mem.screenSince[a.agentId] = { hash, since: now };
    const stuckMs = now - mem.screenSince[a.agentId]!.since;

    const msg = evaluate(
      { agentId: a.agentId, label: a.label, status: a.status, stuckMs },
      mem,
      now,
      cooldownMs,
      stuckThreshMs,
    );
    if (msg) {
      const delivery = routeMessage(cfg, msg.text, msg.urgent);
      console.log(`[daemon] ${delivery}${msg.urgent ? " (urgent)" : ""}: ${msg.text}`);
    }
  }

  // Forget tracking for agents that are gone.
  for (const id of Object.keys(mem.screenSince)) {
    if (!agents.find((a) => a.agentId === id)) delete mem.screenSince[id];
  }

  // Idle initiative: when the fleet goes from "something running" to "fully
  // idle", fire ONE proactive wake-prompt offering the next step. Re-arms when a
  // new worker starts running (so each wave gets one nudge, not a stream).
  const live = agents.filter((a) => a.status !== "dead");
  // "active" includes "unknown" (booting/indeterminate) so a wave isn't declared
  // complete while a worker is still starting up.
  const anyRunning = live.some((a) => a.status === "running" || a.status === "unknown");
  if (anyRunning) mem.waveAnnounced = false;
  if (cfg.proactive && !anyRunning && mem.prevAnyRunning && live.length > 0 && !mem.waveAnnounced) {
    const text = waveCompleteMessage(live);
    const delivery = routeMessage(cfg, text, true); // urgent → inject when idle, else inbox
    console.log(`[daemon] ${delivery} (wave-complete): ${text}`);
    mem.waveAnnounced = true;
  }
  mem.prevAnyRunning = anyRunning;

  console.log(`[daemon] beat · ${agents.length} agents · ${new Date().toISOString().slice(11, 19)}`);
}

export function runLoop(): void {
  // Single-instance guard: only the loop that wins the lock runs. A loser (e.g. a
  // racing `--split` spawned a second daemon workspace) closes its own pane and
  // exits, so we never double-watch the fleet.
  if (!acquireSharedLock()) {
    console.log("[daemon] another shared daemon already holds the lock — exiting");
    const myWs = process.env.CMUX_WORKSPACE_ID;
    if (myWs) {
      try {
        closeWorkspace(myWs);
      } catch {
        /* ignore — orphan pane is cosmetic */
      }
    }
    process.exit(0);
  }

  const settings = loadSharedSettings();
  const mems = new Map<string, DaemonMemory>(); // per-Captain memory (session-keyed)
  const resumed = new Set<string>(); // sessions already reconciled once
  const startedAt = new Date().toISOString();
  const daemonWorkspace = process.env.CMUX_WORKSPACE_ID;
  let ticks = 0;
  let lastBeatMs = 0;
  let stopping = false;
  const MIN_BEAT_MS = 1500; // debounce bursts (an event + a tick firing together)

  function doBeat(): void {
    if (stopping) return;
    const now = Date.now();
    if (now - lastBeatMs < MIN_BEAT_MS) return;
    lastBeatMs = now;
    ticks++;

    const captains = liveCaptains();
    const liveSessions = new Set(captains.map((c) => c.session));
    for (const o of captains) {
      const cfg = configForCaptain(o, settings);
      let mem = mems.get(o.session);
      if (!mem) {
        mem = newMemory();
        mems.set(o.session, mem);
      }
      withSession(o.session, () => {
        // Reconcile the registry against live cmux once when a Captain is first
        // adopted (auto-discovered Captains get the same startup reconcile).
        if (!resumed.has(o.session)) {
          resumed.add(o.session);
          try {
            resume();
          } catch (e) {
            console.error(`[daemon] resume failed (${o.session}): ${(e as Error).message}`);
          }
        }
        try {
          beat(cfg, mem!);
        } catch (e) {
          console.error(`[daemon] beat error (${o.session}): ${(e as Error).message}`);
        }
      });
    }

    // Drop memory + resume-state for Captains that closed (workspace gone).
    for (const s of [...mems.keys()]) if (!liveSessions.has(s)) mems.delete(s);
    for (const s of [...resumed]) if (!liveSessions.has(s)) resumed.delete(s);

    writeSharedState({
      pid: process.pid,
      startedAt,
      lastBeatAt: new Date().toISOString(),
      ticks,
      daemonWorkspace,
      watching: [...liveSessions],
    });
    console.log(
      `[daemon] beat · ${captains.length} captains · ${new Date().toISOString().slice(11, 19)}`,
    );
  }

  console.log(`[daemon] boot · shared · watching all live Captains · event-driven + ${settings.heartbeatSec}s tick`);
  doBeat();

  // Fast path: react to cmux's notification stream in real time (a worker's
  // completion fires a notification, so we respond in ~1s instead of waiting for
  // the next tick). Reconnects if the stream drops.
  let events: ReturnType<typeof spawnProcess> | undefined;
  function startEventStream(): void {
    if (stopping) return;
    try {
      events = spawnProcess(cmuxBin(), ["events", "--category", "notification", "--no-heartbeat", "--no-ack"], {
        env: { ...process.env, CMUX_QUIET: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      console.error(`[daemon] could not start event stream: ${(e as Error).message}`);
      return;
    }
    if (events.stdout) {
      createInterface({ input: events.stdout }).on("line", (line) => {
        if (/notification\.(created|requested)/.test(line)) doBeat();
      });
    }
    events.on("exit", () => {
      if (!stopping) {
        console.error("[daemon] event stream dropped; reconnecting in 3s");
        setTimeout(startEventStream, 3000);
      }
    });
  }
  startEventStream();

  // Slow path: periodic tick for the sidebar pulse, stuck/zombie detection (the
  // absence of events), and a safety net.
  const timer = setInterval(doBeat, settings.heartbeatSec * 1000);

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try {
      events?.kill();
    } catch {
      /* ignore */
    }
    releaseSharedLock();
    removeSharedState();
    console.log("[daemon] stopped");
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The interval + event stream keep the process alive.
}
