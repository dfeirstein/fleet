// cmux sidebar dashboard — mirror fleet state onto the orchestrator workspace
// via set-status / set-progress (the "Fleet Dashboard" from the demo video).
//
// All cmux calls are best-effort: the dashboard must never break the watch loop.
import { cmux } from "./cmux.js";
import type { FleetRow } from "./commands/status.js";

const COLOR: Record<string, string> = {
  running: "#22c55e", // green
  idle: "#4C8DFF", // blue
  "awaiting-input": "#f59e0b", // amber — needs attention
  "blocked-on-you": "#f59e0b", // amber — same lane as awaiting-input
  "rate-limited": "#f59e0b",
  error: "#ef4444", // red
  dead: "#ef4444",
  unknown: "#9ca3af", // grey
};

const ICON: Record<string, string> = {
  running: "●",
  idle: "◉",
  "awaiting-input": "◍",
  "blocked-on-you": "◍",
  "rate-limited": "⏳",
  error: "✗",
  dead: "☠",
  unknown: "◌",
};

/**
 * The workspace to draw the dashboard on. Defaults to the caller's own cmux
 * workspace (correct for `fleet status`/`watch` run from the orchestrator), but
 * the daemon passes the orchestrator's workspace explicitly — its own
 * CMUX_WORKSPACE_ID is the daemon pane, not where the user is watching.
 */
function dashWorkspace(override?: string): string | undefined {
  return override ?? process.env.CMUX_WORKSPACE_ID;
}

function safe(args: string[]): void {
  try {
    cmux(args);
  } catch {
    // ignore — the dashboard is decorative
  }
}

/** Reconcile the sidebar to exactly the current fleet rows. */
export function updateSidebar(rows: FleetRow[], workspace?: string): void {
  const ws = dashWorkspace(workspace);
  if (!ws) return;

  // Clear any stale fleet:* statuses for agents that no longer exist.
  const desired = new Set(rows.map((r) => `fleet:${r.agentId}`));
  try {
    const listing = cmux(["list-status", "--workspace", ws]);
    for (const line of listing.split("\n")) {
      const key = line.split("=")[0]?.trim();
      if (key && key.startsWith("fleet:") && !desired.has(key)) {
        safe(["clear-status", key, "--workspace", ws]);
      }
    }
  } catch {
    // no existing statuses / listing failed — fine
  }

  for (const r of rows) {
    const icon = ICON[r.status] ?? "◌";
    const color = COLOR[r.status] ?? "#9ca3af";
    safe([
      "set-status",
      `fleet:${r.agentId}`,
      `${icon} ${r.label} · ${r.status}`,
      "--workspace",
      ws,
      "--color",
      color,
    ]);
  }

  if (rows.length > 0) {
    // "done" ≈ not running (idle/awaiting/error). A real completion signal is a
    // later phase; until then this tracks how much of the fleet is still active.
    const done = rows.filter((r) => r.status !== "running").length;
    safe([
      "set-progress",
      (done / rows.length).toFixed(3),
      "--label",
      `fleet ${done}/${rows.length}`,
      "--workspace",
      ws,
    ]);
  } else {
    safe(["clear-progress", "--workspace", ws]);
  }
}

/**
 * A live heartbeat line on the dashboard — visible "the daemon is watching"
 * without ever injecting a turn. Updated every beat by the daemon.
 */
export function setHeartbeat(rows: FleetRow[], workspace?: string): void {
  const ws = dashWorkspace(workspace);
  if (!ws) return;
  const running = rows.filter((r) => r.status === "running").length;
  const idle = rows.filter((r) => r.status === "idle").length;
  const beat = new Date().toISOString().slice(11, 19);
  safe([
    "set-status",
    "fleet:daemon",
    `💓 fleet · ${running}r ${idle}i · beat ${beat}`,
    "--workspace",
    ws,
    "--color",
    "#a78bfa",
    "--priority",
    "100",
  ]);
}

/** Remove all fleet sidebar entries (call when the fleet is torn down). */
export function clearDashboard(workspace?: string): void {
  const ws = dashWorkspace(workspace);
  if (!ws) return;
  try {
    const listing = cmux(["list-status", "--workspace", ws]);
    for (const line of listing.split("\n")) {
      const key = line.split("=")[0]?.trim();
      if (key && key.startsWith("fleet:")) safe(["clear-status", key, "--workspace", ws]);
    }
  } catch {
    // nothing to clear
  }
  safe(["clear-progress", "--workspace", ws]);
}
