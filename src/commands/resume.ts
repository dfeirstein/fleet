// `fleet resume` — reconcile the registry against live cmux after an
// orchestrator restart. Refresh stale display refs from stable UUIDs, drop
// workers whose workspace is gone, and re-classify the survivors. Also the
// daemon's boot step.
import { listAgents, patch, remove } from "../registry.js";
import { cmuxJson } from "../cmux.js";
import { snapshot, type FleetRow } from "./status.js";

interface WorkspaceList {
  workspaces?: { id?: string; ref?: string }[];
}

/** Refresh each agent's workspace ref from its UUID (refs renumber over time). */
function refreshRefs(): void {
  let refByUuid = new Map<string, string>();
  try {
    const { workspaces } = cmuxJson<WorkspaceList>(["rpc", "workspace.list"]);
    for (const w of workspaces ?? []) {
      if (w.id && w.ref) refByUuid.set(w.id, w.ref);
    }
  } catch {
    return; // can't reach cmux; leave refs as-is
  }
  for (const a of listAgents()) {
    const ref = a.workspaceId ? refByUuid.get(a.workspaceId) : undefined;
    if (ref && ref !== a.workspace) patch(a.agentId, { workspace: ref });
  }
}

export function resume(): { rows: FleetRow[]; pruned: string[] } {
  refreshRefs();
  const rows = snapshot(); // classifies; marks vanished workers "dead"
  const pruned: string[] = [];
  for (const r of rows) {
    if (r.status === "dead") {
      remove(r.agentId);
      pruned.push(r.label);
    }
  }
  return { rows: rows.filter((r) => r.status !== "dead"), pruned };
}
