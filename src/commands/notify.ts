// `fleet notify-orchestrator <msg> [--urgent]` — push a message to the
// orchestrator through the daemon's channel. The bridge for Claude /schedule
// routines (and any external trigger) to reach the orchestrator: a scheduled
// routine does its work with `fleet …`, then calls this to report back.
import { DAEMON_DEFAULTS, type DaemonConfig } from "../daemon/config.js";
import { routeMessage, type Delivery } from "../daemon/channel.js";
import { loadOrchestrator } from "../orchestrator-record.js";

export function notifyOrchestrator(message: string, urgent: boolean): Delivery {
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
