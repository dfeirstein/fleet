// Fleet registry: the orchestrator's source of truth for which agents exist,
// where they live in cmux, and what they're working on.
//
// Stored at ~/.fleet/<session>.json. Writes are atomic (tmp file + rename) so a
// crash mid-write can't corrupt the registry. Full O_EXCL locking for multiple
// concurrent orchestrators is a later-phase concern (see plan).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export type AgentStatus = "running" | "idle" | "awaiting-input" | "error" | "rate-limited" | "unknown" | "dead";

export interface Agent {
  agentId: string;
  label: string;
  workspace: string; // cmux workspace ref, e.g. "workspace:4"
  surface: string; // cmux surface ref, e.g. "surface:5"
  workspaceId?: string; // UUID, stable across ref renumbering
  surfaceId?: string;
  cwd: string;
  model: string;
  task: string;
  /** Whether spawn created its own workspace (closeable) or split an existing one. */
  ownsWorkspace: boolean;
  status: AgentStatus;
  spawnedAt: string; // ISO timestamp
  lastSeen?: string;
}

interface RegistryFile {
  session: string;
  agents: Record<string, Agent>;
}

function sessionId(): string {
  return process.env.FLEET_SESSION || "default";
}

function registryDir(): string {
  return join(homedir(), ".fleet");
}

function registryPath(): string {
  return join(registryDir(), `${sessionId()}.json`);
}

export function load(): RegistryFile {
  const path = registryPath();
  if (!existsSync(path)) {
    return { session: sessionId(), agents: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
  } catch {
    // Corrupt/partial file — start fresh rather than crash the orchestrator.
    return { session: sessionId(), agents: {} };
  }
}

function save(reg: RegistryFile): void {
  mkdirSync(registryDir(), { recursive: true });
  const path = registryPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, path);
}

/** The durable cmux handle for a worker: prefer the stable UUID over the ref. */
export function handle(agent: Agent): string {
  return agent.workspaceId ?? agent.workspace;
}

export function listAgents(): Agent[] {
  return Object.values(load().agents).sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt));
}

export function getAgent(agentId: string): Agent | undefined {
  return load().agents[agentId];
}

/** Look up by exact id, or unambiguous prefix, or label. */
export function resolveAgent(idOrLabel: string): Agent | undefined {
  const agents = listAgents();
  const exact = agents.find((a) => a.agentId === idOrLabel);
  if (exact) return exact;
  const byPrefix = agents.filter((a) => a.agentId.startsWith(idOrLabel));
  if (byPrefix.length === 1) return byPrefix[0];
  const byLabel = agents.filter((a) => a.label === idOrLabel);
  if (byLabel.length === 1) return byLabel[0];
  return undefined;
}

export function upsert(agent: Agent): void {
  const reg = load();
  reg.agents[agent.agentId] = agent;
  save(reg);
}

export function patch(agentId: string, fields: Partial<Agent>): void {
  const reg = load();
  const existing = reg.agents[agentId];
  if (!existing) return;
  reg.agents[agentId] = { ...existing, ...fields, agentId };
  save(reg);
}

export function remove(agentId: string): void {
  const reg = load();
  delete reg.agents[agentId];
  save(reg);
}
