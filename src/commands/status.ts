// `fleet status` — the Fleet Dashboard. Merges the registry with a live cmux
// read so the orchestrator sees real state, not just what it last recorded.
import { listAgents, patch, handle, target } from "../registry.js";
import { workspaceExists } from "../cmux.js";
import { probeStatus } from "../status.js";

const ICON: Record<string, string> = {
  running: "●",
  idle: "◉",
  "awaiting-input": "◍",
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

/** Reconcile + classify every agent. Updates the registry as a side effect. */
export function snapshot(): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const a of listAgents()) {
    let status: string = a.status;
    if (!workspaceExists(handle(a))) {
      status = "dead";
    } else {
      status = probeStatus(target(a)).status;
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
