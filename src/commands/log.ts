// `fleet log <msg>` — drop a Captain milestone into cmux's per-workspace
// sidebar activity log, so dispatch/verify/escalation breadcrumbs show up in
// cmux's own chrome next to the fleet group. Tiny by design.
import { workspaceLog, logVerbSupported } from "../cmux.js";

export function logMilestone(
  message: string,
  opts: { level?: string; source?: string; workspace?: string } = {},
): boolean {
  if (!logVerbSupported()) {
    console.error("fleet log: this cmux build has no sidebar `log` verb — skipped");
    return false;
  }
  const levels = ["info", "progress", "success", "warning", "error"] as const;
  const level = levels.find((l) => l === opts.level);
  if (opts.level && !level) throw new Error(`bad --level "${opts.level}" (use ${levels.join("|")})`);
  workspaceLog(message, {
    level,
    source: opts.source ?? "fleet",
    // Defaults to the caller's own workspace via $CMUX_WORKSPACE_ID inside cmux.
    workspace: opts.workspace,
  });
  return true;
}
