// `fleet daemon start|stop|status|run` — the always-on supervisor process.
import { rmSync } from "node:fs";
import { newWorkspace, closeWorkspace, workspaceExists } from "../cmux.js";
import {
  DAEMON_DEFAULTS,
  saveConfig,
  loadConfig,
  readState,
  statePath,
  pidAlive,
  type DaemonConfig,
} from "../daemon/config.js";
import { clearDashboard } from "../dashboard.js";
import { runLoop } from "../daemon/loop.js";
import { loadOrchestrator } from "../orchestrator-record.js";

export function daemonStart(opts: { proactive?: boolean } = {}): void {
  // Bind to the declared orchestrator if there is one — its workspace is the
  // report target and its session is the registry to watch. Otherwise fall back
  // to the current cmux session.
  const orch = loadOrchestrator();
  const target = orch
    ? { workspace: orch.workspaceId, surface: orch.surfaceId }
    : { workspace: process.env.CMUX_WORKSPACE_ID, surface: process.env.CMUX_SURFACE_ID };
  if (!target.workspace) {
    throw new Error(
      "no orchestrator declared and CMUX_WORKSPACE_ID unset — run `fleet orchestrate` first, or start from a cmux session",
    );
  }
  const session = process.env.FLEET_SESSION || orch?.session;

  const st = readState();
  if (st && pidAlive(st.pid)) {
    throw new Error(`daemon already running (pid ${st.pid}) — see \`fleet daemon status\``);
  }

  const cfg: DaemonConfig = {
    orchestrator: { workspace: target.workspace, surface: target.surface },
    session,
    heartbeatSec: DAEMON_DEFAULTS.heartbeatSec,
    stuckMinutes: DAEMON_DEFAULTS.stuckMinutes,
    alertCooldownSec: DAEMON_DEFAULTS.alertCooldownSec,
    proactive: opts.proactive ?? DAEMON_DEFAULTS.proactive,
  };
  saveConfig(cfg);

  // Launch the loop in its own cmux workspace — visible and token-free. Pass
  // FLEET_SESSION so the daemon watches the SAME registry as the orchestrator
  // (its own workspace wouldn't otherwise derive the right session).
  const prefix = session ? `FLEET_SESSION=${session} ` : "";
  const ws = newWorkspace({
    name: "fleet-daemon",
    cwd: process.cwd(),
    command: `${prefix}fleet daemon run`,
    focus: false,
  });
  console.log(
    `fleet daemon started in ${ws.workspaceRef} · orchestrator=${orch?.name ?? target.workspace} · session=${session ?? "(cwd)"}`,
  );
  console.log(
    `heartbeat ${cfg.heartbeatSec}s · proactive ${cfg.proactive ? "on" : "off"} · stop with \`fleet daemon stop\``,
  );
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
  // Clear the heartbeat/dashboard from the orchestrator's sidebar.
  const cfg = loadConfig();
  if (cfg) clearDashboard(cfg.orchestrator.workspace);
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
