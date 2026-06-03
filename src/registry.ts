// Fleet registry: the orchestrator's source of truth for which agents exist,
// where they live in cmux, and what they're working on.
//
// Stored at ~/.fleet/<session>.json. Writes are atomic (tmp file + rename) so a
// crash mid-write can't corrupt the registry. Full O_EXCL locking for multiple
// concurrent orchestrators is a later-phase concern (see plan).
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  mode: "auto" | "gated" | "yolo";
  task: string;
  /** Whether spawn created its own workspace (closeable) or split an existing one. */
  ownsWorkspace: boolean;
  /** Set when the worker runs in an isolated git worktree. */
  worktree?: { path: string; branch: string; base: string; repo: string };
  status: AgentStatus;
  spawnedAt: string; // ISO timestamp
  /** When the worker was last given work (spawn or send) — used to tell whether
   *  a "Completed" notification belongs to the current turn. */
  lastDispatchAt: string;
  lastSeen?: string;
}

interface RegistryFile {
  session: string;
  agents: Record<string, Agent>;
}

/**
 * The fleet session — one registry per project so orchestrators in different
 * repos don't see each other's workers. Explicit FLEET_SESSION wins; otherwise
 * derive a stable id from the project root (git toplevel, else cwd): a readable
 * basename plus a short path hash to avoid collisions between same-named dirs.
 */
function sessionId(): string {
  if (process.env.FLEET_SESSION) return process.env.FLEET_SESSION;
  const root = projectRoot();
  const slug = basename(root).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function projectRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
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

/**
 * The addressing target for read/send: workspace + the worker's TERMINAL
 * surface. Both are needed so ops still hit the terminal after browser
 * surfaces are added to the workspace. UUIDs preferred (stable across renumber).
 */
export function target(agent: Agent): { workspace: string; surface?: string } {
  return {
    workspace: agent.workspaceId ?? agent.workspace,
    surface: agent.surfaceId ?? agent.surface,
  };
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
