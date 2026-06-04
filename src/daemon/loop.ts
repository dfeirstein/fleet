// The heartbeat loop (`fleet daemon run`). Token-free: timers + cmux socket
// calls + our existing snapshot/notifications. Each beat: reconcile, classify,
// take bounded auto-actions, escalate anything that needs the orchestrator,
// refresh the sidebar, record liveness.
import { spawn as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readScreen, cmuxBin, type Target } from "../cmux.js";
import { listAgents, target } from "../registry.js";
import { snapshot } from "../commands/status.js";
import { resume } from "../commands/resume.js";
import { acceptBypassDialog } from "../commands/spawn.js";
import { updateSidebar, setHeartbeat } from "../dashboard.js";
import { loadConfig, writeState, type DaemonConfig } from "./config.js";
import { routeMessage } from "./channel.js";
import { newMemory, evaluate, waveCompleteMessage, type DaemonMemory } from "./policy.js";

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
  const cfg = loadConfig();
  if (!cfg) throw new Error("no daemon config — run `fleet daemon start` first");

  const mem = newMemory();
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
    try {
      beat(cfg!, mem);
    } catch (e) {
      console.error(`[daemon] beat error: ${(e as Error).message}`);
    }
    writeState({ pid: process.pid, startedAt, lastBeatAt: new Date().toISOString(), ticks, daemonWorkspace });
  }

  console.log(
    `[daemon] boot · orchestrator=${cfg.orchestrator.workspace} · session=${cfg.session ?? "(cwd)"} · event-driven + ${cfg.heartbeatSec}s tick`,
  );
  try {
    resume(); // reconcile registry against live cmux on startup
  } catch (e) {
    console.error(`[daemon] resume failed: ${(e as Error).message}`);
  }
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
  const timer = setInterval(doBeat, cfg.heartbeatSec * 1000);

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try {
      events?.kill();
    } catch {
      /* ignore */
    }
    console.log("[daemon] stopped");
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The interval + event stream keep the process alive.
}
