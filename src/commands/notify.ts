// `fleet notify-orchestrator <msg> [--urgent]` — push a message to the
// orchestrator through the daemon's channel. The bridge for Claude /schedule
// routines (and any external trigger) to reach the orchestrator: a scheduled
// routine does its work with `fleet …`, then calls this to report back.
import { loadConfig, DAEMON_DEFAULTS, type DaemonConfig } from "../daemon/config.js";
import { routeMessage, type Delivery } from "../daemon/channel.js";

export function notifyOrchestrator(message: string, urgent: boolean): Delivery {
  let cfg = loadConfig();
  if (!cfg) {
    // No daemon config — fall back to the current cmux session as the target.
    const ws = process.env.CMUX_WORKSPACE_ID;
    if (!ws) {
      throw new Error("no daemon config and CMUX_WORKSPACE_ID unset — can't locate the orchestrator");
    }
    cfg = {
      orchestrator: { workspace: ws, surface: process.env.CMUX_SURFACE_ID },
      heartbeatSec: DAEMON_DEFAULTS.heartbeatSec,
      stuckMinutes: DAEMON_DEFAULTS.stuckMinutes,
      alertCooldownSec: DAEMON_DEFAULTS.alertCooldownSec,
      proactive: DAEMON_DEFAULTS.proactive,
    } satisfies DaemonConfig;
  }
  return routeMessage(cfg, message, urgent);
}
