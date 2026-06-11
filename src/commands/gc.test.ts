import { test } from "node:test";
import assert from "node:assert/strict";
import { planGc, type SessionLiveness } from "./gc.js";

function decide(s: SessionLiveness) {
  return planGc([s])[0]!;
}

test("dead session (no Captain, all workers dead) is removed", () => {
  const d = decide({ session: "old", captain: "absent", workers: ["dead", "dead"] });
  assert.equal(d.action, "remove");
  assert.match(d.reason, /dead/);
});

test("a session with no workers and no Captain is removed", () => {
  // residue with nothing live behind it — registry already empty, captain gone.
  assert.equal(decide({ session: "stub", captain: "absent", workers: [] }).action, "remove");
});

test("a live Captain keeps the session", () => {
  const d = decide({ session: "yoshi", captain: "live", workers: ["dead"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /Captain/);
});

test("a live worker keeps the session even with no Captain", () => {
  const d = decide({ session: "busy", captain: "absent", workers: ["dead", "live"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /worker/);
});

test("an unverifiable Captain check is kept (fail closed)", () => {
  const d = decide({ session: "maybe", captain: "unverifiable", workers: [] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /unverifiable/);
});

test("an unverifiable worker check is kept (fail closed)", () => {
  const d = decide({ session: "maybe", captain: "absent", workers: ["dead", "unverifiable"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /unverifiable/);
});

test("mixed: a live signal wins over an unverifiable one (reported as live, not kept-unverifiable)", () => {
  const d = decide({ session: "mix", captain: "absent", workers: ["live", "unverifiable"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /worker/);
});

test("each session is decided independently", () => {
  const decisions = planGc([
    { session: "dead1", captain: "absent", workers: ["dead"] },
    { session: "live1", captain: "live", workers: [] },
    { session: "unsure1", captain: "unverifiable", workers: [] },
  ]);
  assert.deepEqual(
    decisions.map((d) => `${d.session}:${d.action}`),
    ["dead1:remove", "live1:keep", "unsure1:keep"],
  );
});
