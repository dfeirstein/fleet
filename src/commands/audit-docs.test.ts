// Unit tests for the audit-docs pass/fail decision (pure rules). The gate
// FAILS CLOSED: inconclusive inputs are failures with stated reasons; the one
// allowed soft case (no currency cache yet) must be stated in the output.
// Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAudit, type AuditDecisionInput } from "./audit-docs.js";

const healthy: AuditDecisionInput = {
  hasClaudeMd: true,
  scorerFound: true,
  score: 85,
  minScore: 60,
  staleCurrency: [],
  currencyState: "ok",
};

test("all conclusive + healthy → PASS with no reasons", () => {
  const r = decideAudit(healthy);
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.notes, []);
});

test("no CLAUDE.md → FAIL", () => {
  const r = decideAudit({ ...healthy, hasClaudeMd: false, score: undefined, scorerFound: false });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /no CLAUDE\.md/);
});

test("scorer not installed → FAIL with reason (fail closed, was a silent pass)", () => {
  const r = decideAudit({ ...healthy, scorerFound: false, score: undefined });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /scorer not installed.*fail closed/);
});

test("scorer crashed / unparseable score → FAIL with reason (fail closed)", () => {
  const r = decideAudit({ ...healthy, score: undefined });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /no score.*fail closed/);
});

test("score below threshold → FAIL with the score in the reason", () => {
  const r = decideAudit({ ...healthy, score: 40 });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /40 < 60/);
});

test("score exactly at threshold → PASS", () => {
  assert.equal(decideAudit({ ...healthy, score: 60 }).pass, true);
});

test("currency cache unreadable/corrupt → FAIL with reason (fail closed)", () => {
  const r = decideAudit({ ...healthy, currencyState: "unreadable" });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /unreadable.*fail closed/);
});

test("no currency cache at all → soft PASS, but the contract is STATED", () => {
  const r = decideAudit({ ...healthy, currencyState: "missing" });
  assert.equal(r.pass, true);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /no cache file.*soft pass/i);
});

test("stale currency facts → FAIL", () => {
  const r = decideAudit({ ...healthy, staleCurrency: ["tsx", "typescript"] });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join("; "), /2 currency fact\(s\) past TTL/);
});

test("multiple failures all reported", () => {
  const r = decideAudit({ ...healthy, score: undefined, currencyState: "unreadable" });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.length, 2);
});
