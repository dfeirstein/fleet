// Pure tests for the `fleet captain --split` slot/family decision (the clone +
// wrong-family bugs). cmux liveness is injected, so the two safety rules are
// proven without spawning a workspace. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCaptainSlot, familyOf, indexOf, type CaptainSlotRecord } from "./captain-slot.js";

type IsLive = (r: { workspaceId: string; surfaceId: string }) => boolean;
const liveAll: IsLive = () => true;

function rec(session: string, workspaceId: string, surfaceId: string): CaptainSlotRecord {
  return { session, workspaceId, surfaceId };
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
