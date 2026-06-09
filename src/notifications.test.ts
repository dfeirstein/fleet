// Unit tests for notification attribution + turn-end matching (B1/S6).
// Run with `npm test` (node:test via tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexNotifications,
  notificationFor,
  turnEnded,
  type CmuxNotification,
} from "./notifications.js";

const completed = (over: Partial<CmuxNotification>): CmuxNotification => ({
  title: "Claude Code",
  subtitle: "Completed in repo",
  created_at: "2026-06-09T05:00:10Z",
  ...over,
});

test("notificationFor: surface-keyed — a sibling pane's turn-end is NOT attributed to this worker (B1)", () => {
  // Workers A and B share workspace W as split panes; B finishes a turn.
  const idx = indexNotifications([completed({ workspace_id: "W", surface_id: "S-B" })]);
  assert.equal(notificationFor(idx, "S-A", "W"), undefined); // A sees nothing
  assert.equal(notificationFor(idx, "S-B", "W")?.surface_id, "S-B"); // B sees its own
});

test("notificationFor: falls back to workspace only when the notification has no surface", () => {
  const idx = indexNotifications([completed({ workspace_id: "W" })]); // surfaceless
  assert.equal(notificationFor(idx, "S-A", "W")?.workspace_id, "W");
  assert.equal(notificationFor(idx, undefined, "W")?.workspace_id, "W");
  assert.equal(notificationFor(idx, "S-A", "OTHER"), undefined);
});

test("indexNotifications: newest per key wins", () => {
  const idx = indexNotifications([
    completed({ surface_id: "S", subtitle: "Completed in old", created_at: "2026-06-09T05:00:00Z" }),
    completed({ surface_id: "S", subtitle: "Completed in new", created_at: "2026-06-09T05:00:30Z" }),
  ]);
  assert.equal(idx.bySurface.get("S")?.subtitle, "Completed in new");
});

test("turnEnded: requires the notification to be STRICTLY newer than the dispatch (S6)", () => {
  const dispatch = "2026-06-09T05:00:10Z";
  assert.equal(turnEnded(completed({ created_at: "2026-06-09T05:00:11Z" }), dispatch), true);
  assert.equal(turnEnded(completed({ created_at: dispatch }), dispatch), false); // same instant
  // Up-to-1.5s-older used to pass under the old skew tolerance — must not now.
  assert.equal(turnEnded(completed({ created_at: "2026-06-09T05:00:09Z" }), dispatch), false);
});

test("turnEnded: non-turn-end text never matches", () => {
  const n = completed({ subtitle: "Running tests", body: "" , created_at: "2026-06-09T05:00:11Z"});
  assert.equal(turnEnded(n, "2026-06-09T05:00:10Z"), false);
});
