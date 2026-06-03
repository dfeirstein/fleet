// `fleet send <agent> <text>` — steer a worker mid-flight (types text + Enter).
import { submit, sendText, sendKey } from "../cmux.js";
import { resolveAgent, target, patch } from "../registry.js";

export function send(idOrLabel: string, text: string, withEnter = true): void {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  const t = target(agent);
  if (!withEnter) {
    sendText(t, text);
    return;
  }
  submit(t, text);
  // Large inputs trip Claude Code's paste-collapse, which swallows the first
  // Enter ("paste again to expand"). A second Enter submits the collapsed block.
  if (text.length > 200) sendKey(t, "Enter");
  // Mark a fresh dispatch so completion detection waits for the NEXT "Completed"
  // notification rather than reusing the previous turn's.
  patch(agent.agentId, { lastDispatchAt: new Date().toISOString(), status: "running" });
}
