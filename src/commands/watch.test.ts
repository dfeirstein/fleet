// Unit test for watch's activity check: rate-limited is mid-task, not
// quiescent (S4) — it must keep the watch alive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeCount } from "./watch.js";
import type { FleetRow } from "./status.js";

const row = (status: string): FleetRow => ({
  agentId: "a1",
  label: "w",
  workspace: "workspace:1",
  surface: "surface:1",
  model: "opus",
  status,
  task: "t",
  lastDispatchAt: "2026-06-09T05:00:00Z",
});

test("activeCount: rate-limited counts as active (S4)", () => {
  assert.equal(activeCount([row("rate-limited")]), 1);
});

test("activeCount: running/unknown/blocked active; idle/dead/error not", () => {
  assert.equal(activeCount([row("running"), row("unknown"), row("blocked-on-you")]), 3);
  assert.equal(activeCount([row("idle"), row("dead"), row("error"), row("awaiting-input")]), 0);
});
