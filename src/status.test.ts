// Unit tests for the screen classifier — the generic spinner heuristic (B4
// note): any spinner glyph + gerund + timer, minute forms included, instead of
// a verb whitelist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyScreen } from "./status.js";

test("classifyScreen: open-ended spinner verb with minute-form timer → running", () => {
  assert.equal(classifyScreen("✶ Razzmatazzing… 12m 11s\n"), "running");
  assert.equal(classifyScreen("✻ Bamboozling… (12m 11s · ↓ 2.3k tokens)\n"), "running");
  assert.equal(classifyScreen("✶ Razzmatazzing… (12m 11s · ↑ 47.8k tokens)\n"), "running");
  assert.equal(classifyScreen("Computing… (1m 36s)\n"), "running");
  assert.equal(classifyScreen("✻ Pondering… 2h 3m 14s\n"), "running");
});

test("classifyScreen: gerund summary prose with a duration is NOT a spinner (idle)", () => {
  // A false `running` is sticky post-B1 (beats turn-end notifications), so
  // glyph-prefixed prose mentioning a duration must not match: the spinner
  // ellipsis is mandatory and the glyph is anchored at line start.
  const idleScreen = (line: string): string => `${line}\n❯ \n? for shortcuts\n`;
  assert.equal(classifyScreen(idleScreen("* Updating the config took 12s")), "idle");
  assert.equal(classifyScreen(idleScreen("· Building finished in 32s")), "idle");
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
