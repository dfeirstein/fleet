// `fleet kill <agent|--all>` — stop a worker and clean up its cmux surface.
import { sendKey, closeWorkspace, closeSurface, workspaceExists } from "../cmux.js";
import { listAgents, resolveAgent, remove, handle, target, type Agent } from "../registry.js";
import { hasChanges, commitAll, removeWorktree } from "../git.js";
import { appendOutcome } from "../outcomes.js";

/** Branches left behind by killed worktree workers, for the caller to report. */
export const reviewBranches: string[] = [];

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
    if (hasChanges(path)) commitAll(path, `fleet WIP: ${agent.label}`);
    removeWorktree(repo, path);
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
