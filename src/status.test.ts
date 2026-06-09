// Unit tests for the screen classifier — the generic spinner heuristic (B4
// note): any spinner glyph + gerund + timer, minute forms included, instead of
// a verb whitelist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyScreen } from "./status.js";

test("classifyScreen: open-ended spinner verb with minute-form timer → running", () => {
  assert.equal(classifyScreen("✶ Razzmatazzing… 12m 11s\n"), "running");
  assert.equal(classifyScreen("✻ Bamboozling… (12m 11s · ↓ 2.3k tokens)\n"), "running");
});

test("classifyScreen: second-form timer and interrupt hint still match", () => {
  assert.equal(classifyScreen("✶ Thinking… (34s · esc to interrupt)\n"), "running");
  assert.equal(classifyScreen("some output\nesc to interrupt\n"), "running");
});

test("classifyScreen: dev-server noise ('1 shell still running') is NOT running", () => {
  assert.notEqual(classifyScreen("1 shell still running\n"), "running");
});

test("classifyScreen: idle prompt box is idle, not running", () => {
  assert.equal(classifyScreen("❯ \n? for shortcuts\n"), "idle");
});
