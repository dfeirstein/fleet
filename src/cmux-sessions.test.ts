// Unit tests for the durable hook-sessions reader (pure logic; no filesystem).
// The fixture mirrors the REAL file shape captured live (cmux 0.64.12, 2026-06-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHookSessions,
  findSession,
  resumeCommand,
  lifecycleHint,
  workstreamKeys,
  RUNNING_FRESH_MS,
  type DurableSession,
} from "./cmux-sessions.js";

const REAL_SHAPE = JSON.stringify({
  version: 1,
  activeSessionsByWorkspace: {
    "WS-1": { allowsNewSessionReplacement: true, sessionId: "sess-aaa", updatedAt: 1780667471.8 },
    "WS-BAD": "not-an-object",
  },
  sessions: {
    "sess-aaa": {
      agentLifecycle: "needsInput",
      cwd: "/repo/worktree-a",
      isRestorable: true,
      launchCommand: {
        arguments: ["/usr/local/bin/claude", "--permission-mode", "auto", "--model", "opus"],
        executablePath: "/usr/local/bin/claude",
      },
      pid: 123,
      sessionId: "sess-aaa",
      surfaceId: "SURF-A",
      updatedAt: 1780535386.2,
      workspaceId: "WS-1",
    },
    "sess-bbb": {
      agentLifecycle: "running",
      cwd: "/repo/shared",
      sessionId: "sess-bbb",
      workspaceId: "WS-2",
      updatedAt: 1780535000,
    },
    "sess-ccc": {
      agentLifecycle: "made-up-state", // unknown lifecycle → dropped field, entry kept
      cwd: "/repo/shared", // same cwd as bbb → ambiguous for cwd matching
      sessionId: "sess-ccc",
    },
    "sess-bad": 42, // not an object → skipped entirely
  },
});

test("parseHookSessions: real-shaped document parses with per-entry validation", () => {
  const map = parseHookSessions(REAL_SHAPE);
  assert.ok(map);
  assert.equal(map.sessions.length, 3); // sess-bad skipped
  const a = map.sessions.find((s) => s.sessionId === "sess-aaa");
  assert.equal(a?.workspaceId, "WS-1");
  assert.equal(a?.surfaceId, "SURF-A");
  assert.equal(a?.agentLifecycle, "needsInput");
  assert.equal(a?.isRestorable, true);
  assert.deepEqual(a?.launchArgs, ["/usr/local/bin/claude", "--permission-mode", "auto", "--model", "opus"]);
  const c = map.sessions.find((s) => s.sessionId === "sess-ccc");
  assert.equal(c?.agentLifecycle, undefined); // unrecognized state dropped
  // active index parsed; the malformed workspace entry skipped
  assert.equal(map.activeSessionByWorkspace.get("WS-1"), "sess-aaa");
  assert.equal(map.activeSessionByWorkspace.has("WS-BAD"), false);
});

test("parseHookSessions: corrupt / wrong-shape documents → undefined (tolerated)", () => {
  assert.equal(parseHookSessions("{ torn json"), undefined);
  assert.equal(parseHookSessions("null"), undefined);
  assert.equal(parseHookSessions('"a string"'), undefined);
  assert.equal(parseHookSessions("[1,2,3]"), undefined);
});

test("parseHookSessions: missing sections → empty result, not a crash", () => {
  const map = parseHookSessions("{}");
  assert.ok(map);
  assert.equal(map.sessions.length, 0);
  assert.equal(map.activeSessionByWorkspace.size, 0);
});

test("findSession: surfaceId beats workspaceId beats cwd; ambiguous cwd is no match", () => {
  const map = parseHookSessions(REAL_SHAPE)!;
  assert.equal(findSession(map, { surfaceId: "SURF-A" })?.sessionId, "sess-aaa");
  // workspaceId via the active-session index
  assert.equal(findSession(map, { workspaceId: "WS-1" })?.sessionId, "sess-aaa");
  // workspaceId via the per-session field (WS-2 not in the active index)
  assert.equal(findSession(map, { workspaceId: "WS-2" })?.sessionId, "sess-bbb");
  // unique cwd matches
  assert.equal(findSession(map, { cwds: ["/repo/worktree-a"] })?.sessionId, "sess-aaa");
  // two sessions share /repo/shared → ambiguous → undefined
  assert.equal(findSession(map, { cwds: ["/repo/shared"] }), undefined);
  assert.equal(findSession(map, { surfaceId: "nope", workspaceId: "nope", cwds: ["/nope"] }), undefined);
});

test("resumeCommand: captured argv + --resume, stale --resume stripped, args quoted", () => {
  const map = parseHookSessions(REAL_SHAPE)!;
  const a = map.sessions.find((s) => s.sessionId === "sess-aaa")!;
  assert.equal(
    resumeCommand(a),
    "/usr/local/bin/claude --permission-mode auto --model opus --resume sess-aaa",
  );
  // no captured argv → bare claude
  assert.equal(resumeCommand({ sessionId: "x" }), "claude --resume x");
  // a captured launch that was itself a resume doesn't double up
  assert.equal(
    resumeCommand({ sessionId: "new", launchArgs: ["claude", "--resume", "old", "--model", "opus"] }),
    "claude --model opus --resume new",
  );
  // shell-unsafe args get quoted
  assert.equal(
    resumeCommand({ sessionId: "x", launchArgs: ["claude", "--append-system-prompt", "be careful; rm nothing"] }),
    "claude --append-system-prompt 'be careful; rm nothing' --resume x",
  );
});

test("lifecycleHint: idle/needsInput map regardless of age; running only while fresh", () => {
  const nowMs = 2_000_000_000_000;
  const at = (agoMs: number) => (nowMs - agoMs) / 1000; // updatedAt is epoch seconds
  const s = (over: Partial<DurableSession>): DurableSession => ({ sessionId: "s", ...over });
  assert.equal(lifecycleHint(s({ agentLifecycle: "idle", updatedAt: at(999_999_999) }), nowMs), "idle");
  assert.equal(lifecycleHint(s({ agentLifecycle: "needsInput", updatedAt: at(999_999_999) }), nowMs), "awaiting-input");
  assert.equal(lifecycleHint(s({ agentLifecycle: "running", updatedAt: at(RUNNING_FRESH_MS - 1000) }), nowMs), "running");
  // running self-refreshes — a stale "running" means NOT running → no hint
  assert.equal(lifecycleHint(s({ agentLifecycle: "running", updatedAt: at(RUNNING_FRESH_MS + 1000) }), nowMs), undefined);
  assert.equal(lifecycleHint(s({ agentLifecycle: "running" }), nowMs), undefined); // no timestamp → don't trust
  assert.equal(lifecycleHint(s({}), nowMs), undefined);
});

test("workstreamKeys: durable bare uuid maps to both bare and claude-prefixed stream keys", () => {
  assert.deepEqual(workstreamKeys("abc-123"), ["abc-123", "claude-abc-123"]);
  assert.deepEqual(workstreamKeys("claude-abc-123"), ["claude-abc-123"]);
});
