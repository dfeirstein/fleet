// `fleet orchestrate [name]` — declare a cmux workspace as THE orchestrator
// (the control plane). The orchestrator is a ROLE pinned to a workspace, not a
// directory: it can sit in its own workspace and delegate into any project.
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newWorkspace, cmux } from "../cmux.js";

export interface OrchestratorRecord {
  name: string;
  session: string;
  workspaceId: string;
  surfaceId: string;
  workspaceRef: string;
  declaredAt: string;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

export function orchestratorPath(): string {
  return join(fleetDir(), "orchestrator.json");
}

export function loadOrchestrator(): OrchestratorRecord | undefined {
  if (!existsSync(orchestratorPath())) return undefined;
  try {
    return JSON.parse(readFileSync(orchestratorPath(), "utf8")) as OrchestratorRecord;
  } catch {
    return undefined;
  }
}

export function orchestrate(name: string): OrchestratorRecord {
  mkdirSync(fleetDir(), { recursive: true });
  const session = slug(name);

  // Singleton: note (and re-point) if one already exists.
  const prev = loadOrchestrator();
  if (prev) {
    console.log(`note: re-pointing orchestrator (was "${prev.name}" in ${prev.workspaceRef}).`);
  }

  // Compose the per-orchestrator system prompt: identity line + base doctrine.
  const baseDoctrine = readFileSync(
    fileURLToPath(new URL("../../skills/fleet/orchestrator-doctrine.md", import.meta.url)),
    "utf8",
  );
  const promptPath = join(fleetDir(), `orchestrator-prompt-${session}.md`);
  writeFileSync(
    promptPath,
    `You are "${name}", the user's Fleet Orchestrator for this cmux environment. ` +
      `Your fleet runs under session "${session}".\n\n${baseDoctrine}`,
  );

  // Launch an interactive Claude orchestrator in a new, focused, badged workspace.
  // FLEET_SESSION pins this orchestrator's fleet to its own named registry, so
  // its workers are isolated from other sessions regardless of cwd.
  const command = `FLEET_SESSION=${session} claude --append-system-prompt-file '${promptPath}'`;
  const ws = newWorkspace({ name: `🎛 ${name}`, cwd: homedir(), command, focus: true });

  const record: OrchestratorRecord = {
    name,
    session,
    workspaceId: ws.workspaceId,
    surfaceId: ws.surfaceId,
    workspaceRef: ws.workspaceRef,
    declaredAt: new Date().toISOString(),
  };
  writeFileSync(orchestratorPath(), JSON.stringify(record, null, 2));

  // Badge the workspace so it's visibly the control plane in the sidebar.
  try {
    cmux([
      "set-status",
      "fleet:role",
      `🎛 ORCHESTRATOR · ${name}`,
      "--workspace",
      ws.workspaceId,
      "--color",
      "#a78bfa",
      "--priority",
      "200",
    ]);
  } catch {
    // badge is decorative
  }

  return record;
}
