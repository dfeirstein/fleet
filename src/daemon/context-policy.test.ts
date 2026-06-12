// Unit tests for evaluateContextOccupancy — the context-guard policy core.
// Covers: worker idle→/compact at caution, cooldown, escalate-once-if-it-didn't-
// take, compaction-detected reset (re-arm), fail-closed on UNKNOWN, the running-
// worker hard-ceiling nudge, auto-off nudge-only, and the Captain caution/hard
// nudge + save-state-then-auto-/compact path. Pure (no cmux). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateContextOccupancy, newMemory, type CtxThresholds } from "./policy.js";
import type { Occupancy } from "./ctx.js";

const TH: CtxThresholds = {
  cautionPct: 50,
  hardPct: 66,
  autoCompactWorkers: true,
  autoCompactCaptain: false,
  compactCooldownMs: 600_000,
  alertCooldownMs: 300_000,
};
const T0 = Date.parse("2026-06-12T12:00:00Z");
const occ = (pct: number, known = true, stale = false): Occupancy => ({ known, pct, stale });
const worker = (idle: boolean, o: Occupancy) =>
  ({ agentId: "a1", label: "w1", role: "worker" as const, idle, occ: o });
const captain = (idle: boolean, o: Occupancy) =>
  ({ agentId: "captain:cliff", label: "captain", role: "captain" as const, idle, occ: o });

// ── Worker: idle → /compact at caution ───────────────────────────────────────

test("worker idle at caution + auto-compact → sends /compact to its pane", () => {
  const mem = newMemory();
  assert.deepEqual(evaluateContextOccupancy(worker(true, occ(55)), mem, T0, TH), { compact: "worker" });
});

test("worker idle below caution → no action", () => {
  assert.equal(evaluateContextOccupancy(worker(true, occ(49)), newMemory(), T0, TH), null);
});

test("after a /compact, subsequent beats within cooldown stay quiet (no re-send)", () => {
  const mem = newMemory();
  evaluateContextOccupancy(worker(true, occ(55)), mem, T0, TH); // compact
  assert.equal(evaluateContextOccupancy(worker(true, occ(56)), mem, T0 + 1_000, TH), null);
  assert.equal(evaluateContextOccupancy(worker(true, occ(57)), mem, T0 + 60_000, TH), null);
});

test("if the /compact didn't take after the cooldown, escalate ONCE to the Captain (then quiet)", () => {
  const mem = newMemory();
  evaluateContextOccupancy(worker(true, occ(55)), mem, T0, TH); // compact
  const esc = evaluateContextOccupancy(worker(true, occ(57)), mem, T0 + TH.compactCooldownMs + 1_000, TH);
  assert.ok(esc?.message);
  assert.equal(esc!.message!.urgent, false);
  assert.match(esc!.message!.text, /still at 57% context after an auto `\/compact`/);
  // escalates only once
  assert.equal(evaluateContextOccupancy(worker(true, occ(58)), mem, T0 + TH.compactCooldownMs + 2_000, TH), null);
});

test("a pct DROP >15 (the session compacted) resets the episode → a later climb re-arms /compact", () => {
  const mem = newMemory();
  evaluateContextOccupancy(worker(true, occ(55)), mem, T0, TH); // compact
  evaluateContextOccupancy(worker(true, occ(55)), mem, T0 + 1_000, TH); // within cooldown → quiet
  // compaction lands: 55 → 20 (drop 35 > 15) resets; below caution so no action
  assert.equal(evaluateContextOccupancy(worker(true, occ(20)), mem, T0 + 2_000, TH), null);
  // climbs back over caution → a fresh /compact (episode re-armed)
  assert.deepEqual(evaluateContextOccupancy(worker(true, occ(55)), mem, T0 + 3_000, TH), { compact: "worker" });
});

test("a compact+regrow between beats (compactions counter increments) resets the episode — no false escalation", () => {
  const mem = newMemory();
  const occC = (pct: number, compactions: number): Occupancy => ({ known: true, pct, stale: false, compactions });
  // Beat 1: 55%, 0 compactions → /compact sent.
  assert.deepEqual(
    evaluateContextOccupancy(worker(true, occC(55, 0)), mem, T0, TH),
    { compact: "worker" },
  );
  // Beat 2, AFTER the cooldown: still 55% — but compactions went 0→1, so the
  // worker actually compacted and regrew in the gap. The counter increment
  // resets the episode → a fresh /compact, NOT a false "ignoring /compact" nudge.
  const d = evaluateContextOccupancy(worker(true, occC(55, 1)), mem, T0 + TH.compactCooldownMs + 1_000, TH);
  assert.deepEqual(d, { compact: "worker" });
});

// ── Fail closed on UNKNOWN ───────────────────────────────────────────────────

test("UNKNOWN occupancy (stale/missing) is a strict no-op and records no state", () => {
  const mem = newMemory();
  assert.equal(evaluateContextOccupancy(worker(true, occ(95, false, true)), mem, T0, TH), null);
  assert.equal(evaluateContextOccupancy(captain(true, occ(95, false, false)), mem, T0, TH), null);
  assert.deepEqual(mem.ctx, {});
  assert.deepEqual(mem.ctxAlert, {});
});

// ── Worker: running mid-turn / auto-off ──────────────────────────────────────

test("worker running over the hard ceiling → urgent Captain nudge; cooldown suppresses the repeat", () => {
  const mem = newMemory();
  const d = evaluateContextOccupancy(worker(false, occ(70)), mem, T0, TH);
  assert.ok(d?.message);
  assert.equal(d!.message!.urgent, true);
  assert.match(d!.message!.text, /w1 at 70% mid-turn/);
  assert.match(d!.message!.text, /wrap up current step, then run \/compact/);
  assert.equal(evaluateContextOccupancy(worker(false, occ(71)), mem, T0 + 1_000, TH), null);
});

test("worker running between caution and hard → silent (it self-compacts at its breakpoint)", () => {
  assert.equal(evaluateContextOccupancy(worker(false, occ(55)), newMemory(), T0, TH), null);
});

test("auto-compact OFF: an idle worker is never auto-/compacted, but still nudges at the hard ceiling", () => {
  const off: CtxThresholds = { ...TH, autoCompactWorkers: false };
  assert.equal(evaluateContextOccupancy(worker(true, occ(55)), newMemory(), T0, off), null);
  const d = evaluateContextOccupancy(worker(true, occ(70)), newMemory(), T0, off);
  assert.ok(d?.message?.urgent);
});

// ── Captain ──────────────────────────────────────────────────────────────────

test("Captain at caution → non-urgent save-then-compact-then-reload nudge", () => {
  const d = evaluateContextOccupancy(captain(true, occ(55)), newMemory(), T0, TH);
  assert.ok(d?.message);
  assert.equal(d!.message!.urgent, false);
  assert.match(d!.message!.text, /next natural breakpoint/);
  assert.match(d!.message!.text, /fleet state/);
  assert.match(d!.message!.text, /Hard ceiling 66%/);
});

test("Captain over the hard ceiling (auto-compact off) → urgent nudge, never an auto-/compact", () => {
  const d = evaluateContextOccupancy(captain(true, occ(70)), newMemory(), T0, TH);
  assert.ok(d?.message?.urgent);
  assert.equal(d!.compact, undefined);
  assert.match(d!.message!.text, /hard ceiling/);
});

test("Captain auto-compact ON + idle: save-state nudge on the first beat, /compact on the next", () => {
  const on: CtxThresholds = { ...TH, autoCompactCaptain: true };
  const mem = newMemory();
  const d1 = evaluateContextOccupancy(captain(true, occ(70)), mem, T0, on);
  assert.ok(d1?.message?.urgent);
  assert.match(d1!.message!.text, /persist durable state with `fleet state` NOW/);
  assert.equal(d1!.compact, undefined); // never compact before the save-state beat
  const d2 = evaluateContextOccupancy(captain(true, occ(70)), mem, T0 + 1_000, on);
  assert.deepEqual(d2, { compact: "captain" });
});

test("Captain auto-compact ON but NOT idle → plain urgent nudge, no /compact", () => {
  const on: CtxThresholds = { ...TH, autoCompactCaptain: true };
  const d = evaluateContextOccupancy(captain(false, occ(70)), newMemory(), T0, on);
  assert.ok(d?.message?.urgent);
  assert.equal(d!.compact, undefined);
});
