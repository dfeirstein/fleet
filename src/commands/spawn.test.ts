// Unit tests for the worker launch line shared by spawn and grid: the
// FLEET_SESSION/FLEET_AGENT_ID env exports and the proof instruction must
// render correctly (B3 — grid bakes the task into this line, so a quoting bug
// would silently mangle every grid brief). Run with `npm test`.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerLaunchCommand, proofInstruction } from "./spawn.js";

// Pin the session so sessionId() is deterministic (it prefers FLEET_SESSION).
beforeEach(() => {
  process.env.FLEET_SESSION = "test-sess";
});
afterEach(() => {
  delete process.env.FLEET_SESSION;
});

test("launch line exports the autocompact backstop + FLEET_SESSION + FLEET_AGENT_ID ahead of claude (spawn shape: no task)", () => {
  const line = buildWorkerLaunchCommand("abcd1234", "opus", "", false, "auto");
  assert.match(
    line,
    /^CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=\d+ FLEET_SESSION='test-sess' FLEET_AGENT_ID=abcd1234 claude --permission-mode auto --model opus$/,
  );
});

test("launch line carries CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (process-env backstop the daemon can't set for the pane)", () => {
  const line = buildWorkerLaunchCommand("abcd1234", "opus", "", false, "auto");
  // First token: the env var only takes effect when set at claude launch.
  assert.match(line, /^CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=\d+ /);
});

test("grid shape: task + proof instruction baked into the launch line, single-quoted", () => {
  const task = `do the thing\n\n${proofInstruction("abcd1234")}`;
  const line = buildWorkerLaunchCommand("abcd1234", "opus", task, true, "yolo");
  assert.match(line, /^CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=\d+ FLEET_SESSION='test-sess' FLEET_AGENT_ID=abcd1234 claude --dangerously-skip-permissions/);
  assert.match(line, /fleet done abcd1234 --proof/);
  // The instruction's embedded apostrophes survive POSIX single-quoting:
  // ' becomes '\'' inside the quoted task positional.
  assert.ok(line.includes("test:'\\''<command that verifies your work>'\\''"));
  // The task positional is the last token and is fully quoted (opens and closes).
  assert.ok(line.endsWith("'"));
});

test("proofInstruction names the concrete agent id and the note: caveat", () => {
  const note = proofInstruction("beef0001");
  assert.match(note, /fleet done beef0001 --proof test:/);
  assert.match(note, /metadata only and never satisfies the gate/);
  assert.match(note, /FLEET_SESSION and FLEET_AGENT_ID are exported/);
});
