// Unit tests for the resource guardrails (evaluateResources): sustained-beats
// CPU dwell, immediate RSS breach, surface-health failure, cooldown, and the
// capability-gated no-op (undefined sample/health → never a nudge). Run with
// `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newMemory, evaluateResources, type ResourceThresholds } from "./policy.js";

const AGENT = { agentId: "a1", label: "worker-1" };
const TH: ResourceThresholds = { cpuHogPercent: 90, cpuHogBeats: 5, memHogMb: 4096 };
const COOLDOWN = 300_000;
const GB = 1024 ** 3;
// A realistic epoch base: "no prior alert" is stored as 0, so nowMs must sit
// beyond the cooldown window exactly as real Date.now() values do.
const T0 = Date.parse("2026-06-09T12:00:00Z");

const hot = { cpuPercent: 95, residentBytes: 1 * GB };
const cool = { cpuPercent: 5, residentBytes: 1 * GB };

test("CPU breach must be SUSTAINED: nudges on the 5th consecutive hot beat, not before", () => {
  const mem = newMemory();
  let now = T0;
  for (let beat = 1; beat <= 4; beat++) {
    assert.equal(evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH), null);
  }
  const msg = evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH);
  assert.ok(msg, "5th consecutive beat above threshold must nudge");
  assert.match(msg!.text, /worker-1/);
  assert.match(msg!.text, /never kills/);
  assert.equal(msg!.urgent, false); // a nudge, not an interrupt — and NEVER a kill
});

test("a dip below the CPU threshold resets the dwell (one spike never nudges)", () => {
  const mem = newMemory();
  let now = T0;
  for (let beat = 1; beat <= 4; beat++) {
    evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH);
  }
  evaluateResources(AGENT, cool, undefined, mem, (now += 1000), COOLDOWN, TH); // dip
  for (let beat = 1; beat <= 4; beat++) {
    assert.equal(evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH), null);
  }
});

test("RSS breach nudges immediately (no dwell) and names the size", () => {
  const mem = newMemory();
  const msg = evaluateResources(AGENT, { cpuPercent: 1, residentBytes: 5 * GB }, undefined, mem, T0, COOLDOWN, TH);
  assert.ok(msg);
  assert.match(msg!.text, /5\.0GB/);
  assert.match(msg!.text, /never kills/);
});

test("surface-health failure nudges with the reason and wins precedence", () => {
  const mem = newMemory();
  const msg = evaluateResources(AGENT, { cpuPercent: 99, residentBytes: 9 * GB }, "pty gone", mem, T0, COOLDOWN, TH);
  assert.ok(msg);
  assert.match(msg!.text, /pty gone/);
});

test("cooldown suppresses a repeat nudge for the same condition; re-arms after recovery", () => {
  const mem = newMemory();
  const big = { cpuPercent: 1, residentBytes: 5 * GB };
  assert.ok(evaluateResources(AGENT, big, undefined, mem, T0 + 1_000, COOLDOWN, TH));
  assert.equal(evaluateResources(AGENT, big, undefined, mem, T0 + 2_000, COOLDOWN, TH), null); // within cooldown
  // recovery clears the cooldown…
  assert.equal(evaluateResources(AGENT, cool, undefined, mem, T0 + 3_000, COOLDOWN, TH), null);
  // …so a NEW breach nudges again even inside the old window.
  assert.ok(evaluateResources(AGENT, big, undefined, mem, T0 + 4_000, COOLDOWN, TH));
});

test("capability gating: an undefined sample + health (older cmux) is a strict no-op", () => {
  const mem = newMemory();
  for (let beat = 1; beat <= 10; beat++) {
    assert.equal(evaluateResources(AGENT, undefined, undefined, mem, T0 + beat * 1000, COOLDOWN, TH), null);
  }
  assert.deepEqual(mem.cpuHighBeats, {});
  assert.deepEqual(mem.lastResourceAlert, {});
});

test("a vanishing sample mid-dwell resets the CPU counter (no stale nudge)", () => {
  const mem = newMemory();
  let now = T0;
  for (let beat = 1; beat <= 4; beat++) {
    evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH);
  }
  evaluateResources(AGENT, undefined, undefined, mem, (now += 1000), COOLDOWN, TH);
  assert.equal(evaluateResources(AGENT, hot, undefined, mem, (now += 1000), COOLDOWN, TH), null);
});
