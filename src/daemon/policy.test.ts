// Unit tests for the blocked-worker nudge's RPC-steering surfacing (pure
// policy; no cmux). The daemon SURFACES a pending prompt + the ready-to-run
// `fleet reply` command — it never answers a prompt itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, newMemory, type AgentSignal } from "./policy.js";

function blockedSignal(over: Partial<AgentSignal> = {}): AgentSignal {
  return {
    agentId: "agent-1",
    label: "worker-a",
    status: "blocked-on-you",
    stuckMs: 0,
    ...over,
  };
}

test("evaluate: blocked nudge carries the prompt summary + exact fleet reply command", () => {
  const msg = evaluate(
    blockedSignal({
      pendingPrompt: {
        kind: "permission",
        hint: "Bash: npm run db:push",
        secondsLeft: 90,
        replyCmd: "fleet reply agent-1 allow|deny --prompt req-1",
        morePending: 0,
      },
    }),
    newMemory(),
    1_000_000,
    60_000,
    600_000,
  );
  assert.ok(msg);
  assert.equal(msg.urgent, true);
  assert.match(msg.text, /Pending permission: "Bash: npm run db:push"/);
  assert.match(msg.text, /`fleet reply agent-1 allow\|deny --prompt req-1`/);
  assert.match(msg.text, /~90s left/);
});

test("evaluate: closed reply window → nudge points at fleet send, not fleet reply", () => {
  const msg = evaluate(
    blockedSignal({
      pendingPrompt: {
        kind: "question",
        hint: "Which approach?",
        secondsLeft: 0,
        replyCmd: "fleet reply agent-1 <option #>",
        morePending: 2,
      },
    }),
    newMemory(),
    1_000_000,
    60_000,
    600_000,
  );
  assert.ok(msg);
  assert.match(msg.text, /window closed/);
  assert.match(msg.text, /fleet send agent-1/);
  assert.match(msg.text, /\+2 more pending/);
});

test("evaluate: blocked without prompt detail renders the plain nudge as before", () => {
  const msg = evaluate(blockedSignal(), newMemory(), 1_000_000, 60_000, 600_000);
  assert.ok(msg);
  assert.equal(msg.text, "worker-a is blocked on you — needs a decision.");
});
