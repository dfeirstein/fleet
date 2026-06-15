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
