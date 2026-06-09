// `fleet notify-orchestrator <msg> [--urgent]` — push a message to the
// orchestrator through the daemon's channel. The bridge for Claude /schedule
// routines (and any external trigger) to reach the orchestrator: a scheduled
// routine does its work with `fleet …`, then calls this to report back.
import { DAEMON_DEFAULTS, type DaemonConfig } from "../daemon/config.js";
import { routeMessage, type Delivery } from "../daemon/channel.js";
import { loadOrchestrator, loadAllOrchestrators } from "../orchestrator-record.js";
import { surfaceExists } from "../cmux.js";

/**
 * With FLEET_SESSION unset and more than one live Captain, defaulting would
 * inject the report into the wrong Captain's pane — refuse and name the
 * choices. Returns the error message, or undefined to proceed with the normal
 * resolution (single/no record keeps current behavior). Pure, for tests.
 */
export function multiCaptainRefusal(envSession: string | undefined, liveSessions: string[]): string | undefined {
  if (envSession) return undefined;
  const unique = [...new Set(liveSessions)].sort();
  if (unique.length <= 1) return undefined;
  return `FLEET_SESSION is unset and multiple Captains are live — set FLEET_SESSION=<one of: ${unique.join(", ")}>`;
}

export function notifyOrchestrator(message: string, urgent: boolean): Delivery {
  // Liveness is surface-level, matching the daemon (quadrant siblings share a
  // workspace, so a workspace check can't tell a dead pane from its neighbors).
  const live = loadAllOrchestrators().filter(
    (o) => o.workspaceId && o.surfaceId && surfaceExists({ workspace: o.workspaceId, surface: o.surfaceId }),
  );
  const refusal = multiCaptainRefusal(process.env.FLEET_SESSION, live.map((o) => o.session));
  if (refusal) throw new Error(refusal);
  // Resolve the target orchestrator from its per-session record (the source of
  // truth now that the shared daemon no longer writes a per-session config),
  // falling back to the current cmux session.
  const orch = loadOrchestrator();
  const target = orch
    ? { workspace: orch.workspaceId, surface: orch.surfaceId }
    : { workspace: process.env.CMUX_WORKSPACE_ID, surface: process.env.CMUX_SURFACE_ID };
  if (!target.workspace) {
    throw new Error("no orchestrator declared and CMUX_WORKSPACE_ID unset — can't locate the orchestrator");
  }
  const cfg: DaemonConfig = {
    orchestrator: { workspace: target.workspace, surface: target.surface },
    session: orch?.session,
    heartbeatSec: DAEMON_DEFAULTS.heartbeatSec,
    stuckMinutes: DAEMON_DEFAULTS.stuckMinutes,
    alertCooldownSec: DAEMON_DEFAULTS.alertCooldownSec,
    proactive: DAEMON_DEFAULTS.proactive,
  };
  return routeMessage(cfg, message, urgent);
}
