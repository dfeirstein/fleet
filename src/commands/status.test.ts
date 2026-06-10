// Unit tests for the live-status classification precedence (B1) — the pure
// core of snapshot(). A live `running` probe must beat any turn-end
// notification; sibling-pane notifications must not be attributable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLive } from "./status.js";
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
