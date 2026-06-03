// The declared orchestrator — a role pinned to a cmux workspace. Shared by the
// registry (to bind session), the daemon (to target + namespace), and the
// orchestrate command (to write it). Kept dependency-free to avoid cycles.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OrchestratorRecord {
  name: string;
  session: string;
  workspaceId: string;
  surfaceId: string;
  workspaceRef: string;
  declaredAt: string;
}

export function orchestratorPath(): string {
  return join(homedir(), ".fleet", "orchestrator.json");
}

export function loadOrchestrator(): OrchestratorRecord | undefined {
  if (!existsSync(orchestratorPath())) return undefined;
  try {
    return JSON.parse(readFileSync(orchestratorPath(), "utf8")) as OrchestratorRecord;
  } catch {
    return undefined;
  }
}
