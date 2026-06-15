// Pure tests for the `fleet captain --split` slot/family decision (the clone +
// wrong-family bugs). cmux liveness is injected, so the two safety rules are
// proven without spawning a workspace. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseCaptainSlot,
  reconcileStaleRecords,
  familyOf,
  indexOf,
  type CaptainSlotRecord,
} from "./captain-slot.js";

type IsLive = (r: { workspaceId: string; surfaceId: string }) => boolean;
const liveAll: IsLive = () => true;

function rec(session: string, workspaceId: string, surfaceId: string): CaptainSlotRecord {
  return { session, workspaceId, surfaceId };
}

/** A `liveCells` lookup from a workspace → live-surface-ids map. */
function cellsFrom(map: Record<string, string[]>): (ws: string) => string[] {
  return (ws) => map[ws] ?? [];
}

/** isLive that treats a record as live iff its surface is among its workspace's
 *  live cells — the real cmux relationship (`surfaceExists` over grid cells). */
function liveByCells(map: Record<string, string[]>): IsLive {
  return (r) => (map[r.workspaceId] ?? []).includes(r.surfaceId);
}

test("familyOf strips the -N sibling suffix; indexOf maps a session to its quadrant slot", () => {
  assert.equal(familyOf("yoshi"), "yoshi");
  assert.equal(familyOf("yoshi-3"), "yoshi");
  assert.equal(familyOf("mario-2"), "mario");
  assert.equal(indexOf("yoshi", "yoshi"), 1);
  assert.equal(indexOf("yoshi-2", "yoshi"), 2);
  assert.equal(indexOf("yoshi-4", "yoshi"), 4);
});

test("wrong-family bug: family anchors on the workspace owner, NOT the env fallback", () => {
  // The ⌘⇧Y runner tab has no FLEET_SESSION → fallbackSession defaults to "yoshi".
  // Splitting a live mario Captain's workspace must yield mario-2, never yoshi.
  const records = [rec("mario", "ws-mario", "s-mario")];
  const { family, session } = chooseCaptainSlot({
    records,
    ws: "ws-mario",
    fallbackSession: "yoshi",
    isLive: liveAll,
    cap: 4,
  });
  assert.equal(family, "mario");
  assert.equal(session, "mario-2");
});

test("clone bug: a transient surfaceExists miss can never clobber a live record", () => {
  // ws is owned by a LIVE yoshi, but the family live-count probe misses (transient),
  // so the slot pick collapses to the bare family name "yoshi". The hard uniqueness
  // guard re-probes, sees yoshi's record is still live, and bumps to yoshi-2.
  const records = [rec("yoshi", "ws1", "s-yoshi")];
  // Flaky probe: the FIRST liveness check (the family live-count) misses; every
  // later check (the uniqueness guard's re-probe) hits — exactly the flaky race.
  let firstProbe = true;
  const isLive = () => {
    if (firstProbe) {
      firstProbe = false;
      return false; // count phase: miss → live set under-counts to empty
    }
    return true; // guard phase: yoshi is in fact live
  };
  const { family, session } = chooseCaptainSlot({
    records,
    ws: "ws1",
    fallbackSession: "yoshi",
    isLive,
    cap: 4,
  });
  assert.equal(family, "yoshi");
  assert.equal(session, "yoshi-2", "guard refuses the live yoshi even when the count missed it");
});

test("slot progression: lowest free slot, and a closed slot is reused", () => {
  const ws = "ws1";
  const base = rec("yoshi", ws, "s1");
  const two = rec("yoshi-2", ws, "s2");
  const pick = (records: CaptainSlotRecord[], isLive: IsLive) =>
    chooseCaptainSlot({ records, ws, fallbackSession: "yoshi", isLive, cap: 4 }).session;

  // One live sibling (yoshi) → yoshi-2.
  assert.equal(pick([base], liveAll), "yoshi-2");

  // yoshi + yoshi-2 both live → yoshi-3.
  assert.equal(pick([base, two], liveAll), "yoshi-3");

  // yoshi-2's record present but DEAD frees slot 2 → yoshi-2 again.
  const deadTwo: IsLive = (r) => r.surfaceId !== "s2";
  assert.equal(pick([base, two], deadTwo), "yoshi-2");

  // yoshi-2's record absent entirely also frees slot 2 → yoshi-2 again.
  assert.equal(pick([base], liveAll), "yoshi-2");
});

test("quadrant full: 4 live siblings throws", () => {
  const records = [
    rec("yoshi", "ws1", "s1"),
    rec("yoshi-2", "ws1", "s2"),
    rec("yoshi-3", "ws1", "s3"),
    rec("yoshi-4", "ws1", "s4"),
  ];
  assert.throws(
    () => chooseCaptainSlot({ records, ws: "ws1", fallbackSession: "yoshi", isLive: liveAll, cap: 4 }),
    /Quadrant full/,
  );
});

test("no record owns ws: family falls back to the env session's family", () => {
  // Defensive fallback only — `--split` always runs against an owned workspace.
  const records = [rec("mario", "ws-other", "s-mario")];
  const { family, session } = chooseCaptainSlot({
    records,
    ws: "ws-empty",
    fallbackSession: "yoshi-3",
    isLive: liveAll,
    cap: 4,
  });
  assert.equal(family, "yoshi");
  assert.equal(session, "yoshi"); // no live yoshi sibling → base slot is free
});

// --- reconcileStaleRecords: heal a stale-but-live record before the slot pick ---
// PR #59 anchored family + added a uniqueness guard, but BOTH decide liveness via
// isLive(record.surfaceId). A persistently STALE surfaceId (in-pane relaunch /
// durable-map lag) makes a LIVE Captain read as not-live → the slot collapses to
// the bare family name and --split clobbers its record (a clone). reconcile re-points
// stale records to their UNAMBIGUOUS live cell first, mirroring decideSelfHeal.

test("THE stale-record clone bug: a live Captain with a stale surfaceId reconciles to its live cell → yoshi-2, NOT a clone", () => {
  // yoshi is LIVE in workspace W, but its record points at a DEAD surface (its pane
  // was relaunched/re-surfaced); W's only live cell is the relaunched pane LIVE_A.
  const liveCellsMap = { W: ["LIVE_A"] };
  const records = [rec("yoshi", "W", "DEAD")];
  const isLive = liveByCells(liveCellsMap);

  // The bug, made explicit: WITHOUT reconcile, chooseCaptainSlot sees the stale
  // yoshi as not-live → the live-count is empty and the uniqueness guard re-probes
  // the same dead surface → it accepts the bare family name "yoshi" (the clone).
  const naive = chooseCaptainSlot({ records, ws: "W", fallbackSession: "yoshi", isLive, cap: 4 });
  assert.equal(naive.session, "yoshi", "reproduces the clone: stale record reads as not-live");

  // The fix: reconcile re-stamps yoshi onto its live cell, then the slot decision
  // counts it as live and the guard refuses its name → next free slot.
  const reconciled = reconcileStaleRecords({ records, liveCells: cellsFrom(liveCellsMap), isLive });
  assert.equal(reconciled[0]!.surfaceId, "LIVE_A", "stale surfaceId healed to the unambiguous live cell");
  const { family, session } = chooseCaptainSlot({
    records: reconciled,
    ws: "W",
    fallbackSession: "yoshi",
    isLive,
    cap: 4,
  });
  assert.equal(family, "yoshi");
  assert.equal(session, "yoshi-2", "live yoshi is counted → no clone");
});

test("ambiguous: two unclaimed live cells leave the stale record unchanged (fail closed)", () => {
  // W has TWO live cells and no other record claims either → which one is yoshi's?
  // Don't guess. Leave it stale; the split then treats it as a free slot and the
  // daemon self-heal escalates the genuinely-ambiguous case.
  const liveCellsMap = { W: ["LIVE_A", "LIVE_B"] };
  const records = [rec("yoshi", "W", "DEAD")];
  const isLive = liveByCells(liveCellsMap);
  const reconciled = reconcileStaleRecords({ records, liveCells: cellsFrom(liveCellsMap), isLive });
  assert.equal(reconciled[0]!.surfaceId, "DEAD", "ambiguous → not guessed; record untouched");
  const { session } = chooseCaptainSlot({ records: reconciled, ws: "W", fallbackSession: "yoshi", isLive, cap: 4 });
  assert.equal(session, "yoshi", "still not-live → split takes the bare family slot");
});

test("already-live record: reconcile is a no-op (same reference back)", () => {
  const liveCellsMap = { W: ["LIVE_A"] };
  const records = [rec("yoshi", "W", "LIVE_A")];
  const reconciled = reconcileStaleRecords({
    records,
    liveCells: cellsFrom(liveCellsMap),
    isLive: liveByCells(liveCellsMap),
  });
  assert.equal(reconciled[0], records[0], "live record returned unchanged");
});

test("no cross-claim: a live cell already owned by another live-surfaced record is not a candidate", () => {
  // W has live cells [LIVE_A, LIVE_B]; LIVE_A belongs to the live yoshi. The stale
  // yoshi-2 may only heal onto the UNCLAIMED LIVE_B — never steal a sibling's pane.
  const liveCellsMap = { W: ["LIVE_A", "LIVE_B"] };
  const records = [rec("yoshi", "W", "LIVE_A"), rec("yoshi-2", "W", "DEAD")];
  const reconciled = reconcileStaleRecords({
    records,
    liveCells: cellsFrom(liveCellsMap),
    isLive: liveByCells(liveCellsMap),
  });
  assert.equal(reconciled[0]!.surfaceId, "LIVE_A", "the live sibling is untouched");
  assert.equal(reconciled[1]!.surfaceId, "LIVE_B", "stale sibling heals onto the unclaimed cell only");
});
