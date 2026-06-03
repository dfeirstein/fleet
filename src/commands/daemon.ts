// `fleet daemon start|stop|status|run` — the always-on supervisor process.
import { rmSync } from "node:fs";
import { newWorkspace, closeWorkspace, workspaceExists } from "../cmux.js";
import {
  DAEMON_DEFAULTS,
  saveConfig,
  readState,
  statePath,
  pidAlive,
  type DaemonConfig,
} from "../daemon/config.js";
import { runLoop } from "../daemon/loop.js";

export function daemonStart(): void {
  const orchWs = process.env.CMUX_WORKSPACE_ID;
  if (!orchWs) {
    throw new Error(
      "run `fleet daemon start` from inside the orchestrator's cmux session (CMUX_WORKSPACE_ID not set)",
    );
  }
  const st = readState();
  if (st && pidAlive(st.pid)) {
    throw new Error(`daemon already running (pid ${st.pid}) — see \`fleet daemon status\``);
  }

  const cfg: DaemonConfig = {
    orchestrator: { workspace: orchWs, surface: process.env.CMUX_SURFACE_ID },
    heartbeatSec: DAEMON_DEFAULTS.heartbeatSec,
    stuckMinutes: DAEMON_DEFAULTS.stuckMinutes,
    alertCooldownSec: DAEMON_DEFAULTS.alertCooldownSec,
  };
  saveConfig(cfg);

  // Launch the loop in its own cmux workspace — visible and token-free.
  const ws = newWorkspace({ name: "fleet-daemon", cwd: process.cwd(), command: "fleet daemon run", focus: false });
  console.log(`fleet daemon started in ${ws.workspaceRef} · orchestrator=${orchWs}`);
  console.log(`heartbeat ${cfg.heartbeatSec}s · stop with \`fleet daemon stop\``);
}

export function daemonStop(): void {
  const st = readState();
  if (!st) {
    console.log("daemon not running");
    return;
  }
  if (st.daemonWorkspace && workspaceExists(st.daemonWorkspace)) {
    try {
      closeWorkspace(st.daemonWorkspace);
    } catch {
      /* ignore */
    }
  }
  if (pidAlive(st.pid)) {
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(statePath());
  } catch {
    /* ignore */
  }
  console.log("fleet daemon stopped");
}

export function daemonStatus(): void {
  const st = readState();
  if (!st || !pidAlive(st.pid)) {
    console.log(st ? "daemon not running (stale state)" : "daemon not running");
    return;
  }
  const ageSec = Math.round((Date.now() - Date.parse(st.lastBeatAt)) / 1000);
  console.log(
    `daemon running · pid ${st.pid} · ${st.ticks} beats · last beat ${ageSec}s ago · workspace ${st.daemonWorkspace ?? "?"}`,
  );
}

export function daemonRun(): void {
  runLoop();
}
