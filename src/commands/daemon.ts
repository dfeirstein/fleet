// `fleet daemon start|stop|status|run` — the ONE always-on supervisor process.
// A single shared daemon watches ALL live Captains and routes each one's
// escalations to its own orchestrator (see src/daemon/loop.ts). Its lock/state
// are session-agnostic, so declaring any Captain just ensures it's running.
import { newWorkspace, closeWorkspace, workspaceExists } from "../cmux.js";
import {
  DAEMON_DEFAULTS,
  loadSharedSettings,
  saveSharedSettings,
  readSharedState,
  removeSharedState,
  releaseSharedLock,
  sharedDaemonRunning,
  pidAlive,
} from "../daemon/config.js";
import { clearDashboard } from "../dashboard.js";
import { runLoop, liveCaptains } from "../daemon/loop.js";

/**
 * Start the ONE shared daemon if it isn't already running — the generalized
 * entry every Captain declaration funnels through. A no-op when a live daemon
 * already holds the lock, so a second `--split` never double-starts. The loop
 * itself owns the lock (atomic O_EXCL), so even a racing double-spawn collapses
 * to a single watcher.
 */
export function ensureSharedDaemon(opts: { proactive?: boolean } = {}): void {
  // Persist tunables so the loop (and a later restart) pick them up.
  const settings = loadSharedSettings();
  saveSharedSettings({ ...settings, proactive: opts.proactive ?? settings.proactive });

  if (sharedDaemonRunning()) return; // already watching — nothing to do

  // Launch the loop in its own (session-agnostic) cmux workspace — visible and
  // token-free. No FLEET_SESSION: the shared loop iterates ALL Captains itself.
  const ws = newWorkspace({
    name: "fleet-daemon",
    cwd: process.cwd(),
    command: "fleet daemon run",
    focus: false,
  });
  console.log(`fleet daemon started in ${ws.workspaceRef} · shared · watching all live Captains`);
  console.log(
    `heartbeat ${DAEMON_DEFAULTS.heartbeatSec}s · proactive ${
      (opts.proactive ?? settings.proactive) ? "on" : "off"
    } · stop with \`fleet daemon stop\``,
  );
}

export function daemonStart(opts: { proactive?: boolean } = {}): void {
  if (sharedDaemonRunning()) {
    console.log("fleet daemon already running — see `fleet daemon status`");
    // Still honor a proactive toggle for the next restart.
    const settings = loadSharedSettings();
    if (opts.proactive !== undefined) saveSharedSettings({ ...settings, proactive: opts.proactive });
    return;
  }
  ensureSharedDaemon(opts);
}

export function daemonStop(): void {
  const st = readSharedState();
  if (!st) {
    console.log("daemon not running");
    releaseSharedLock(); // drop a stale lock if one lingered without state
    return;
  }
  if (st.daemonWorkspace && workspaceExists(st.daemonWorkspace)) {
    try {
      closeWorkspace(st.daemonWorkspace);
    } catch {
      /* ignore */
    }
  }
  // Clear the heartbeat/dashboard from every Captain's sidebar.
  for (const o of liveCaptains()) {
    try {
      clearDashboard(o.workspaceId);
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
  removeSharedState();
  releaseSharedLock();
  console.log("fleet daemon stopped");
}

export function daemonStatus(): void {
  const st = readSharedState();
  if (!st || !pidAlive(st.pid)) {
    console.log(st ? "daemon not running (stale state)" : "daemon not running");
    return;
  }
  const ageSec = Math.round((Date.now() - Date.parse(st.lastBeatAt)) / 1000);
  const captains = liveCaptains().map((o) => o.name);
  const watching = captains.length ? captains.join(", ") : "(no live Captains)";
  console.log(
    `daemon running · pid ${st.pid} · ${st.ticks} beats · last beat ${ageSec}s ago · workspace ${
      st.daemonWorkspace ?? "?"
    }`,
  );
  console.log(`watching ${captains.length} Captain${captains.length === 1 ? "" : "s"}: ${watching}`);
}

export function daemonRun(): void {
  runLoop();
}
