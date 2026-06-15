import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./matcher.js";

function bash(command: string) {
  return evaluate({ tool_name: "Bash", tool_input: { command } });
}
function write(file_path: string) {
  return evaluate({ tool_name: "Write", tool_input: { file_path } });
}

// ---------------------------------------------------------------------------
// BLOCK — the unambiguous catastrophic patterns must be caught.
// ---------------------------------------------------------------------------

test("BLOCK: git push --force to main", () => {
  assert.equal(bash("git push --force origin main").block, true);
});
test("BLOCK: git push -f origin main", () => {
  assert.equal(bash("git push -f origin main").block, true);
});
test("BLOCK: git push --force-with-lease origin main", () => {
  assert.equal(bash("git push --force-with-lease origin main").block, true);
});
test("BLOCK: rm -rf $HOME", () => {
  assert.equal(bash("rm -rf $HOME").block, true);
});
test("BLOCK: rm -rf ~", () => {
  assert.equal(bash("rm -rf ~").block, true);
});
test("BLOCK: rm -rf /", () => {
  assert.equal(bash("rm -rf /").block, true);
});
test("BLOCK: rm -fr / (flag order swapped)", () => {
  assert.equal(bash("rm -fr /").block, true);
});
test("BLOCK: DROP DATABASE", () => {
  assert.equal(bash('psql -c "DROP DATABASE prod"').block, true);
});
test("BLOCK: DROP TABLE (case-insensitive)", () => {
  assert.equal(bash('mysql -e "drop table users"').block, true);
});
test("BLOCK: TRUNCATE", () => {
  assert.equal(bash('psql -c "TRUNCATE TABLE orders"').block, true);
});
test("BLOCK: git reset --hard origin/main", () => {
  assert.equal(bash("git reset --hard origin/main").block, true);
});
test("BLOCK: shell redirect into .env", () => {
  assert.equal(bash("echo SECRET=1 > .env").block, true);
});
test("BLOCK: Write to .env", () => {
  assert.equal(write("/repo/.env").block, true);
});
test("BLOCK: Write to id_rsa", () => {
  assert.equal(write("/Users/x/.ssh/id_rsa").block, true);
});
test("BLOCK: Write to a .pem file", () => {
  assert.equal(write("/repo/certs/server.pem").block, true);
});
test("BLOCK: Write to an aws-credentials file", () => {
  assert.equal(write("/repo/aws-credentials.json").block, true);
});

// ---------------------------------------------------------------------------
// BLOCK — cross-model (Codex) adversarial pass: 11 closed detection gaps.
// ---------------------------------------------------------------------------

test("BLOCK gap1: force-push via + refspec (+HEAD:main)", () => {
  assert.equal(bash("git push origin +HEAD:main").block, true);
});
test("BLOCK gap1: force-push via + refspec (+main)", () => {
  assert.equal(bash("git push origin +main").block, true);
});
test("BLOCK gap1: force-push via + refspec (+refs/heads/main)", () => {
  assert.equal(bash("git push origin +refs/heads/main").block, true);
});
test("BLOCK gap2: git -C repo push --force origin main", () => {
  assert.equal(bash("git -C repo push --force origin main").block, true);
});
test("BLOCK gap2: git -c push.default=current push --force origin main", () => {
  assert.equal(bash("git -c push.default=current push --force origin main").block, true);
});
test("BLOCK gap3: rm -rf \"$HOME\" (double-quoted)", () => {
  assert.equal(bash('rm -rf "$HOME"').block, true);
});
test("BLOCK gap3: rm -rf '~' (single-quoted)", () => {
  assert.equal(bash("rm -rf '~'").block, true);
});
test("BLOCK gap3: rm -rf \"/\" (quoted root)", () => {
  assert.equal(bash('rm -rf "/"').block, true);
});
test("BLOCK gap3: rm -rf \"${HOME}\" (braced var)", () => {
  assert.equal(bash('rm -rf "${HOME}"').block, true);
});
test("BLOCK gap4: rm -rf $HOME/* (home glob)", () => {
  assert.equal(bash("rm -rf $HOME/*").block, true);
});
test("BLOCK gap4: rm -rf ~/* (home glob)", () => {
  assert.equal(bash("rm -rf ~/*").block, true);
});
test("BLOCK gap4: rm -rf $HOME/ (trailing slash)", () => {
  assert.equal(bash("rm -rf $HOME/").block, true);
});
test("BLOCK gap4: rm -rf \"${HOME}\"/* (quoted braced home glob)", () => {
  assert.equal(bash('rm -rf "${HOME}"/*').block, true);
});
test("BLOCK gap6: git reset --hard upstream/main (non-origin remote)", () => {
  assert.equal(bash("git reset --hard upstream/main").block, true);
});
test("BLOCK gap7: git -C repo reset --hard origin/main (global opt)", () => {
  assert.equal(bash("git -C repo reset --hard origin/main").block, true);
});
test("BLOCK gap8: second redirect target is a secret (cmd > log > .env)", () => {
  assert.equal(bash("dump > log > .env").block, true);
});
test("BLOCK gap9: single-quoted redirect target (echo x > '.env')", () => {
  assert.equal(bash("echo x > '.env'").block, true);
});
test("BLOCK gap10: SQL comment between keywords (DROP /*x*/ TABLE)", () => {
  assert.equal(bash('psql -c "DROP /*x*/ TABLE orders"').block, true);
});
test("BLOCK gap11: case-insensitive secret path (server.PEM)", () => {
  assert.equal(write("/repo/certs/server.PEM").block, true);
});
test("BLOCK gap11: case-insensitive secret path (.ENV.local)", () => {
  assert.equal(write("/repo/.ENV.local").block, true);
});

// ---------------------------------------------------------------------------
// ALLOW — false-positive guards for the cross-model pass (MUST stay block:false).
// ---------------------------------------------------------------------------

test("ALLOW: git reset --hard feature/foo (local branch with slash)", () => {
  assert.equal(bash("git reset --hard feature/foo").block, false);
});
test("ALLOW: rm -rf ~/project/dist (named home subpath)", () => {
  assert.equal(bash("rm -rf ~/project/dist").block, false);
});
test("ALLOW: rm -rf $HOME/project/dist (named home subpath)", () => {
  assert.equal(bash("rm -rf $HOME/project/dist").block, false);
});
test("ALLOW: git push origin develop (non-force, non-main)", () => {
  assert.equal(bash("git push origin develop").block, false);
});
test("ALLOW: git push origin feature (no force)", () => {
  assert.equal(bash("git push origin feature").block, false);
});
test("ALLOW: write .env.EXAMPLE (case-insensitive template)", () => {
  assert.equal(write("/repo/.env.EXAMPLE").block, false);
});
test("ALLOW: truncate -s 0 bigfile.log (Unix truncate, not SQL)", () => {
  assert.equal(bash("truncate -s 0 bigfile.log").block, false);
});

// Each block carries a non-empty reason.
test("a blocked decision carries a reason", () => {
  const d = bash("git push --force origin main");
  assert.equal(d.block, true);
  if (d.block) assert.ok(d.reason.length > 0);
});

// ---------------------------------------------------------------------------
// ALLOW — normal dev must sail through (false-positives are the real cost).
// ---------------------------------------------------------------------------

test("ALLOW: git push to a feature branch", () => {
  assert.equal(bash("git push origin feature").block, false);
});
test("ALLOW: git push --force to a feature branch (not main)", () => {
  assert.equal(bash("git push --force origin my-feature").block, false);
});
test("ALLOW: ordinary git push", () => {
  assert.equal(bash("git push").block, false);
});
test("ALLOW: rm -rf of a local build dir", () => {
  assert.equal(bash("rm -rf ./build").block, false);
});
test("ALLOW: rm -rf of node_modules", () => {
  assert.equal(bash("rm -rf node_modules").block, false);
});
test("ALLOW: rm -rf of a home subpath (not bare ~)", () => {
  assert.equal(bash("rm -rf ~/project/dist").block, false);
});
test("ALLOW: a normal SELECT", () => {
  assert.equal(bash('psql -c "SELECT * FROM users LIMIT 10"').block, false);
});
test("ALLOW: a SQL UPDATE (out of scope for this starter)", () => {
  assert.equal(bash('psql -c "UPDATE users SET active = true"').block, false);
});
test("ALLOW: git reset --hard HEAD (local)", () => {
  assert.equal(bash("git reset --hard HEAD~1").block, false);
});
test("ALLOW: writing a normal config file", () => {
  assert.equal(write("/repo/src/config.ts").block, false);
});
test("ALLOW: writing .env.example", () => {
  // .env.example is a template, not a secret — must not be blocked.
  assert.equal(write("/repo/.env.example").block, false);
});
test("ALLOW: a normal echo", () => {
  assert.equal(bash('echo "hello world"').block, false);
});
test("ALLOW: npm run typecheck", () => {
  assert.equal(bash("npm run typecheck").block, false);
});
test("ALLOW: unknown tool with no command", () => {
  assert.equal(evaluate({ tool_name: "Read", tool_input: { file_path: "/repo/.env" } }).block, false);
});
