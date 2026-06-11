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
