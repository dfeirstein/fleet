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
    const result = submitToClaude(t, text);
    if (result === "not-ready") {
      // The TUI never reached its input prompt (still booting / on the splash),
      // so NOTHING was typed (issue #38). Revert-on-throw restores the dispatch
      // stamp; a blind "sent" here would lie about a steer the boot screen ate.
      throw new Error(
        `${agent.label}'s worker TUI is not ready — steer NOT sent; check with \`fleet read ${agent.agentId}\` and re-send once it is at its input prompt`,
      );
    }
    if (result === "failed") {
      // Positive observation: the text never left the input box (issue #30).
      throw new Error(
        `the steer never left ${agent.label}'s input box — it is still sitting there; inspect with \`fleet read ${agent.agentId}\`, clear the box in the pane, then re-send (a blind retry would double-paste)`,
      );
    }
    if (result === "unverified") {
      console.error(
        `⚠ could not verify the steer to ${agent.label} was submitted (screen unreadable) — ` +
          `check with: fleet read ${agent.agentId}`,
      );
    }
  } catch (e) {
    patch(agent.agentId, { lastDispatchAt: prevDispatchAt, status: prevStatus });
    throw e;
  }
}
