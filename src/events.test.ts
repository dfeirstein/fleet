// Unit tests for the event classifier + reactor (pure logic; no cmux).
// Run with `npm test` (node:test via tsx). Fixtures are the real frame shapes
// captured against cmux 0.64.12 (92) — see docs/PLAN-event-driven-and-proof-gate.md §1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frameToSignal,
  pendingBlocks,
  FleetEventReactor,
  type FeedItem,
  type CmuxNotification,
} from "./events.js";

// `latestByWorkspace`-shaped notification record (subset we classify on).
type Notif = { workspace_id?: string; subtitle?: string; body?: string; created_at?: string };

test("frameToSignal: agent.hook.PreToolUse → running", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "agent", name: "agent.hook.PreToolUse", workspace_id: "W1", seq: 10 },
  });
  assert.equal(sig.status, "running");
});

test("frameToSignal: category sidebar → ignored", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "sidebar", name: "sidebar.metadata.updated", workspace_id: null },
  });
  assert.equal(sig.ignore, true);
  assert.equal(sig.status, undefined);
});

test("frameToSignal: category workspace (focus) → ignored", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "workspace", name: "workspace.selected" },
  });
  assert.equal(sig.ignore, true);
});

test("frameToSignal: feed event frame → running + enrich:feed", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "feed", name: "feed.item.received", workspace_id: "W1" },
  });
  assert.equal(sig.status, "running");
  assert.equal(sig.enrich, "feed");
});

test("frameToSignal: notification event frame → enrich:notification", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "notification", name: "notification.created", workspace_id: "W1" },
  });
  assert.equal(sig.enrich, "notification");
});

test("frameToSignal: agent.hook.Stop → idle (bonus accelerator)", () => {
  const sig = frameToSignal({
    type: "event",
    frame: { type: "event", category: "agent", name: "agent.hook.Stop", workspace_id: "W1" },
  });
  assert.equal(sig.status, "idle");
});

test("frameToSignal: feed pending question → blocked-on-you (with prompt hint)", () => {
  const item: FeedItem = {
    kind: "question",
    status: "pending",
    cwd: "/repo",
    workstream_id: "claude-abc",
    question_prompt: "Which database should we use?",
  };
  const sig = frameToSignal({ type: "feed", item });
  assert.equal(sig.status, "blocked-on-you");
  assert.equal(sig.blocked?.kind, "question");
  assert.equal(sig.blocked?.promptHint, "Which database should we use?");
});

test("frameToSignal: feed pending permission/plan → blocked-on-you with that kind", () => {
  assert.equal(frameToSignal({ type: "feed", item: { kind: "permission", status: "pending" } }).blocked?.kind, "permission");
  assert.equal(frameToSignal({ type: "feed", item: { kind: "exitPlan", status: "pending" } }).blocked?.kind, "plan");
  assert.equal(frameToSignal({ type: "feed", item: { kind: "plan", status: "pending" } }).blocked?.kind, "plan");
});

test("frameToSignal: feed kind:stop → idle", () => {
  assert.equal(frameToSignal({ type: "feed", item: { kind: "stop", status: "telemetry" } }).status, "idle");
});

test("frameToSignal: feed telemetry toolUse → running (not blocked)", () => {
  const sig = frameToSignal({ type: "feed", item: { kind: "toolUse", status: "telemetry" } });
  assert.equal(sig.status, "running");
  assert.equal(sig.blocked, undefined);
});

test("frameToSignal: notification 'Completed in <dir>' → idle", () => {
  const sig = frameToSignal({ type: "notification", notif: { subtitle: "Completed in fleet-ev", body: "" } });
  assert.equal(sig.status, "idle");
});

test("frameToSignal: notification 'Waiting' → idle (turn-end; NOT blocked — feed owns that)", () => {
  const sig = frameToSignal({ type: "notification", notif: { subtitle: "Waiting", body: "Claude is waiting for your input" } });
  assert.equal(sig.status, "idle");
});

test("pendingBlocks: filters to pending question/permission/plan only", () => {
  const items: FeedItem[] = [
    { kind: "toolUse", status: "telemetry" },
    { kind: "question", status: "pending", cwd: "/a", workstream_id: "claude-1" },
    { kind: "stop", status: "telemetry" },
    { kind: "permission", status: "expired" }, // not pending → excluded
  ];
  const blocks = pendingBlocks(items);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "question");
  assert.equal(blocks[0]?.cwd, "/a");
});

test("reactor: ack with resume.gap:true fires onGap exactly once", () => {
  let gaps = 0;
  const reactor = new FleetEventReactor({ onGap: () => gaps++ });
  reactor.handleAck({ type: "ack", resume: { gap: true, gap_reason: "older than retained log" } });
  assert.equal(gaps, 1);
  // A subsequent no-gap ack must not re-fire.
  reactor.handleAck({ type: "ack", resume: { gap: false } });
  assert.equal(gaps, 1);
});

test("reactor: PreToolUse drives a running transition once (deduped)", () => {
  const transitions: string[] = [];
  const reactor = new FleetEventReactor({
    onTransition: (ws, _prev, next) => transitions.push(`${ws}:${next.status}`),
    deps: { listNotifications: () => [], listFeedItems: () => [] },
  });
  const frame = { type: "event", category: "agent", name: "agent.hook.PreToolUse", workspace_id: "W1", seq: 1 } as const;
  assert.equal(reactor.handleFrame(frame), true);
  assert.equal(reactor.handleFrame({ ...frame, seq: 2 }), true); // still interesting, but no NEW transition
  assert.deepEqual(transitions, ["W1:running"]);
  assert.equal(reactor.getState("W1")?.status, "running");
});

test("reactor: learns session→workspace from agent frame, attributes a pending feed question", () => {
  const transitions: { ws: string; status: string }[] = [];
  const feed: FeedItem[] = [{ kind: "question", status: "pending", workstream_id: "claude-xyz", question_prompt: "Proceed?" }];
  const reactor = new FleetEventReactor({
    onTransition: (ws, _p, next) => transitions.push({ ws, status: next.status }),
    deps: { listNotifications: () => [], listFeedItems: () => feed },
  });
  // First an agent frame teaches the session↔workspace mapping.
  reactor.handleFrame({ type: "event", category: "agent", name: "agent.hook.PreToolUse", workspace_id: "WX", payload: { session_id: "claude-xyz" } });
  assert.equal(reactor.sessionWorkspace("claude-xyz"), "WX");
  // Then a feed frame (redacted) triggers an enrich that attributes the pending
  // question to WX via the learned map → blocked-on-you.
  reactor.handleFrame({ type: "event", category: "feed", name: "feed.item.received", workspace_id: null });
  assert.equal(reactor.getState("WX")?.status, "blocked-on-you");
  assert.equal(reactor.getState("WX")?.blocked?.kind, "question");
  assert.deepEqual(
    transitions.map((t) => t.status),
    ["running", "blocked-on-you"],
  );
});

test("reactor: notification 'Completed' enrich → idle transition", () => {
  const notifs: Notif[] = [{ workspace_id: "W9", subtitle: "Completed in repo", created_at: "2026-06-09T05:00:00Z" }];
  const reactor = new FleetEventReactor({ deps: { listNotifications: () => notifs as CmuxNotification[], listFeedItems: () => [] } });
  reactor.handleFrame({ type: "event", category: "notification", name: "notification.created", workspace_id: "W9" });
  assert.equal(reactor.getState("W9")?.status, "idle");
});

test("frameToSignal: feed pending permissionRequest (live 0.64.12 kind) → blocked-on-you permission", () => {
  const sig = frameToSignal({ type: "feed", item: { kind: "permissionRequest", status: "pending" } });
  assert.equal(sig.status, "blocked-on-you");
  assert.equal(sig.blocked?.kind, "permission");
});

// The durable file keys sessions by bare uuid; the stream keys them claude-<uuid>.
const durableMap = {
  sessions: [{ sessionId: "xyz", workspaceId: "W-WARM" }],
  activeSessionByWorkspace: new Map<string, string>(),
};

test("reactor: warmSessionMap closes the cold-map gap — feed item attributes with NO prior agent.hook", () => {
  const feed: FeedItem[] = [{ kind: "question", status: "pending", workstream_id: "claude-xyz", question_prompt: "Proceed?" }];
  const reactor = new FleetEventReactor({ deps: { listNotifications: () => [], listFeedItems: () => feed } });
  assert.equal(reactor.warmSessionMap(() => durableMap), 1);
  assert.equal(reactor.sessionWorkspace("claude-xyz"), "W-WARM"); // prefixed stream key seeded
  // A redacted feed frame arrives FIRST (the gap this fixes) → attributed via the seed.
  reactor.handleFrame({ type: "event", category: "feed", name: "feed.item.received", workspace_id: null });
  assert.equal(reactor.getState("W-WARM")?.status, "blocked-on-you");
});

test("reactor: a live agent.hook frame overrides a stale durable seed", () => {
  const reactor = new FleetEventReactor({ deps: { listNotifications: () => [], listFeedItems: () => [] } });
  reactor.warmSessionMap(() => durableMap);
  reactor.handleFrame({ type: "event", category: "agent", name: "agent.hook.PreToolUse", workspace_id: "W-LIVE", payload: { session_id: "claude-xyz" } });
  assert.equal(reactor.sessionWorkspace("claude-xyz"), "W-LIVE");
  // ...and re-warming after live learning must NOT clobber it back.
  assert.equal(reactor.warmSessionMap(() => durableMap), 0); // every key already known
  assert.equal(reactor.sessionWorkspace("claude-xyz"), "W-LIVE");
});

test("reactor: warmSessionMap tolerates a missing/corrupt durable file (no file → as today)", () => {
  const reactor = new FleetEventReactor({ deps: { listNotifications: () => [], listFeedItems: () => [] } });
  assert.equal(reactor.warmSessionMap(() => undefined), 0);
  assert.equal(
    reactor.warmSessionMap(() => {
      throw new Error("corrupt");
    }),
    0,
  );
});
