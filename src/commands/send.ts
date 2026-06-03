// `fleet send <agent> <text>` — steer a worker mid-flight (types text + Enter).
import { submitToClaude, sendText } from "../cmux.js";
import { resolveAgent, target, patch } from "../registry.js";

export function send(idOrLabel: string, text: string, withEnter = true): void {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  const t = target(agent);
  if (!withEnter) {
    sendText(t, text);
    return;
  }
  // Reliable submit into the worker's Claude TUI (handles paste-collapse).
  submitToClaude(t, text);
  // Mark a fresh dispatch so completion detection waits for the NEXT "Completed"
  // notification rather than reusing the previous turn's.
  patch(agent.agentId, { lastDispatchAt: new Date().toISOString(), status: "running" });
}
