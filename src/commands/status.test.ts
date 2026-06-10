// Unit tests for the live-status classification precedence (B1) — the pure
// core of snapshot(). A live `running` probe must beat any turn-end
// notification; sibling-pane notifications must not be attributable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLive, prefetchFromSnapshot } from "./status.js";
import { indexNotifications, notificationFor, type CmuxNotification } from "../notifications.js";

const DISPATCH = "2026-06-09T05:00:00Z";
const freshTurnEnd: CmuxNotification = {
  workspace_id: "W",
  surface_id: "S-A",
  subtitle: "Completed in repo",
  created_at: "2026-06-09T05:05:00Z",
};

test("classifyLive: probe running beats a fresh turn-end notification (B1)", () => {
  const status = classifyLive({
    probe: "running",
    hasBlock: false,
    notif: freshTurnEnd,
    lastDispatchAt: DISPATCH,
  });
  assert.equal(status, "running");
});

test("classifyLive: turn-end notification marks a quiet screen idle", () => {
  for (const probe of ["unknown", "idle"] as const) {
    const status = classifyLive({ probe, hasBlock: false, notif: freshTurnEnd, lastDispatchAt: DISPATCH });
    assert.equal(status, "idle");
  }
});

test("classifyLive: screen rate-limit/error and feed blocks keep their precedence", () => {
  assert.equal(classifyLive({ probe: "rate-limited", hasBlock: false, notif: freshTurnEnd, lastDispatchAt: DISPATCH }), "rate-limited");
  assert.equal(classifyLive({ probe: "error", hasBlock: false, notif: freshTurnEnd, lastDispatchAt: DISPATCH }), "error");
  assert.equal(classifyLive({ probe: "running", hasBlock: true, notif: freshTurnEnd, lastDispatchAt: DISPATCH }), "blocked-on-you");
  assert.equal(classifyLive({ probe: "awaiting-input", hasBlock: false, notif: freshTurnEnd, lastDispatchAt: DISPATCH }), "awaiting-input");
});

test("classifyLive: a current-turn done-signal upgrades an ambiguous screen to authoritative idle (P2b)", () => {
  // No notification, screen reads unknown/idle — inference alone would leave
  // "unknown" active forever; the gate-verified done-signal resolves it.
  for (const probe of ["unknown", "idle"] as const) {
    const status = classifyLive({ probe, hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: true });
    assert.equal(status, "idle");
  }
});

test("classifyLive: live screen evidence still beats the done-signal (layers under B1/B4)", () => {
  assert.equal(classifyLive({ probe: "running", hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: true }), "running");
  assert.equal(classifyLive({ probe: "awaiting-input", hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: true }), "awaiting-input");
  assert.equal(classifyLive({ probe: "error", hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: true }), "error");
  assert.equal(classifyLive({ probe: "unknown", hasBlock: true, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: true }), "blocked-on-you");
});

test("classifyLive: without a done-signal, inference is unchanged (workers that never call fleet done)", () => {
  assert.equal(classifyLive({ probe: "unknown", hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH, doneSignal: false }), "unknown");
  assert.equal(classifyLive({ probe: "unknown", hasBlock: false, notif: undefined, lastDispatchAt: DISPATCH }), "unknown");
});

// ── Snapshot-first prefetch (one-RPC sidebar snapshot) ──────────────────────
// The snapshot is an OPTIMIZATION of how data is fetched, not a classification
// input: `exists` may only ever be `true` (positively listed) or `undefined`
// (caller falls back to the live existence check) — never `false`.

const SIDEBAR = new Map([
  [
    "WS-1",
    {
      id: "WS-1",
      ref: "workspace:4",
      listeningPorts: [":3000"],
      pullRequestUrls: ["https://github.com/o/r/pull/7"],
      gitBranches: ["fleet/x"],
      latestConversationMessage: "done",
    },
  ],
]);

test("prefetchFromSnapshot: a listed workspace maps existence + ports + PR URLs", () => {
  const pre = prefetchFromSnapshot("WS-1", SIDEBAR);
  assert.equal(pre.exists, true);
  assert.deepEqual(pre.ports, [":3000"]);
  assert.deepEqual(pre.prUrls, ["https://github.com/o/r/pull/7"]);
});

test("prefetchFromSnapshot: a workspace ABSENT from the snapshot defers (never 'dead')", () => {
  // The RPC may be scoped to one window — absence must route the caller to the
  // live existence check, not to a death verdict.
  const pre = prefetchFromSnapshot("WS-OTHER-WINDOW", SIDEBAR);
  assert.equal(pre.exists, undefined);
  assert.deepEqual(pre.ports, []);
  assert.deepEqual(pre.prUrls, []);
});

test("prefetchFromSnapshot: capability-gated off (no snapshot) → full fallback", () => {
  assert.equal(prefetchFromSnapshot("WS-1", undefined).exists, undefined);
});

test("prefetchFromSnapshot: a worker with no workspace UUID keeps the legacy path", () => {
  assert.equal(prefetchFromSnapshot(undefined, SIDEBAR).exists, undefined);
});

test("sibling notification misattribution no longer flips a running worker (B1, end-to-end)", () => {
  // Workers A (running) and B share workspace W; B emits "Completed".
  const idx = indexNotifications([
    { workspace_id: "W", surface_id: "S-B", subtitle: "Completed in repo", created_at: "2026-06-09T05:05:00Z" },
  ]);
  const notifForA = notificationFor(idx, "S-A", "W");
  assert.equal(notifForA, undefined); // not attributable to A at all
  // Even with a momentarily indeterminate screen, A must not classify idle.
  assert.equal(classifyLive({ probe: "unknown", hasBlock: false, notif: notifForA, lastDispatchAt: DISPATCH }), "unknown");
  // And with a live spinner, A stays running regardless.
  assert.equal(classifyLive({ probe: "running", hasBlock: false, notif: notifForA, lastDispatchAt: DISPATCH }), "running");
});
