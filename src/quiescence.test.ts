// Unit tests for the stable-idle dwell (B1/B2): quiescence only after
// sustained all-idle beats with no fresh dispatch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleDwell } from "./quiescence.js";

const T0 = Date.parse("2026-06-09T05:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const STALE = [iso(T0 - 60_000)]; // dispatched a minute ago — outside the hold

test("dwell: a single idle beat is NOT quiescence", () => {
  const d = new IdleDwell();
  assert.equal(d.beat(true, STALE, T0), false);
});

test("dwell: two idle beats spanning >=10s confirm quiescence", () => {
  const d = new IdleDwell();
  assert.equal(d.beat(true, STALE, T0), false);
  assert.equal(d.beat(true, STALE, T0 + 10_000), true);
});

test("dwell: two idle beats only 3s apart do NOT confirm (span too short)", () => {
  const d = new IdleDwell();
  assert.equal(d.beat(true, STALE, T0), false);
  assert.equal(d.beat(true, STALE, T0 + 3_000), false);
  // ...but a later beat past the span does.
  assert.equal(d.beat(true, STALE, T0 + 11_000), true);
});

test("dwell: an active beat resets the window from zero", () => {
  const d = new IdleDwell();
  d.beat(true, STALE, T0);
  d.beat(false, STALE, T0 + 5_000); // a worker ran — misattributed idle was transient
  assert.equal(d.beat(true, STALE, T0 + 10_000), false); // window restarted
  assert.equal(d.beat(true, STALE, T0 + 20_000), true);
});

test("dwell: a dispatch younger than ~15s blocks quiescence even when all screens read idle", () => {
  const d = new IdleDwell();
  const justDispatched = [iso(T0 - 5_000)]; // `fleet send` 5s ago — work in flight
  assert.equal(d.beat(true, justDispatched, T0), false);
  assert.equal(d.beat(true, justDispatched, T0 + 5_000), false); // still inside the hold
  // Once the dispatch ages out, the dwell starts over (not from the old beats).
  assert.equal(d.beat(true, justDispatched, T0 + 20_000), false);
  assert.equal(d.beat(true, justDispatched, T0 + 31_000), true);
});
