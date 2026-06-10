// Unit tests for the restart-proof reconcile decision matrix (pure; no cmux).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planReconcile, type ReconcileCandidate } from "./resume.js";
import { parseHookSessions } from "../cmux-sessions.js";

const DURABLE = parseHookSessions(
  JSON.stringify({
    version: 1,
    activeSessionsByWorkspace: { "WS-GONE": { sessionId: "sess-r" } },
    sessions: {
      "sess-r": {
        sessionId: "sess-r",
        workspaceId: "WS-GONE",
        surfaceId: "SURF-GONE",
        cwd: "/repo/wt-r",
        isRestorable: true,
        agentLifecycle: "idle",
        launchCommand: { arguments: ["claude", "--model", "opus"] },
      },
      "sess-nr": {
        sessionId: "sess-nr",
        workspaceId: "WS-NR",
        cwd: "/repo/wt-nr",
        isRestorable: false,
      },
    },
  }),
)!;

function cand(over: Partial<ReconcileCandidate>): ReconcileCandidate {
  return { agentId: "a1", label: "worker", alive: false, cwds: [], ...over };
}

test("matrix: registered + alive → keep (durable map not even consulted)", () => {
  const [d] = planReconcile([cand({ alive: true, workspaceId: "WS-GONE" })], DURABLE);
  assert.equal(d?.action, "keep");
});

test("matrix: registered + gone + restorable trace → resume with the exact invocation", () => {
  const [d] = planReconcile([cand({ surfaceId: "SURF-GONE" })], DURABLE);
  assert.equal(d?.action, "resume");
  if (d?.action === "resume") {
    assert.equal(d.sessionId, "sess-r");
    assert.equal(d.command, "claude --model opus --resume sess-r");
    assert.equal(d.cwd, "/repo/wt-r");
    assert.equal(d.restorable, true);
  }
});

test("matrix: gone workers trace by workspaceId or unique cwd too", () => {
  assert.equal(planReconcile([cand({ workspaceId: "WS-GONE" })], DURABLE)[0]?.action, "resume");
  assert.equal(planReconcile([cand({ cwds: ["/repo/wt-r"] })], DURABLE)[0]?.action, "resume");
});

test("matrix: a trace cmux marks not-restorable still resumes (flag is a display caveat — verified live: a RUNNING node-backed worker carries isRestorable:false)", () => {
  const [d] = planReconcile([cand({ workspaceId: "WS-NR" })], DURABLE);
  assert.equal(d?.action, "resume");
  if (d?.action === "resume") {
    assert.equal(d.restorable, false);
    assert.equal(d.command, "claude --resume sess-nr");
  }
});

test("matrix: registered + gone + untraceable → prune with a clear note", () => {
  const [d] = planReconcile([cand({ workspaceId: "WS-NEVER", cwds: ["/elsewhere"] })], DURABLE);
  assert.equal(d?.action, "prune");
  if (d?.action === "prune") assert.match(d.note, /no trace/);
});

test("matrix: no durable file at all → gone workers prune exactly as before", () => {
  const decisions = planReconcile(
    [cand({ alive: true }), cand({ agentId: "a2", workspaceId: "WS-GONE" })],
    undefined,
  );
  assert.equal(decisions[0]?.action, "keep");
  assert.equal(decisions[1]?.action, "prune");
});

test("matrix: unregistered durable sessions produce no decisions (one per candidate)", () => {
  const decisions = planReconcile([cand({ surfaceId: "SURF-GONE" })], DURABLE);
  assert.equal(decisions.length, 1); // sess-nr exists in the map but is nobody's
});
