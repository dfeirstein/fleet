// Unit tests for the verify→proof auto-attach decision (pure rules): a passing
// Captain-run check becomes a proof claim; failures, no-op commands, and
// duplicates never attach. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyProofToAttach } from "./verify.js";
import type { ProofArtifact } from "../proof.js";

function artifact(kind: ProofArtifact["kind"], ref: string): ProofArtifact {
  return { kind, ref, attachedAt: "2026-06-09T00:00:00.000Z" };
}

test("passing check → command proof with the check as ref", () => {
  const p = verifyProofToAttach(true, "npm run typecheck", undefined);
  assert.ok(p);
  assert.equal(p.kind, "command");
  assert.equal(p.ref, "npm run typecheck");
});

test("FAILING check never attaches (a failure proves nothing)", () => {
  assert.equal(verifyProofToAttach(false, "npm test", undefined), undefined);
});

test("no-op command never attaches even when it passes (no self-cert via `true`)", () => {
  assert.equal(verifyProofToAttach(true, "true", undefined), undefined);
  assert.equal(verifyProofToAttach(true, "exit 0", undefined), undefined);
  assert.equal(verifyProofToAttach(true, "  ", undefined), undefined);
});

test("same command already attached → dedup, no second attach", () => {
  const existing = [artifact("command", "npm test")];
  assert.equal(verifyProofToAttach(true, "npm test", existing), undefined);
});

test("dedup is by ref across kinds (worker attached test:, Captain verifies same cmd)", () => {
  const existing = [artifact("test", "npm test")];
  assert.equal(verifyProofToAttach(true, "npm test", existing), undefined);
});

test("different command than existing proofs → attaches", () => {
  const existing = [artifact("test", "npm test")];
  const p = verifyProofToAttach(true, "npm run typecheck", existing);
  assert.ok(p);
  assert.equal(p.ref, "npm run typecheck");
});
