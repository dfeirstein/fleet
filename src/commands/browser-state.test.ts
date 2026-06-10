// Unit tests for the browser-state path policy (pure; the cmux state verbs
// verify by typecheck + manual smoke). The security invariant: state files are
// live session cookies and must never be writable into a git repo/worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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
  // Real dirs (the walk-up probe uses existsSync), fake detector keyed on them.
  const base = mkdtempSync(join(tmpdir(), "bs-fake-repo-"));
  const free = mkdtempSync(join(tmpdir(), "bs-fake-free-"));
  const inRepo = (d: string) => (d.startsWith(base) ? base : undefined);
  assert.throws(() => assertOutsideRepo(join(base, "app", ".states"), inRepo), /refusing to write session cookies/);
  assert.doesNotThrow(() => assertOutsideRepo(free, inRepo));
});

test("assertOutsideRepo rejects even $HOME-as-a-dotfiles-repo", () => {
  const home = mkdtempSync(join(tmpdir(), "bs-fake-home-"));
  const homeRepo = () => home; // everything is inside the repo
  assert.throws(() => assertOutsideRepo(join(home, ".fleet", "browser-states"), homeRepo), /refusing/);
});

test("B1 regression (REAL git): a NOT-YET-CREATED subdir of a repo still refuses", () => {
  // The first-save path: the states dir doesn't exist yet, and `git -C
  // <nonexistent>` exits 128 → repoRoot returns undefined → without the
  // walk-up-to-existing-ancestor fix the check passed vacuously and live
  // cookies could land inside a dotfiles repo. Uses the REAL detector.
  const repo = mkdtempSync(join(tmpdir(), "bs-real-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  assert.throws(() => assertOutsideRepo(join(repo, ".fleet", "browser-states")), /refusing to write session cookies/);
  // Same shape outside any repo: a nonexistent nested dir is fine.
  const plain = mkdtempSync(join(tmpdir(), "bs-real-plain-"));
  assert.doesNotThrow(() => assertOutsideRepo(join(plain, ".fleet", "browser-states")));
});
