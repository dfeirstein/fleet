// Unit tests for the daemon self-heal decision (pure; no cmux). Covers the four
// outcomes from issue #39: a live surface is a noop, a single recovered surface
// re-matches, an ambiguous workspace re-matches NOTHING (fail closed), and a
// vanished workspace is unresolvable. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSelfHeal } from "./selfheal.js";

test("already-valid surface is a noop (keep watching as-is)", () => {
  const d = decideSelfHeal({ surfaceLive: true, workspaceExists: true, candidateSurfaces: [] });
  assert.deepEqual(d, { action: "keep" });
});

test("clean re-match: surface gone, workspace alive, ONE live candidate → re-stamp", () => {
  const d = decideSelfHeal({
    surfaceLive: false,
    workspaceExists: true,
    candidateSurfaces: ["surface-new"],
  });
  assert.deepEqual(d, { action: "rematch", surfaceId: "surface-new" });
});

test("re-match dedupes repeated candidate ids to a single surface", () => {
  const d = decideSelfHeal({
    surfaceLive: false,
    workspaceExists: true,
    candidateSurfaces: ["surface-new", "surface-new"],
  });
  assert.deepEqual(d, { action: "rematch", surfaceId: "surface-new" });
});

test("ambiguous: two live candidates re-stamp NOTHING (fail closed)", () => {
  const d = decideSelfHeal({
    surfaceLive: false,
    workspaceExists: true,
    candidateSurfaces: ["surface-a", "surface-b"],
  });
  assert.deepEqual(d, { action: "unresolved", reason: "ambiguous match" });
});

test("workspace gone: surface unfindable AND workspace closed → unresolved (drop + warn)", () => {
  const d = decideSelfHeal({ surfaceLive: false, workspaceExists: false, candidateSurfaces: [] });
  assert.deepEqual(d, { action: "unresolved", reason: "workspace gone" });
});

test("workspace alive but no live session in it → unresolved (drop + warn)", () => {
  const d = decideSelfHeal({ surfaceLive: false, workspaceExists: true, candidateSurfaces: [] });
  assert.deepEqual(d, { action: "unresolved", reason: "no live session in workspace" });
});
