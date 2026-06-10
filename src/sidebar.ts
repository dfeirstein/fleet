// Sidebar state machine — mirror each worker WORKSPACE's fleet state into
// cmux's native chrome: a "fleet: <session>" sidebar group on spawn, and
// color + description synced to the classified state on every daemon beat.
//
// Sync is ON-CHANGE-ONLY: the daemon keeps a per-workspace fingerprint of the
// last paint and only re-issues workspace-action calls when it differs (no
// per-beat repaint churn). All cmux writes are best-effort and capability-
// gated: a build without workspace-action/workspace-group verbs skips the sync
// with ONE debug log and affects nothing else.
import {
  setWorkspaceColor,
  setWorkspaceDescription,
  workspaceActionsSupported,
  workspaceGroupsSupported,
  listWorkspaceGroups,
  createWorkspaceGroup,
  addWorkspaceToGroup,
  removeWorkspaceFromGroup,
  deleteWorkspaceGroup,
} from "./cmux.js";
import type { Agent } from "./registry.js";

// Default state → color (hex, matching the dashboard palette) and → label.
// Overridable per-state via daemon shared config (sidebarColors/sidebarLabels);
// overrides merge over these defaults, so a partial config keeps the rest.
export const SIDEBAR_COLORS: Record<string, string> = {
  running: "#22c55e", // green
  idle: "#9ca3af", // grey — a settled worker with proof attached
  "idle-no-proof": "#f59e0b", // amber — "done" but never cleared the gate
  "awaiting-input": "#f59e0b",
  "blocked-on-you": "#f59e0b",
  "rate-limited": "#4C8DFF", // blue — waiting out a limit, not stuck
  error: "#ef4444",
  undispatched: "#ef4444", // red — pane is up but has no work
  dead: "#ef4444",
  unknown: "#9ca3af",
};

export const SIDEBAR_LABELS: Record<string, string> = {
  running: "running",
  idle: "idle ✓",
  "idle-no-proof": "idle (no proof)",
  "awaiting-input": "needs input",
  "blocked-on-you": "blocked on you",
  "rate-limited": "rate-limited",
  error: "error",
  undispatched: "NO BRIEF",
  dead: "dead",
  unknown: "…",
};

export interface SidebarTheme {
  colors: Record<string, string>;
  labels: Record<string, string>;
}

/** Merge user overrides over the defaults (partial configs keep the rest). */
export function sidebarTheme(overrides?: { colors?: Record<string, string>; labels?: Record<string, string> }): SidebarTheme {
  return {
    colors: { ...SIDEBAR_COLORS, ...(overrides?.colors ?? {}) },
    labels: { ...SIDEBAR_LABELS, ...(overrides?.labels ?? {}) },
  };
}

/** The minimal per-worker input the paint logic needs (pure-testable). */
export interface SidebarWorker {
  status: string;
  label: string;
  task: string;
  /** Has the worker attached any proof-of-work? (drives idle vs idle-no-proof) */
  hasProof: boolean;
}

/** The sidebar paint state key for one worker: its status, with idle refined by
 *  the proof gate (grey = idle+proof✓; amber = idled without clearing it). */
export function paintState(w: Pick<SidebarWorker, "status" | "hasProof">): string {
  if (w.status === "idle" && !w.hasProof) return "idle-no-proof";
  return w.status;
}

// Worst-state-wins precedence for a SHARED workspace (grid panes / grouped
// spawns): the workspace lamp shows the member most in need of attention.
const SEVERITY = [
  "error",
  "undispatched",
  "dead",
  "blocked-on-you",
  "awaiting-input",
  "idle-no-proof",
  "rate-limited",
  "running",
  "idle",
  "unknown",
];

export interface Paint {
  color: string;
  description: string;
}

/** Compute one workspace's paint from its (1..n) workers. Pure. */
export function workspacePaint(workers: SidebarWorker[], theme: SidebarTheme): Paint {
  const states = workers.map(paintState);
  const worst = SEVERITY.find((s) => states.includes(s)) ?? states[0] ?? "unknown";
  const color = theme.colors[worst] ?? SIDEBAR_COLORS.unknown!;
  let description: string;
  if (workers.length === 1) {
    const task = workers[0]!.task.replace(/\s+/g, " ").trim();
    const lbl = theme.labels[states[0]!] ?? states[0]!;
    description = task ? `${lbl} — ${task.length > 60 ? task.slice(0, 57) + "…" : task}` : lbl;
  } else {
    // Count members per state, worst-first, e.g. "1 blocked on you · 2 running".
    const counts = new Map<string, number>();
    for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
    description = SEVERITY.filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${theme.labels[s] ?? s}`)
      .join(" · ");
  }
  return { color, description };
}

/** One sync step, pure: desired paints vs the previous fingerprints → only the
 *  CHANGED workspaces (on-change-only), plus the next fingerprint record. */
export function diffPaints(
  desired: Map<string, Paint>,
  prev: Record<string, string>,
): { changed: { workspace: string; paint: Paint }[]; next: Record<string, string> } {
  const changed: { workspace: string; paint: Paint }[] = [];
  const next: Record<string, string> = {};
  for (const [workspace, paint] of desired) {
    const fp = `${paint.color}|${paint.description}`;
    next[workspace] = fp;
    if (prev[workspace] !== fp) changed.push({ workspace, paint });
  }
  return { changed, next };
}

// One debug log per process when a mission-control verb family is missing —
// the sync/grouping silently no-ops after that (shared flag: the first warning
// already tells the operator this cmux build predates the sidebar surfaces).
let warnedUnsupported = false;

function warnUnsupported(what: string): void {
  if (warnedUnsupported) return;
  warnedUnsupported = true;
  console.error(`[sidebar] cmux build has no ${what} — sidebar state sync/grouping disabled`);
}

/**
 * Reconcile worker-workspace colors/descriptions to the current fleet state.
 * Called from the daemon beat with its per-Captain memory (`prev`); returns the
 * next fingerprints. Dead workers whose workspace vanished are skipped (their
 * group membership dies with the workspace).
 */
export function syncSidebar(agents: Agent[], theme: SidebarTheme, prev: Record<string, string>): Record<string, string> {
  if (!workspaceActionsSupported()) {
    warnUnsupported("workspace-action verbs");
    return prev;
  }
  const byWorkspace = new Map<string, SidebarWorker[]>();
  for (const a of agents) {
    if (a.status === "dead") continue;
    const ws = a.workspaceId ?? a.workspace;
    const w: SidebarWorker = { status: a.status, label: a.label, task: a.task, hasProof: (a.proofs?.length ?? 0) > 0 };
    const list = byWorkspace.get(ws);
    if (list) list.push(w);
    else byWorkspace.set(ws, [w]);
  }
  const desired = new Map<string, Paint>();
  for (const [ws, workers] of byWorkspace) desired.set(ws, workspacePaint(workers, theme));
  const { changed, next } = diffPaints(desired, prev);
  for (const { workspace, paint } of changed) {
    try {
      setWorkspaceColor(workspace, paint.color);
      setWorkspaceDescription(workspace, paint.description);
    } catch {
      // workspace mid-teardown or cmux hiccup — repainted on a later change
    }
  }
  return next;
}

// ── Fleet group membership ───────────────────────────────────────────────────

/** The sidebar group name for a fleet session. */
export function fleetGroupName(session: string): string {
  return `fleet: ${session}`;
}

/**
 * Put a (fresh) worker workspace into the session's sidebar group, creating
 * the group on first use. cmux's `create` spawns a dedicated anchor workspace
 * (the group header) which FLEET owns — so killing any worker never dissolves
 * the group. Best-effort + capability-gated; never blocks a spawn.
 */
export function ensureWorkerGrouped(session: string, workspace: string): void {
  if (!workspaceGroupsSupported()) {
    warnUnsupported("workspace-group verbs");
    return;
  }
  try {
    const name = fleetGroupName(session);
    const group = listWorkspaceGroups().find((g) => g.name === name);
    if (group) addWorkspaceToGroup(group.ref, workspace);
    else createWorkspaceGroup(name, [workspace]);
  } catch (err) {
    console.error(`[sidebar] could not group workspace ${workspace}: ${(err as Error).message}`);
  }
}

/** Drop a closing worker workspace from its group (kill cleanup). Best-effort. */
export function ungroupWorkspace(workspace: string): void {
  if (!workspaceGroupsSupported()) {
    warnUnsupported("workspace-group verbs");
    return;
  }
  try {
    removeWorkspaceFromGroup(workspace);
  } catch {
    // not grouped / already gone — fine
  }
}

/**
 * When the LAST worker of a session is killed, delete the now-empty fleet
 * group, which closes the fleet-owned anchor (the group header workspace).
 * Strictly guarded: only a group with no members beyond its anchor is deleted
 * (`workspace-group delete` closes every member — destructive otherwise).
 */
export function dropEmptyFleetGroup(session: string): void {
  if (!workspaceGroupsSupported()) {
    warnUnsupported("workspace-group verbs");
    return;
  }
  try {
    const name = fleetGroupName(session);
    const group = listWorkspaceGroups().find((g) => g.name === name);
    if (!group) return;
    const nonAnchor = group.memberRefs.filter((r) => r !== group.anchorRef);
    if (nonAnchor.length === 0) deleteWorkspaceGroup(group.ref);
  } catch {
    // best-effort — a leftover header workspace is cosmetic
  }
}
