// cmux notification feed — the deterministic completion signal.
//
// cmux's wrapped Claude Code emits a notification when a worker finishes a turn
// ("Completed in <dir>") or blocks on input ("Waiting"), keyed to the worker's
// workspace_id. We read these instead of screen-scraping to know, for certain,
// when a worker is done.
import { cmuxJson } from "./cmux.js";

export interface CmuxNotification {
  workspace_id?: string;
  surface_id?: string;
  title?: string; // app source, e.g. "Claude Code"
  subtitle?: string; // state, e.g. "Completed in fleet-ev" / "Waiting"
  body?: string;
  created_at?: string;
  is_read?: boolean;
}

export function listNotifications(): CmuxNotification[] {
  try {
    return cmuxJson<{ notifications?: CmuxNotification[] }>(["rpc", "notification.list"]).notifications ?? [];
  } catch {
    return []; // notifications are an optimization; never break the caller
  }
}

/** Most-recent notification per workspace_id, by created_at. */
export function latestByWorkspace(list: CmuxNotification[]): Map<string, CmuxNotification> {
  const map = new Map<string, CmuxNotification>();
  for (const n of list) {
    if (!n.workspace_id || !n.created_at) continue;
    const prev = map.get(n.workspace_id);
    if (!prev || Date.parse(n.created_at) > Date.parse(prev.created_at ?? "")) {
      map.set(n.workspace_id, n);
    }
  }
  return map;
}

// cmux's Claude hook fires a notification when a worker's turn ENDS — either
// "Completed in <dir>" (finished with a result) or "Waiting / Claude is waiting
// for your input" (finished, now idle at the prompt). BOTH mean the turn ended;
// neither means "blocked mid-task on a y/n dialog" — that's the screen
// heuristic's job (AWAITING). So any of these phrases = the worker is quiescent.
const TURN_END = /complete|done|finish|wait|idle|ready/i;

/**
 * True if there's a turn-end notification newer than the worker's last dispatch
 * — a deterministic "this turn is over" signal. Stale notifications from a prior
 * turn (older than lastDispatchAt) are ignored so a re-dispatched worker isn't
 * marked done prematurely.
 */
export function turnEnded(notif: CmuxNotification | undefined, lastDispatchAt: string): boolean {
  if (!notif || !notif.created_at) return false;
  // Tolerance: the notification fires seconds after dispatch; guard sub-second skew.
  if (Date.parse(notif.created_at) < Date.parse(lastDispatchAt) - 1500) return false;
  return TURN_END.test(`${notif.subtitle ?? ""} ${notif.body ?? ""}`);
}
