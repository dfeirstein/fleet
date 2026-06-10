// Unit tests for the Dock config merge (`fleet setup --dock`): user-defined
// controls must survive in place and re-runs must be idempotent. Run with
// `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDockControls, FLEET_DOCK_CONTROLS } from "./dock-config.js";

test("empty config gains exactly the fleet controls", () => {
  const merged = mergeDockControls({});
  assert.deepEqual(merged.controls, FLEET_DOCK_CONTROLS);
});

test("user controls are preserved, in order, ahead of appended fleet entries", () => {
  const user = { id: "git", title: "Git", command: "lazygit", height: 300 };
  const merged = mergeDockControls({ controls: [user], somethingElse: true });
  const controls = merged.controls as Record<string, unknown>[];
  assert.equal(controls.length, 1 + FLEET_DOCK_CONTROLS.length);
  assert.deepEqual(controls[0], user); // untouched, still first
  assert.equal(merged.somethingElse, true); // non-control keys survive
});

test("idempotent: re-running the merge adds nothing and changes nothing", () => {
  const once = mergeDockControls({ controls: [{ id: "logs", title: "Logs", command: "tail -f x" }] });
  const twice = mergeDockControls(once);
  assert.deepEqual(twice, once);
});

test("a stale fleet-owned entry is refreshed in place (matched by id), user extras kept", () => {
  const stale = { id: "fleet-watch", title: "Old", command: "fleet watch", height: 200 };
  const merged = mergeDockControls({ controls: [stale] });
  const controls = merged.controls as Record<string, unknown>[];
  const watch = controls.find((c) => c.id === "fleet-watch")!;
  assert.equal(watch.command, "fleet watch --no-until-idle"); // refreshed
  assert.equal(watch.height, 200); // the user's tweak survives
  assert.equal(controls.filter((c) => c.id === "fleet-watch").length, 1); // no dupes
});

test("pure: the input config object is not mutated", () => {
  const input = { controls: [{ id: "git", title: "Git", command: "lazygit" }] };
  const snapshot = JSON.stringify(input);
  mergeDockControls(input);
  assert.equal(JSON.stringify(input), snapshot);
});
