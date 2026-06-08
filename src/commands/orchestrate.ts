// `fleet orchestrate [name]` — declare a cmux workspace as THE orchestrator
// (the control plane). The orchestrator is a ROLE pinned to a workspace, not a
// directory: it can sit in its own workspace and delegate into any project.
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newWorkspace, closeWorkspace, cmux } from "../cmux.js";
import { loadOrchestrator, orchestratorPath, type OrchestratorRecord } from "../orchestrator-record.js";
import { daemonStart, daemonStop } from "./daemon.js";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

export function orchestrate(name: string, opts: { daemon?: boolean; resume?: boolean } = {}): OrchestratorRecord {
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
    `You are "${name}", the Fleet Captain — the orchestrator of this cmux fleet. ` +
      `Your fleet runs under session "${session}".\n\n${baseDoctrine}`,
  );

  // Launch the interactive Captain (a Claude session) in a new focused, badged
  // workspace. FLEET_SESSION pins the fleet to its own named registry, so its
  // workers are isolated from other sessions regardless of cwd.
  //
  // --resume re-appoints an EXISTING Captain without losing her context: `claude
  // --continue` resumes the most recent conversation in this cwd (homedir) and
  // re-applies the (possibly updated) doctrine system prompt on top of it. Use it
  // to adopt new doctrine mid-life; the prior workspace should be closed after.
  const cont = opts.resume ? "--continue " : "";
  const command = `FLEET_SESSION=${session} claude ${cont}--append-system-prompt-file '${promptPath}'`;

  // When resuming, close the previous Captain workspace FIRST so its process
  // releases the conversation file — `claude --continue` must be the only process
  // on that session, or the shared history file can corrupt.
  if (opts.resume && prev?.workspaceId) {
    try {
      closeWorkspace(prev.workspaceId);
    } catch {
      // already gone — fine
    }
  }

  const ws = newWorkspace({ name: `⚓ ${name}`, cwd: homedir(), command, focus: true });

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
      `⚓ FLEET CAPTAIN · ${name}`,
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

  // Auto-start the supervisor, bound to THIS orchestrator (its session + target),
  // so completion feedback flows back without a separate step. This is what was
  // missing: a daemon not bound to the orchestrator's session sees 0 agents.
  if (opts.daemon !== false) {
    try {
      daemonStop(); // clear any stale/other-session daemon first
      daemonStart();
    } catch (e) {
      console.error(`note: could not auto-start daemon: ${(e as Error).message}`);
    }
  }

  return record;
}
