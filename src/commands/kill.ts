// `fleet kill <agent|--all>` — stop a worker and clean up its cmux workspace.
import { sendKey, closeWorkspace, workspaceExists } from "../cmux.js";
import { listAgents, resolveAgent, remove, handle, target, type Agent } from "../registry.js";

function killOne(agent: Agent): void {
  const h = handle(agent);
  if (workspaceExists(h)) {
    // Interrupt whatever the worker is doing first, then close its workspace.
    try {
      sendKey(target(agent), "ctrl+c");
    } catch {
      // terminal may already be gone; fall through to close
    }
    if (agent.ownsWorkspace) closeWorkspace(h);
  }
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
