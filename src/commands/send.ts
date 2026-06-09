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
  // Mark the dispatch BEFORE the submit: submitToClaude takes ~0.5–3.2s, and
  // during that window the previous turn's "Completed" notification must
  // already read as stale or the worker classifies idle mid-send (B1). A failed
  // submit reverts; a premature idle cannot be taken back.
  const prevDispatchAt = agent.lastDispatchAt;
  const prevStatus = agent.status;
  patch(agent.agentId, { lastDispatchAt: new Date().toISOString(), status: "running" });
  try {
    // Reliable submit into the worker's Claude TUI (handles paste-collapse).
    submitToClaude(t, text);
  } catch (e) {
    patch(agent.agentId, { lastDispatchAt: prevDispatchAt, status: prevStatus });
    throw e;
  }
}
