// Unit tests for the `fleet spawn --done` decision core (pure rules): when the
// daemon runs the check, how the loop bounds re-dispatch vs exhaustion, and the
// feed-forward / escalation text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRunDoneCheck,
  doneLoopOutcome,
  redispatchPrompt,
  exhaustedMessage,
  distillFailure,
  shouldWake,
  type DoneCheckGate,
} from "./done-loop.js";

function gate(over: Partial<DoneCheckGate> = {}): DoneCheckGate {
  return {
    hasCheck: true,
    status: "idle",
    exhausted: false,
    sawActive: true,
    graceElapsed: false,
    alreadyChecked: false,
    ...over,
  };
}

test("runs the check on a worker that went idle after being seen active", () => {
  assert.equal(shouldRunDoneCheck(gate()), true);
});

test("no --done check → never runs", () => {
  assert.equal(shouldRunDoneCheck(gate({ hasCheck: false })), false);
});

test("only runs on idle — never on running/blocked/awaiting/error/dead", () => {
  for (const status of ["running", "blocked-on-you", "awaiting-input", "error", "dead", "unknown", "rate-limited"]) {
    assert.equal(shouldRunDoneCheck(gate({ status })), false, `status=${status} must not run`);
  }
});

test("exhausted loop never runs again", () => {
  assert.equal(shouldRunDoneCheck(gate({ exhausted: true })), false);
});

test("already checked this turn → does not re-run (dedup by dispatch)", () => {
  assert.equal(shouldRunDoneCheck(gate({ alreadyChecked: true })), false);
});

// Stall-prevention contract for the daemon's redispatch catch path: a failed
// send() leaves the worker idle with lastDispatchAt UNADVANCED, so the only way
// the next beat can retry (rather than stall with both safety nets off — the
// done-no-proof nudge is suppressed for --done workers) is to clear the
// alreadyChecked flag. With it cleared, the same still-idle worker is runnable
// again; left set, it is permanently skipped.
test("failed re-dispatch must reset alreadyChecked or the loop stalls forever", () => {
  const afterFailedSend = gate({ alreadyChecked: false }); // catch sets st.checked = false
  assert.equal(shouldRunDoneCheck(afterFailedSend), true, "reset → next beat retries");
  const ifNotReset = gate({ alreadyChecked: true }); // the bug: flag left true
  assert.equal(shouldRunDoneCheck(ifNotReset), false, "not reset → stalls (the failure mode)");
});

test("idle but never seen active and grace not elapsed → wait (startup blip guard)", () => {
  assert.equal(shouldRunDoneCheck(gate({ sawActive: false, graceElapsed: false })), false);
});

test("idle, never seen active, but grace elapsed → runs (adopted already-idle worker)", () => {
  assert.equal(shouldRunDoneCheck(gate({ sawActive: false, graceElapsed: true })), true);
});

test("pass → done regardless of loop count", () => {
  assert.equal(doneLoopOutcome(true, 0, 3), "pass");
  assert.equal(doneLoopOutcome(true, 99, 3), "pass");
});

test("fail under budget → re-dispatch; at/over budget → exhausted", () => {
  assert.equal(doneLoopOutcome(false, 0, 3), "redispatch");
  assert.equal(doneLoopOutcome(false, 1, 3), "redispatch");
  assert.equal(doneLoopOutcome(false, 2, 3), "redispatch");
  assert.equal(doneLoopOutcome(false, 3, 3), "exhausted");
  assert.equal(doneLoopOutcome(false, 4, 3), "exhausted");
});

test("--max 0 → exhausts immediately on first failure (no re-dispatch)", () => {
  assert.equal(doneLoopOutcome(false, 0, 0), "exhausted");
});

test("re-dispatch prompt carries the check + failure output + attempt", () => {
  const p = redispatchPrompt("npm test", "1 failing", 2);
  assert.match(p, /npm test/);
  assert.match(p, /1 failing/);
  assert.match(p, /re-dispatch #2/);
  assert.match(p, /exits 0/);
});

test("re-dispatch prompt tolerates empty output", () => {
  assert.match(redispatchPrompt("./check.sh", "   ", 1), /\(no output\)/);
});

test("exhausted message is loud, names the worker + check, and says don't just bump --max", () => {
  const m = exhaustedMessage("builder", "npm run typecheck", 3, "TS2304: cannot find name");
  assert.match(m, /builder/);
  assert.match(m, /npm run typecheck/);
  assert.match(m, /3 re-dispatch/);
  assert.match(m, /don't just bump --max/);
  assert.match(m, /TS2304/);
});

// ── Feature A: distillFailure (pure "what actually failed" extractor) ──

test("distillFailure: empty / whitespace-only input → (no output)", () => {
  assert.equal(distillFailure(""), "(no output)");
  assert.equal(distillFailure("   \n  \n\t"), "(no output)");
});

test("distillFailure: extracts failing-test summary + 'not ok' lines, drops passing noise", () => {
  const out = ["ok 1 - adds", "ok 2 - subtracts", "not ok 3 - divides", "", "# tests 3", "1 failing"].join("\n");
  const d = distillFailure(out);
  assert.match(d, /not ok 3 - divides/);
  assert.match(d, /1 failing/);
  assert.doesNotMatch(d, /ok 1 - adds/); // passing lines excluded
  assert.doesNotMatch(d, /# tests 3/); // non-signal summary excluded
});

test("distillFailure: extracts error/exception lines in order, de-duplicated", () => {
  const out = [
    "Running suite...",
    "AssertionError: expected 1 to equal 2",
    "    at Object.<anonymous> (test.js:10:5)",
    "AssertionError: expected 1 to equal 2", // duplicate → dropped
    "TypeError: x is not a function",
  ].join("\n");
  assert.deepEqual(distillFailure(out).split("\n"), [
    "AssertionError: expected 1 to equal 2",
    "TypeError: x is not a function",
  ]);
});

test("distillFailure: no signal line → falls back to the last maxLines (the tail)", () => {
  const out = ["line one", "line two", "line three", "the real message at the end"].join("\n");
  assert.equal(distillFailure(out, { maxLines: 2 }), "line three\nthe real message at the end");
});

test("distillFailure: caps to maxLines and appends a truncation marker", () => {
  const out = Array.from({ length: 20 }, (_, i) => `Error ${i}: boom`).join("\n");
  const lines = distillFailure(out, { maxLines: 5 }).split("\n");
  assert.equal(lines.length, 6); // 5 kept + 1 marker
  assert.match(lines[0]!, /^Error 0: boom$/);
  assert.match(lines[5]!, /… \(truncated; 15 more line\(s\)\)/);
});

test("distillFailure: caps to maxChars by dropping whole lines (still marks the drop)", () => {
  const out = Array.from({ length: 10 }, (_, i) => `Error: ${"x".repeat(50)} ${i}`).join("\n");
  const d = distillFailure(out, { maxChars: 120 });
  assert.match(d, /truncated; \d+ more line\(s\)/);
  const body = d.split("\n").filter((l) => !l.startsWith("…")).join("\n");
  assert.ok(body.length <= 120, `body should be under maxChars, got ${body.length}`);
});

test("distillFailure: a single over-long line is clipped AND marked truncated", () => {
  const out = "AssertionError: " + "y".repeat(500);
  const d = distillFailure(out, { maxChars: 80 });
  assert.ok(d.length <= 80, `clipped to maxChars, got ${d.length}`);
  assert.match(d, /truncated/);
  assert.match(d, /^AssertionError:/);
});

// ── Feature B: shouldWake (pre-spawn gate, FAIL-OPEN) ──

test("shouldWake: explicit {wakeAgent:false} on a clean run → skip", () => {
  assert.equal(shouldWake('{"wakeAgent": false}', 0), false);
});

test("shouldWake: explicit {wakeAgent:true} → wake", () => {
  assert.equal(shouldWake('{"wakeAgent": true}', 0), true);
});

test("shouldWake: no JSON line → wake (fail-open)", () => {
  assert.equal(shouldWake("nothing structured here", 0), true);
  assert.equal(shouldWake("", 0), true);
});

test("shouldWake: malformed JSON → wake (fail-open)", () => {
  assert.equal(shouldWake('{"wakeAgent": fal', 0), true);
});

test("shouldWake: non-boolean wakeAgent → wake (fail-open)", () => {
  assert.equal(shouldWake('{"wakeAgent": "no"}', 0), true);
});

test("shouldWake: non-zero exit → wake even if it printed false", () => {
  assert.equal(shouldWake('{"wakeAgent": false}', 1), true);
});

test("shouldWake: the FINAL non-empty line is the verdict (consecutive clean lines → last wins)", () => {
  assert.equal(shouldWake(['{"wakeAgent": true}', '{"wakeAgent": false}'].join("\n"), 0), false);
  assert.equal(shouldWake(['{"wakeAgent": false}', '{"wakeAgent": true}'].join("\n"), 0), true);
  // Trailing blank lines are ignored — the last NON-EMPTY line decides.
  assert.equal(shouldWake('{"wakeAgent": false}\n\n  \n', 0), false);
});

test("shouldWake: a clean false followed by a non-verdict/malformed trailing line WAKES (no upward scan)", () => {
  // A stale `false` hiding behind trailing garbage must NOT suppress work.
  assert.equal(shouldWake(['{"wakeAgent": false}', "plain text"].join("\n"), 0), true);
  assert.equal(shouldWake(['{"wakeAgent": false}', '{"other": 1}'].join("\n"), 0), true);
  assert.equal(shouldWake(['{"wakeAgent": false}', "garbage {not json"].join("\n"), 0), true);
});
