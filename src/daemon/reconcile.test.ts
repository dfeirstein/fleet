// Seam tests for the IMPURE half of the self-heal pass (issue #39):
// reconcileLiveCaptains' orchestration — sibling-pane exclusion, the durable-map
// candidate build, and the warn-once / re-arm counter — none of which the pure
// decideSelfHeal tests reach. cmux + filesystem are injected via ReconcileDeps,
// so a mis-heal onto a sibling pane (the one real risk here) is caught without a
// live cmux. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileLiveCaptains, type ReconcileDeps } from "./loop.js";
import type { OrchestratorRecord } from "../orchestrator-record.js";
import type { DurableSessionMap, DurableSession } from "../cmux-sessions.js";
import type { SharedSettings } from "./config.js";

const SETTINGS = {} as SharedSettings; // unused — every test injects deps

function rec(over: Partial<OrchestratorRecord> = {}): OrchestratorRecord {
  return {
    name: "yoshi",
    session: "yoshi",
    workspaceId: "ws1",
    surfaceId: "s-old",
    workspaceRef: "workspace:1",
    declaredAt: "2026-06-11T00:00:00Z",
    ...over,
  };
}

function sess(workspaceId: string, surfaceId: string): DurableSession {
  return { sessionId: `sid-${surfaceId}`, workspaceId, surfaceId };
}

function durable(sessions: DurableSession[]): DurableSessionMap {
  return { sessions, activeSessionByWorkspace: new Map() };
}

interface Harness {
  deps: ReconcileDeps;
  writes: OrchestratorRecord[];
  escalations: { o: OrchestratorRecord; text: string }[];
}

/** Build injectable deps. `recordsRef.current` is read each call so a test can
 *  mutate the record set between beats (vanish / reappear). `live` is the set of
 *  surfaceIds cmux would say still exist. */
function harness(opts: {
  recordsRef: { current: OrchestratorRecord[] };
  map?: DurableSessionMap;
  live: Set<string>;
  workspaces?: Set<string>;
}): Harness {
  const writes: OrchestratorRecord[] = [];
  const escalations: { o: OrchestratorRecord; text: string }[] = [];
  const deps: ReconcileDeps = {
    loadRecords: () => opts.recordsRef.current,
    readMap: () => opts.map,
    surfaceExists: (t) => opts.live.has(t.surface),
    workspaceExists: (ws) =>
      (opts.workspaces ?? new Set(opts.recordsRef.current.map((r) => r.workspaceId))).has(ws),
    writeRecord: (r) => writes.push(r),
    escalate: (o, text) => escalations.push({ o, text }),
  };
  return { deps, writes, escalations };
}

test("sibling exclusion: a live sibling pane is NEVER a re-match candidate (no mis-heal)", () => {
  // A (yoshi) relaunched → its surface s-A-old is gone. Its quadrant sibling B
  // (yoshi-2) shares ws1 and has a LIVE pane s-B-live. Without exclusion the
  // durable map's only live ws1 surface (s-B-live) would be re-stamped onto A.
  const a = rec({ name: "yoshi", session: "yoshi", surfaceId: "s-A-old" });
  const b = rec({ name: "yoshi-2", session: "yoshi-2", surfaceId: "s-B-live" });
  const h = harness({
    recordsRef: { current: [a, b] },
    map: durable([sess("ws1", "s-B-live")]), // sibling's pane is the only live ws1 session
    live: new Set(["s-B-live"]),
  });
  const unresolved = new Map<string, number>();
  const live = reconcileLiveCaptains(unresolved, SETTINGS, h.deps);

  assert.deepEqual(h.writes, [], "must not re-stamp A onto the sibling's pane");
  assert.deepEqual(
    live.map((o) => o.session),
    ["yoshi-2"],
    "only the live sibling is watched; A drops to unresolved",
  );
  assert.equal(unresolved.get("yoshi"), 1, "A counts one unresolved beat");
  assert.equal(h.escalations.length, 0, "no warning on the first beat");
});

test("warn fires ONCE at exactly the 2nd consecutive unresolved beat, not before or again", () => {
  const a = rec({ surfaceId: "s-A-old" });
  const ref = { current: [a] };
  const h = harness({ recordsRef: ref, map: durable([]), live: new Set() }); // ws1 alive, no live session
  const unresolved = new Map<string, number>();

  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // beat 1
  assert.equal(h.escalations.length, 0, "beat 1: no warning yet");
  assert.equal(unresolved.get("yoshi"), 1);

  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // beat 2
  assert.equal(h.escalations.length, 1, "beat 2: exactly one warning");
  assert.match(h.escalations[0]!.text, /yoshi/);
  assert.match(h.escalations[0]!.text, /supervision stopped/);
  assert.equal(unresolved.get("yoshi"), 2);

  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // beat 3
  assert.equal(h.escalations.length, 1, "beat 3+: never warns again while still unresolved");
  assert.equal(unresolved.get("yoshi"), 3);
});

test("re-arm: a vanished record clears its counter, so a later break warns afresh", () => {
  const a = rec({ surfaceId: "s-A-old" });
  const ref = { current: [a] };
  const h = harness({ recordsRef: ref, map: durable([]), live: new Set() });
  const unresolved = new Map<string, number>();

  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // beat 1
  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // beat 2 → warns once
  assert.equal(h.escalations.length, 1);

  ref.current = []; // Captain record removed entirely
  reconcileLiveCaptains(unresolved, SETTINGS, h.deps);
  assert.equal(unresolved.size, 0, "vanished record's counter is forgotten");

  ref.current = [a]; // record reappears, still unresolvable
  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // re-armed beat 1
  assert.equal(unresolved.get("yoshi"), 1, "counter restarts from 1");
  assert.equal(h.escalations.length, 1, "re-armed beat 1 does not warn");
  reconcileLiveCaptains(unresolved, SETTINGS, h.deps); // re-armed beat 2
  assert.equal(h.escalations.length, 2, "a fresh break warns a second time");
});

test("clean re-match through the seam persists the corrected surfaceId and keeps watching", () => {
  // A's surface is gone; the durable map shows ONE live non-sibling pane s-new.
  const a = rec({ surfaceId: "s-old" });
  const h = harness({
    recordsRef: { current: [a] },
    map: durable([sess("ws1", "s-new")]),
    live: new Set(["s-new"]),
  });
  const unresolved = new Map<string, number>();
  const live = reconcileLiveCaptains(unresolved, SETTINGS, h.deps);

  assert.equal(h.writes.length, 1, "the corrected record is persisted");
  assert.equal(h.writes[0]!.surfaceId, "s-new");
  assert.equal(h.writes[0]!.session, "yoshi");
  assert.deepEqual(
    live.map((o) => o.surfaceId),
    ["s-new"],
    "the healed record stays in the watch set with its new surface",
  );
  assert.equal(unresolved.size, 0, "a re-match clears any unresolved count");
  assert.equal(h.escalations.length, 0);
});
