// Unit tests for the RPC-steering pure logic (`fleet prompts` / `fleet reply`).
// Run with `npm test` (node:test via tsx). Fixtures mirror real feed.list item
// shapes captured against cmux 0.64.12 (92) on 2026-06-09.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toPendingPrompt,
  windowRemainingMs,
  oldestFirst,
  selectPrompt,
  parseAnswer,
  replyCommandHint,
  REPLY_WINDOW_MS,
  type PendingPrompt,
} from "./feed-steering.js";
import type { FeedPromptItem } from "./cmux.js";

const T0 = Date.parse("2026-06-09T12:00:00Z");

function pendingItem(over: Partial<FeedPromptItem> = {}): FeedPromptItem {
  return {
    id: "ITEM-1",
    kind: "permission",
    status: "pending",
    cwd: "/work/a",
    workstream_id: "claude-abc",
    request_id: "req-1",
    created_at: "2026-06-09T12:00:00Z",
    title: "Bash",
    tool_name: "Bash",
    tool_input: '{"command":"rm -rf node_modules"}',
    ...over,
  };
}

function prompt(over: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    requestId: "req-1",
    kind: "permission",
    createdAt: "2026-06-09T12:00:00Z",
    prompt: "Bash: rm -rf node_modules",
    options: [],
    multiQuestion: false,
    ...over,
  };
}

// ── toPendingPrompt ──────────────────────────────────────────────────────────

test("toPendingPrompt: pending permission item → permission prompt with tool text", () => {
  const p = toPendingPrompt(pendingItem());
  assert.ok(p);
  assert.equal(p.kind, "permission");
  assert.equal(p.requestId, "req-1");
  assert.match(p.prompt, /^Bash: /);
});

test("toPendingPrompt: telemetry / resolved / expired items → undefined", () => {
  assert.equal(toPendingPrompt(pendingItem({ status: "telemetry" })), undefined);
  assert.equal(toPendingPrompt(pendingItem({ status: "resolved" })), undefined);
  assert.equal(toPendingPrompt(pendingItem({ status: "expired" })), undefined);
});

test("toPendingPrompt: non-prompt kinds and missing request_id → undefined", () => {
  assert.equal(toPendingPrompt(pendingItem({ kind: "toolUse" })), undefined);
  assert.equal(toPendingPrompt(pendingItem({ kind: "stop" })), undefined);
  assert.equal(toPendingPrompt(pendingItem({ request_id: undefined })), undefined);
});

test("toPendingPrompt: exitPlan/exit_plan/plan all normalize to plan", () => {
  for (const kind of ["exitPlan", "exit_plan", "plan"]) {
    assert.equal(toPendingPrompt(pendingItem({ kind }))?.kind, "plan");
  }
});

test("toPendingPrompt: question item carries prompt text and labeled options", () => {
  const p = toPendingPrompt(
    pendingItem({
      kind: "question",
      question_prompt: "Which approach?",
      question_options: [
        { id: "opt0", label: "Hide from admins", description: "403 for plain admins" },
        { id: "opt1", label: "Read-only" },
        { id: "broken" }, // label-less options are dropped, not rendered blank
      ],
      questions: [{}],
    }),
  );
  assert.ok(p);
  assert.equal(p.prompt, "Which approach?");
  assert.deepEqual(p.options.map((o) => o.label), ["Hide from admins", "Read-only"]);
  assert.equal(p.multiQuestion, false);
});

test("toPendingPrompt: >1 questions in one item → multiQuestion", () => {
  const p = toPendingPrompt(pendingItem({ kind: "question", question_prompt: "q", questions: [{}, {}] }));
  assert.equal(p?.multiQuestion, true);
});

// ── windowRemainingMs (the 120s footgun) ─────────────────────────────────────

test("windowRemainingMs: fresh prompt → full window", () => {
  assert.equal(windowRemainingMs("2026-06-09T12:00:00Z", T0), REPLY_WINDOW_MS);
});

test("windowRemainingMs: 119s old → 1s left; 121s old → negative", () => {
  assert.equal(windowRemainingMs("2026-06-09T12:00:00Z", T0 + 119_000), 1_000);
  assert.ok(windowRemainingMs("2026-06-09T12:00:00Z", T0 + 121_000) < 0);
});

test("windowRemainingMs: missing/garbage created_at → expired (fail closed)", () => {
  assert.equal(windowRemainingMs(undefined, T0), 0);
  assert.equal(windowRemainingMs("not-a-date", T0), 0);
});

// ── prompt selection ─────────────────────────────────────────────────────────

test("oldestFirst: sorts by created_at, missing dates last", () => {
  const sorted = oldestFirst([
    prompt({ requestId: "b", createdAt: "2026-06-09T12:05:00Z" }),
    prompt({ requestId: "c", createdAt: undefined }),
    prompt({ requestId: "a", createdAt: "2026-06-09T12:01:00Z" }),
  ]);
  assert.deepEqual(sorted.map((p) => p.requestId), ["a", "b", "c"]);
});

test("selectPrompt: exactly one pending → selected", () => {
  const { prompt: p, error } = selectPrompt([prompt()]);
  assert.equal(error, undefined);
  assert.equal(p?.requestId, "req-1");
});

test("selectPrompt: multiple pending without --prompt → refused as ambiguous", () => {
  const { prompt: p, error } = selectPrompt([prompt(), prompt({ requestId: "req-2" })]);
  assert.equal(p, undefined);
  assert.match(error ?? "", /--prompt/);
});

test("selectPrompt: --prompt unique id prefix → selected; ambiguous/missing → error", () => {
  const list = [prompt({ requestId: "req-aaa" }), prompt({ requestId: "req-abb" })];
  assert.equal(selectPrompt(list, "req-aa").prompt?.requestId, "req-aaa");
  assert.match(selectPrompt(list, "req-a").error ?? "", /matches 2/);
  assert.match(selectPrompt(list, "nope").error ?? "", /no pending prompt/);
  assert.match(selectPrompt([], undefined).error ?? "", /no pending/);
});

// ── answer validation per prompt kind ────────────────────────────────────────

test("parseAnswer permission: allow→once, deny/always/all/bypass map through", () => {
  const p = prompt();
  for (const [answer, mode] of [
    ["allow", "once"],
    ["deny", "deny"],
    ["always", "always"],
    ["all", "all"],
    ["bypass", "bypass"],
    ["ALLOW", "once"],
  ] as const) {
    const { action, error } = parseAnswer(p, answer);
    assert.equal(error, undefined);
    assert.deepEqual(action, { method: "feed.permission.reply", mode });
  }
});

test("parseAnswer permission: option index / garbage → shape error", () => {
  assert.match(parseAnswer(prompt(), "1").error ?? "", /permission prompt takes/);
  assert.match(parseAnswer(prompt(), "approve").error ?? "", /permission prompt takes/);
  assert.match(parseAnswer(prompt(), "  ").error ?? "", /empty/);
});

const QUESTION = prompt({
  kind: "question",
  prompt: "Which approach?",
  options: [{ label: "Hide from admins" }, { label: "Read-only" }],
});

test("parseAnswer question: option index → that option's LABEL as the selection", () => {
  assert.deepEqual(parseAnswer(QUESTION, "1").action, {
    method: "feed.question.reply",
    selections: ["Read-only"],
  });
});

test("parseAnswer question: out-of-range index → error", () => {
  assert.match(parseAnswer(QUESTION, "2").error ?? "", /out of range/);
});

test("parseAnswer question: text snaps to a matching label, else passes through", () => {
  assert.deepEqual(parseAnswer(QUESTION, "read-only").action, {
    method: "feed.question.reply",
    selections: ["Read-only"],
  });
  assert.deepEqual(parseAnswer(QUESTION, "ship it as-is").action, {
    method: "feed.question.reply",
    selections: ["ship it as-is"],
  });
});

test("parseAnswer question: multi-question items are refused", () => {
  const p = prompt({ kind: "question", multiQuestion: true, options: [{ label: "A" }] });
  assert.match(parseAnswer(p, "0").error ?? "", /multi-question/);
});

test("parseAnswer question: with zero options a bare number is a text answer, not an index", () => {
  const p = prompt({ kind: "question", options: [] });
  assert.deepEqual(parseAnswer(p, "2").action, { method: "feed.question.reply", selections: ["2"] });
});

test("parseAnswer plan: approve→manual (conservative), auto→autoAccept, reject→deny", () => {
  const p = prompt({ kind: "plan" });
  for (const [answer, mode] of [
    ["approve", "manual"],
    ["manual", "manual"],
    ["auto", "autoAccept"],
    ["ultraplan", "ultraplan"],
    ["reject", "deny"],
    ["deny", "deny"],
  ] as const) {
    assert.deepEqual(parseAnswer(p, answer).action, { method: "feed.exit_plan.reply", mode });
  }
  assert.match(parseAnswer(p, "allow").error ?? "", /plan prompt takes/);
});

test("replyCommandHint: per-kind ready-to-run command, always pinned to the request id", () => {
  assert.equal(
    replyCommandHint("permission", "agent-1", "req-1"),
    "fleet reply agent-1 allow|deny --prompt req-1",
  );
  assert.match(replyCommandHint("question", "agent-1", "req-1"), /option #.* --prompt req-1$/);
  assert.match(replyCommandHint("plan", "agent-1", "req-1"), /approve\|reject --prompt req-1$/);
});
