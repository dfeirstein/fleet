// Unit tests for the verification-coverage classifier (pure). Covers true
// positives (each uncertainty marker), the conservative false-positive guards
// (legit prose that must NOT flag), and the skip rules (headings, code fences,
// TOC entries, gotchasOnly scope). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markerFor,
  claimLines,
  verificationCoverage,
  UNVERIFIED_MARKERS,
} from "./verification-coverage.js";

// ── markerFor: true positives — each uncertainty marker flags a claim ─────────

test("flags 'maybe'", () => assert.ok(markerFor("- maybe the column is prc not prc_usd")));
test("flags 'possibly'", () => assert.ok(markerFor("the daemon is possibly spinning")));
test("flags 'probably'", () => assert.ok(markerFor("this is probably the cause")));
test("flags the phrase 'might be'", () => assert.ok(markerFor("the boot race might be 2-3s")));
test("flags 'not sure'", () => assert.ok(markerFor("not sure why this works")));
test("flags 'unverified'", () => assert.ok(markerFor("unverified: schema may have changed")));
test("flags 'needs verification'", () => assert.ok(markerFor("the TTL needs verification")));
test("flags 'verify?'", () => assert.ok(markerFor("token cap is 1000, verify?")));
test("flags 'TODO: confirm' (case-insensitive)", () => assert.ok(markerFor("todo: confirm the port")));
test("flags an inline '(?)' marker", () => assert.ok(markerFor("the limit is 16 (?) per workflow")));
test("flags a trailing '?'", () => assert.ok(markerFor("is the surface a terminal yet?")));

// ── markerFor: false-positive guards — checked prose must NOT flag ────────────
// Conservative-by-design: we accept that a bare "maybe" in prose flags. These
// guard the cases we explicitly do NOT want to flag.

test("does NOT flag bare 'might' (only the phrase 'might be' flags)", () => {
  assert.equal(markerFor("you might want to address workers by uuid"), undefined);
});
test("does NOT flag a mid-sentence '?' that isn't trailing", () => {
  assert.equal(markerFor("the `cmux capabilities?` rpc gates this and returns a list"), undefined);
});
test("does NOT flag the word 'verify' on its own (only 'verify?')", () => {
  assert.equal(markerFor("verify the input cleared before re-Enter"), undefined);
});
test("does NOT flag a plain checked claim", () => {
  assert.equal(markerFor("the PTY boots lazily — always waitForTerminal() before sending"), undefined);
});

test("UNVERIFIED_MARKERS is a non-empty tunable constant", () => {
  assert.ok(UNVERIFIED_MARKERS.length > 0);
});

// ── claimLines: skip rules ────────────────────────────────────────────────────

test("skips headings — they are never claims", () => {
  const ls = claimLines("# Gotchas\n## maybe a heading?\n", "f.md", false);
  assert.equal(ls.length, 0);
});

test("skips fenced code blocks (even when they contain marker text)", () => {
  const md = ["- a real claim", "```", "- maybe this is code, not a claim?", "```", "- another claim"].join("\n");
  const ls = claimLines(md, "f.md", false);
  assert.equal(ls.length, 2);
  assert.ok(ls.every((l) => l.verified));
});

test("skips table-of-contents link entries", () => {
  const md = ["- [architecture](./arch.md) — module map", "- a substantive claim"].join("\n");
  const ls = claimLines(md, "f.md", false);
  assert.equal(ls.length, 1);
  assert.equal(ls[0]!.text, "a substantive claim");
});

test("skips prose / continuation lines (only bullets are claims)", () => {
  const md = ["This is prose, maybe even hedged.", "- a bullet claim", "  a continuation line, possibly hedged"].join("\n");
  const ls = claimLines(md, "f.md", false);
  assert.equal(ls.length, 1);
  assert.equal(ls[0]!.line, 2);
});

test("classifies numbered list items too", () => {
  const ls = claimLines("1. first, verified\n2. second, verify?", "f.md", false);
  assert.equal(ls.length, 2);
  assert.equal(ls[1]!.verified, false);
});

// ── claimLines: gotchasOnly scope (CLAUDE.md) ─────────────────────────────────

test("gotchasOnly: only bullets under a Gotchas-like heading are claims", () => {
  const md = [
    "## Behavioral Rules",
    "- be careful, maybe",
    "## Gotchas",
    "- a checked gotcha",
    "- a hedged gotcha, probably",
    "## Currency",
    "- prefer latest, maybe",
  ].join("\n");
  const ls = claimLines(md, "CLAUDE.md", true);
  assert.equal(ls.length, 2); // only the two under ## Gotchas
  assert.deepEqual(
    ls.map((l) => l.verified),
    [true, false],
  );
});

// ── verificationCoverage: aggregate ───────────────────────────────────────────

test("aggregates coverage across docs with file:line refs", () => {
  const rep = verificationCoverage([
    { file: "CLAUDE.md", content: "## Gotchas\n- solid fact\n- shaky guess, maybe", gotchasOnly: true },
    { file: ".claude-docs/x.md", content: "- another solid fact", gotchasOnly: false },
  ]);
  assert.equal(rep.total, 3);
  assert.equal(rep.verified, 2);
  assert.equal(rep.percent, 67);
  assert.equal(rep.unverified.length, 1);
  assert.equal(rep.unverified[0]!.file, "CLAUDE.md");
  assert.equal(rep.unverified[0]!.line, 3);
});

test("no claims at all → 100% (an empty memory has nothing unverified)", () => {
  assert.equal(verificationCoverage([]).percent, 100);
});
