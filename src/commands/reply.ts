// `fleet reply <agent> <answer>` — answer a worker's pending Feed prompt via
// the feed.*.reply RPCs (the same code path as clicking Feed buttons), instead
// of typing keystrokes into the TUI. Validates the answer shape against the
// prompt kind, refuses ambiguity (multiple pending → --prompt <id>), and
// respects the 120s reply window — past it, the prompt has fallen back to the
// worker's in-TUI dialog and `fleet send` is the only path.
//
// The reply RPC returns {delivered:true} even for bogus/expired request_ids,
// so delivery is NOT confirmation — we re-pull feed.list and check the item
// actually left "pending".
import { feedList, feedReplyPermission, feedReplyQuestion, feedReplyExitPlan } from "../cmux.js";
import { resolveAgent, patch } from "../registry.js";
import { selectPrompt, parseAnswer, windowRemainingMs, type ReplyAction } from "../feed-steering.js";
import { assertFeedRepliesSupported, pendingPromptsFor } from "./prompts.js";

function dispatch(requestId: string, action: ReplyAction): void {
  switch (action.method) {
    case "feed.permission.reply":
      feedReplyPermission(requestId, action.mode);
      break;
    case "feed.question.reply":
      feedReplyQuestion(requestId, action.selections);
      break;
    case "feed.exit_plan.reply":
      feedReplyExitPlan(requestId, action.mode);
      break;
  }
}

export function reply(idOrLabel: string, answer: string, promptId?: string): string {
  assertFeedRepliesSupported();
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);

  const mine = pendingPromptsFor([agent]).map((r) => r.prompt);
  if (mine.length === 0) {
    throw new Error(
      `no pending prompt for ${agent.label} — if the 120s reply window passed, the prompt fell back ` +
        `to the worker's TUI: answer it with \`fleet send ${agent.agentId} ...\` or in its pane`,
    );
  }
  const sel = selectPrompt(mine, promptId);
  if (sel.error || !sel.prompt) {
    const ids = mine.map((p) => `${p.kind} ${p.requestId}`).join("\n  ");
    throw new Error(`${sel.error}\n  ${ids}`);
  }
  const prompt = sel.prompt;

  if (windowRemainingMs(prompt.createdAt, Date.now()) <= 0) {
    throw new Error(
      `the 120s reply window for this ${prompt.kind} prompt has closed — it fell back to the ` +
        `worker's TUI: answer it with \`fleet send ${agent.agentId} ...\` or in its pane`,
    );
  }

  const parsed = parseAnswer(prompt, answer);
  if (parsed.error || !parsed.action) throw new Error(parsed.error ?? "invalid answer");

  dispatch(prompt.requestId, parsed.action);

  // Answering resumes the worker's turn — same dispatch stamp as `fleet send`.
  patch(agent.agentId, { lastDispatchAt: new Date().toISOString(), status: "running" });

  // Verify the reply landed: the item must no longer be pending.
  const stillPending = feedList().some((i) => i.request_id === prompt.requestId && i.status === "pending");
  const detail =
    parsed.action.method === "feed.question.reply"
      ? parsed.action.selections.join(", ")
      : parsed.action.mode;
  if (stillPending) {
    return (
      `sent ${prompt.kind} reply (${detail}) to ${agent.label}, but the prompt still shows pending — ` +
      `check the worker's pane (\`fleet read ${agent.agentId}\`); the window may have just expired`
    );
  }
  return `answered ${agent.label}'s ${prompt.kind} prompt: ${detail}`;
}
