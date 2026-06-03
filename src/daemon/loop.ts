// The heartbeat loop (`fleet daemon run`). Token-free: timers + cmux socket
// calls + our existing snapshot/notifications. Each beat: reconcile, classify,
// take bounded auto-actions, escalate anything that needs the orchestrator,
// refresh the sidebar, record liveness.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readScreen, type Target } from "../cmux.js";
import { listAgents, target } from "../registry.js";
import { snapshot } from "../commands/status.js";
import { resume } from "../commands/resume.js";
import { acceptBypassDialog } from "../commands/spawn.js";
import { updateSidebar } from "../dashboard.js";
import { loadConfig, writeState, type DaemonConfig } from "./config.js";
import { routeMessage } from "./channel.js";
import { newMemory, evaluate, type DaemonMemory } from "./policy.js";

function sleepInterruptible(totalSec: number, stop: () => boolean): void {
  for (let i = 0; i < totalSec && !stop(); i++) execFileSync("sleep", ["1"]);
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function isBypassDialog(screen: string): boolean {
  return /Bypass Permissions mode/i.test(screen) && /Yes, I accept/i.test(screen);
}

function beat(cfg: DaemonConfig, mem: DaemonMemory): void {
  const rows = snapshot(); // reconcile + classify (marks dead)
  updateSidebar(rows);

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

  console.log(`[daemon] beat · ${agents.length} agents · ${new Date().toISOString().slice(11, 19)}`);
}

export function runLoop(): void {
  const cfg = loadConfig();
  if (!cfg) throw new Error("no daemon config — run `fleet daemon start` first");

  const mem = newMemory();
  const startedAt = new Date().toISOString();
  const daemonWorkspace = process.env.CMUX_WORKSPACE_ID;
  let stop = false;
  const stopFn = () => stop;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));

  console.log(`[daemon] boot · orchestrator=${cfg.orchestrator.workspace} · heartbeat=${cfg.heartbeatSec}s`);
  try {
    resume(); // reconcile registry against live cmux on startup
  } catch (e) {
    console.error(`[daemon] resume failed: ${(e as Error).message}`);
  }

  let ticks = 0;
  while (!stop) {
    ticks++;
    try {
      beat(cfg, mem);
    } catch (e) {
      console.error(`[daemon] beat error: ${(e as Error).message}`);
    }
    writeState({ pid: process.pid, startedAt, lastBeatAt: new Date().toISOString(), ticks, daemonWorkspace });
    sleepInterruptible(cfg.heartbeatSec, stopFn);
  }
  console.log("[daemon] stopped");
}
