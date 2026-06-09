// Unit tests for the proof gate (pure rules; runnable proofs use an injected
// runner, static proofs use real tmp files). Run with `npm test`.
// The fail-closed matrix from BUILD_TASK §Verification (Phase 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateProof, parseProof, proofState, type ProofArtifact, type GateContext } from "./proof.js";

function artifact(kind: ProofArtifact["kind"], ref: string): ProofArtifact {
  return { kind, ref, attachedAt: "2026-06-09T00:00:00.000Z" };
}

const pass: GateContext = { dir: "/x", runCheck: () => ({ pass: true, output: "ok" }) };
const failRun: GateContext = { dir: "/x", runCheck: () => ({ pass: false, output: "AssertionError: nope" }) };

test("no proof attached → done-without-proof (never complete)", () => {
  assert.equal(gateProof(undefined, pass).verdict, "done-without-proof");
  assert.equal(gateProof([], pass).verdict, "done-without-proof");
});

test("runnable proof passing → complete", () => {
  const r = gateProof([artifact("test", "npm run typecheck")], pass);
  assert.equal(r.verdict, "complete");
  assert.deepEqual(r.proofRefs, ["test:npm run typecheck"]);
});

test("runnable proof failing → proof-failed (fail closed)", () => {
  const r = gateProof([artifact("test", "npm test")], failRun);
  assert.equal(r.verdict, "proof-failed");
  assert.match(r.detail, /AssertionError/);
});

test("static file present + non-empty → complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const p = join(dir, "diff.patch");
  writeFileSync(p, "diff --git a b\n+change\n");
  assert.equal(gateProof([artifact("file", p)], { dir }).verdict, "complete");
  assert.equal(gateProof([artifact("diff", "diff.patch")], { dir }).verdict, "complete"); // relative to dir
});

test("static file missing → proof-failed", () => {
  const r = gateProof([artifact("file", "/nonexistent/path.png")], { dir: "/x" });
  assert.equal(r.verdict, "proof-failed");
  assert.match(r.detail, /missing/);
});

test("static file empty → proof-failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const p = join(dir, "empty.txt");
  writeFileSync(p, "");
  const r = gateProof([artifact("file", p)], { dir });
  assert.equal(r.verdict, "proof-failed");
  assert.match(r.detail, /empty/);
});

test("note ALONE is never sufficient → done-without-proof (judge ≠ generator)", () => {
  // A worker's free text can't self-certify; a note-only set is treated exactly
  // like no proof at all (the flagged, NOT-complete state).
  const r = gateProof([artifact("note", "trust me — I checked it manually")], { dir: "/x" });
  assert.equal(r.verdict, "done-without-proof");
  assert.match(r.detail, /only note/);
  assert.throws(() => parseProof("note:"), /empty ref/);
});

test("note ACCOMPANYING a passing checkable proof → complete (note is a label)", () => {
  const r = gateProof([artifact("note", "ran locally"), artifact("test", "npm run typecheck")], pass);
  assert.equal(r.verdict, "complete");
  assert.deepEqual(r.proofRefs, ["note:ran locally", "test:npm run typecheck"]);
});

test("note accompanying a FAILING checkable proof → proof-failed", () => {
  const r = gateProof([artifact("note", "should be fine"), artifact("test", "npm test")], failRun);
  assert.equal(r.verdict, "proof-failed");
});

test("mixed proofs: one failure fails the whole gate (fail closed)", () => {
  const ctx: GateContext = { dir: "/x", runCheck: (_d, cmd) => ({ pass: cmd === "good", output: cmd }) };
  const r = gateProof([artifact("test", "good"), artifact("command", "bad")], ctx);
  assert.equal(r.verdict, "proof-failed");
});

test("parseProof: validates kind + shape", () => {
  assert.deepEqual(
    { kind: parseProof("test:npm test").kind, ref: parseProof("test:npm test").ref },
    { kind: "test", ref: "npm test" },
  );
  assert.equal(parseProof("file:/a/b:c").ref, "/a/b:c"); // only the FIRST colon splits
  assert.throws(() => parseProof("bogus:x"), /unknown proof kind/);
  assert.throws(() => parseProof("noseparator"), /<kind:ref>/);
});

test("proofState maps verdict → compact outcome state", () => {
  assert.equal(proofState("complete"), "verified");
  assert.equal(proofState("done-without-proof"), "missing");
  assert.equal(proofState("proof-failed"), "failed");
});
