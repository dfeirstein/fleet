// Unit tests for the S5 multi-Captain refusal: with FLEET_SESSION unset and
// more than one live Captain, notify-orchestrator must refuse rather than
// silently default to "yoshi". Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { multiCaptainRefusal } from "./notify.js";

test("FLEET_SESSION set → never refuses, even with many live Captains", () => {
  assert.equal(multiCaptainRefusal("yoshi-2", ["yoshi", "yoshi-2", "yoshi-3"]), undefined);
});

test("no live Captains → no refusal (current fallback behavior)", () => {
  assert.equal(multiCaptainRefusal(undefined, []), undefined);
});

test("single live Captain → no refusal (current behavior)", () => {
  assert.equal(multiCaptainRefusal(undefined, ["yoshi-2"]), undefined);
});

test("duplicate records for one session still count as a single Captain", () => {
  assert.equal(multiCaptainRefusal(undefined, ["yoshi", "yoshi"]), undefined);
});

test("multiple live Captains without FLEET_SESSION → refusal naming each", () => {
  const msg = multiCaptainRefusal(undefined, ["yoshi-2", "yoshi"]);
  assert.ok(msg);
  assert.match(msg, /FLEET_SESSION/);
  assert.match(msg, /one of: yoshi, yoshi-2/);
});
