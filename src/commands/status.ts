// `fleet status` — the Fleet Dashboard. Merges the registry with a live cmux
// read so the orchestrator sees real state, not just what it last recorded.
import { listAgents, patch, handle, target, type Agent } from "../registry.js";
import { workspaceExists } from "../cmux.js";
import { probeStatus } from "../status.js";
import { listNotifications, latestByWorkspace, turnEnded } from "../notifications.js";
import { pendingBlocks, type PendingBlock } from "../events.js";

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

export interface FleetRow {
  agentId: string;
  label: string;
  workspace: string;
  surface: string;
  model: string;
  status: string;
  task: string;
}

/** Reconcile + classify every agent. Updates the registry as a side effect.
 *  Completion is taken from cmux's notification feed when available (a
 *  deterministic "turn finished" signal), falling back to the screen heuristic. */
export function snapshot(): FleetRow[] {
  const rows: FleetRow[] = [];
  const notifs = latestByWorkspace(listNotifications());
  // The event-sourced blocked-on-you lane: feed pending question/permission/plan
  // items, attributed to a worker by cwd (the one-shot reconcile has no session
  // map). Empty/unsupported cmux → [] → the screen heuristic's awaiting-input
  // remains the fallback for the same lane (decision #2).
  const blocks = pendingBlocks();
  for (const a of listAgents()) {
    let status: string = a.status;
    if (!workspaceExists(handle(a))) {
      status = "dead";
    } else {
      // Precedence: a screen rate-limit/error wins (no clean event exists); else
      // a feed-confirmed block → blocked-on-you; else a screen y/n dialog →
      // awaiting-input; else a fresh turn-end notification → idle; else screen.
      const probe = probeStatus(target(a)).status;
      const wsId = a.workspaceId ?? a.workspace;
      const screenAttention = probe === "rate-limited" || probe === "error";
      if (screenAttention) status = probe;
      else if (agentHasBlock(a, blocks)) status = "blocked-on-you";
      else if (probe === "awaiting-input") status = "awaiting-input";
      else if (turnEnded(notifs.get(wsId), a.lastDispatchAt)) status = "idle";
      else status = probe;
    }
    patch(a.agentId, { status: status as never, lastSeen: new Date().toISOString() });
    rows.push({
      agentId: a.agentId,
      label: a.label,
      workspace: a.workspace,
      surface: a.surface,
      model: a.model,
      status,
      task: a.task,
    });
  }
  return rows;
}

/** A pending feed block belongs to a worker if its cwd matches the worker's
 *  cwd or its worktree path (feed items carry the claude session's cwd). */
function agentHasBlock(a: Agent, blocks: PendingBlock[]): boolean {
  return blocks.some((b) => !!b.cwd && (b.cwd === a.cwd || b.cwd === a.worktree?.path));
}

export function renderTable(rows: FleetRow[]): string {
  if (rows.length === 0) return "No agents in the fleet. Spawn one with `fleet spawn`.";
  const lines = rows.map((r) => {
    const icon = ICON[r.status] ?? "◌";
    const id = r.agentId.padEnd(8);
    const label = r.label.padEnd(16).slice(0, 16);
    const ws = r.workspace.padEnd(12);
    const model = r.model.padEnd(7);
    const st = r.status.padEnd(14);
    const task = r.task.length > 50 ? r.task.slice(0, 47) + "..." : r.task;
    return `${icon} ${id} ${label} ${ws} ${model} ${st} ${task}`;
  });
  const active = rows.filter((r) => r.status === "running").length;
  const header = `  ${"id".padEnd(8)} ${"label".padEnd(16)} ${"workspace".padEnd(12)} ${"model".padEnd(7)} ${"status".padEnd(14)} task`;
  return [header, ...lines, "", `${rows.length} agents · ${active} active`].join("\n");
}
