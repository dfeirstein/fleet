// Unit tests for the browser-state path policy (pure; the cmux state verbs
// verify by typecheck + manual smoke). The security invariant: state files are
// live session cookies and must never be writable into a git repo/worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { statePathFor, assertOutsideRepo } from "./browser-state.js";

test("statePathFor slugs the project name into ~/.fleet/browser-states", () => {
  assert.equal(statePathFor("myapp", "/base"), join("/base", "myapp.json"));
  assert.equal(statePathFor("My App (staging)!", "/base"), join("/base", "my-app-staging.json"));
});

test("statePathFor refuses path-shaped names (project is a NAME, not a path)", () => {
  // Separators are slugged away — no traversal out of the states dir.
  assert.equal(statePathFor("../evil", "/base"), join("/base", "evil.json"));
  assert.equal(statePathFor("a/b", "/base"), join("/base", "a-b.json"));
  assert.throws(() => statePathFor("///", "/base"), /invalid project name/);
});

test("assertOutsideRepo rejects any dir inside a git repo/worktree (fail closed)", () => {
  const inRepo = (d: string) => (d.startsWith("/home/u/code") ? "/home/u/code" : undefined);
  assert.throws(() => assertOutsideRepo("/home/u/code/app/.states", inRepo), /refusing to write session cookies/);
  assert.doesNotThrow(() => assertOutsideRepo("/home/u/.fleet/browser-states", inRepo));
});

test("assertOutsideRepo rejects even $HOME-as-a-dotfiles-repo", () => {
  const homeRepo = () => "/home/u"; // everything is inside the repo
  assert.throws(() => assertOutsideRepo("/home/u/.fleet/browser-states", homeRepo), /refusing/);
});
