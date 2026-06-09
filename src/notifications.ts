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

function putLatest(map: Map<string, CmuxNotification>, key: string, n: CmuxNotification): void {
  const prev = map.get(key);
  if (!prev || Date.parse(n.created_at ?? "") > Date.parse(prev.created_at ?? "")) {
    map.set(key, n);
  }
}

/** Most-recent notification per workspace_id, by created_at. */
export function latestByWorkspace(list: CmuxNotification[]): Map<string, CmuxNotification> {
  const map = new Map<string, CmuxNotification>();
  for (const n of list) {
    if (!n.workspace_id || !n.created_at) continue;
    putLatest(map, n.workspace_id, n);
  }
  return map;
}

/**
 * Notifications indexed for per-PANE attribution. Same-project workers share
 * one workspace as split panes, so keying on workspace alone lets one sibling's
 * "Completed" flip every worker in the workspace (B1). Notifications carrying a
 * surface_id are keyed on it; only surfaceless ones land in the workspace map.
 */
export interface NotificationIndex {
  bySurface: Map<string, CmuxNotification>;
  byWorkspace: Map<string, CmuxNotification>; // notifications with NO surface_id
}

export function indexNotifications(list: CmuxNotification[]): NotificationIndex {
  const bySurface = new Map<string, CmuxNotification>();
  const byWorkspace = new Map<string, CmuxNotification>();
  for (const n of list) {
    if (!n.created_at) continue;
    if (n.surface_id) putLatest(bySurface, n.surface_id, n);
    else if (n.workspace_id) putLatest(byWorkspace, n.workspace_id, n);
  }
  return { bySurface, byWorkspace };
}

/**
 * The latest notification attributable to one specific pane: a surface match
 * first; a surfaceless notification matches by workspace only (so a sibling
 * pane's surface-tagged turn-end can never be attributed to this worker).
 */
export function notificationFor(
  idx: NotificationIndex,
  surfaceId: string | undefined,
  workspaceId: string | undefined,
): CmuxNotification | undefined {
  if (surfaceId) {
    const bySurface = idx.bySurface.get(surfaceId);
    if (bySurface) return bySurface;
  }
  return workspaceId ? idx.byWorkspace.get(workspaceId) : undefined;
}

// cmux's Claude hook fires a notification when a worker's turn ENDS — either
// "Completed in <dir>" (finished with a result) or "Waiting / Claude is waiting
// for your input" (finished, now idle at the prompt). BOTH mean the turn ended;
// neither means "blocked mid-task on a y/n dialog" — that's the screen
// heuristic's job (AWAITING). So any of these phrases = the worker is quiescent.
// (Shared with the event reactor's notification classifier in src/events.ts.)
export const TURN_END = /complete|done|finish|wait|idle|ready/i;

/**
 * True if there's a turn-end notification newer than the worker's last dispatch
 * — a deterministic "this turn is over" signal. Stale notifications from a prior
 * turn (at or before lastDispatchAt) are ignored so a re-dispatched worker isn't
 * marked done prematurely. No skew tolerance: `send()` stamps lastDispatchAt
 * BEFORE the submit, so any notification not strictly newer belongs to a
 * previous turn (S6).
 */
export function turnEnded(notif: CmuxNotification | undefined, lastDispatchAt: string): boolean {
  if (!notif || !notif.created_at) return false;
  if (Date.parse(notif.created_at) <= Date.parse(lastDispatchAt)) return false;
  return TURN_END.test(`${notif.subtitle ?? ""} ${notif.body ?? ""}`);
}
