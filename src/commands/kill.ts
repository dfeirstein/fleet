// `fleet kill <agent|--all>` — stop a worker and clean up its cmux surface.
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { sendKey, closeWorkspace, closeSurface, workspaceExists } from "../cmux.js";
import { listAgents, resolveAgent, remove, handle, target, type Agent } from "../registry.js";
import { hasChanges, commitAll, removeWorktree } from "../git.js";
import { appendOutcome } from "../outcomes.js";

/** Branches left behind by killed worktree workers, for the caller to report. */
export const reviewBranches: string[] = [];

/** True iff `dir` is `root` or nested inside it (pure; exported for tests). */
export function isInside(dir: string, root: string): boolean {
  const d = resolve(dir);
  const r = resolve(root);
  return d === r || d.startsWith(r + sep);
}

function callerInside(worktreePath: string): boolean {
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    // cwd already deleted — nothing sensible to compare
  }
  return [cwd, process.env.PWD].some((d) => d !== undefined && isInside(d, worktreePath));
}

function sharesWorkspace(a: Agent, b: Agent): boolean {
  return (a.workspaceId ?? a.workspace) === (b.workspaceId ?? b.workspace);
}

function killOne(agent: Agent): void {
  const h = handle(agent);
  if (workspaceExists(h)) {
    // Interrupt whatever the worker is doing first.
    try {
      sendKey(target(agent), "ctrl+c");
    } catch {
      // terminal may already be gone
    }
    if (agent.ownsWorkspace) {
      closeWorkspace(h);
    } else {
      // Shared (grid) member. If others remain, close just this pane; if this is
      // the last member, close the whole workspace (cmux refuses to close the
      // last surface, so don't try).
      const others = listAgents().filter((a) => a.agentId !== agent.agentId && sharesWorkspace(a, agent));
      if (others.length === 0) {
        try {
          closeWorkspace(h);
        } catch {
          // best-effort
        }
      } else {
        try {
          closeSurface(target(agent));
        } catch {
          // surface may already be gone
        }
      }
    }
  }
  // Worktree workers: capture any uncommitted work to the branch (so nothing is
  // lost), remove the worktree, and leave the BRANCH for review.
  if (agent.worktree) {
    const { repo, path, branch } = agent.worktree;
    if (!existsSync(path)) {
      // Tree already gone — nothing to preserve (hasChanges fails closed and
      // would read a missing tree as dirty); just prune the registration.
      removeWorktree(repo, path);
    } else {
      if (hasChanges(path)) commitAll(path, `fleet WIP: ${agent.label}`);
      if (hasChanges(path)) {
        // The WIP commit failed (hook, identity unset, index lock) — a --force
        // removal here would destroy the very work the commit was meant to save.
        console.error(
          `warning: uncommitted changes in ${path} could not be committed — worktree preserved; ` +
            `commit them manually, then \`git -C ${repo} worktree remove ${path}\``,
        );
      } else {
        if (callerInside(path)) {
          console.error(`warning: your current directory is inside ${path}, which is being removed — cd out to avoid getcwd errors`);
        }
        removeWorktree(repo, path);
      }
    }
    reviewBranches.push(branch);
  }
  // Trajectory store: record final disposition (Move 1). Best-effort.
  appendOutcome({
    event: "kill",
    agentId: agent.agentId,
    label: agent.label,
    status: agent.status,
    cwd: agent.cwd,
    worktreeBranch: agent.worktree?.branch,
  });
  remove(agent.agentId);
}

export function kill(idOrLabel: string): Agent {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  killOne(agent);
  return agent;
}

export function killAll(): number {
  const agents = listAgents();
  for (const a of agents) killOne(a);
  return agents.length;
}
