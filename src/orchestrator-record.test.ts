// Regression test for Bug 2 (bughunt 2026-06-13): the orchestrator record has
// two unsynchronized writers — the daemon self-heal (re-stamps surfaceId) and
// the captain declare/resume path (whole-record write). The heal snapshots a
// record at beat start, then writes from that stale in-memory copy after a wide
// cmux window — so a bare write reverts a `sessionId` a concurrent resume just
// wrote, re-introducing the issue-#36 `--continue` fork hazard. The fix makes
// writeOrchestrator re-load before writing and merge field-wise.
//
// A true cross-process concurrency test isn't feasible in node:test, so this is
// a focused test of the merge/re-stamp helper: it stages the exact on-disk
// interleaving (resume superseded the heal's snapshot) and asserts the merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeOrchestrator,
  loadOrchestrator,
  orchestratorPath,
  type OrchestratorRecord,
} from "./orchestrator-record.js";

function rec(over: Partial<OrchestratorRecord>): OrchestratorRecord {
  return {
    name: "cap",
    session: "s",
    workspaceId: "ws-1",
    surfaceId: "sf-1",
    workspaceRef: "workspace:1",
    declaredAt: "2026-06-13T00:00:00Z",
    ...over,
  };
}

test("writeOrchestrator re-loads before write: a heal re-stamp keeps a concurrent resume's fresh sessionId", () => {
  const realHome = process.env.HOME;
  const realFleetSession = process.env.FLEET_SESSION;
  const home = mkdtempSync(join(tmpdir(), "fleet-orch-"));
  process.env.HOME = home; // redirects fleetDir() → <home>/.fleet
  delete process.env.FLEET_SESSION; // we pass session explicitly
  try {
    mkdirSync(join(home, ".fleet"), { recursive: true });

    // The heal loaded this stale snapshot at beat start (surface S1, no sessionId).
    const staleSnapshot = rec({ surfaceId: "sf-S1" });

    // Meanwhile a resume superseded it on disk: new surface S2 + a fresh sessionId
    // (the #36 fork guard) — a bare whole-record write, like orchestrate.ts does.
    writeFileSync(
      orchestratorPath("s"),
      JSON.stringify(rec({ surfaceId: "sf-S2", sessionId: "claude-session-NEW" }), null, 2),
    );

    // The heal now persists its correction from the STALE snapshot, re-stamping
    // the surfaceId it computed (S2, the single live candidate). The bug: a bare
    // write reverts sessionId to the stale snapshot's (undefined). The fix merges.
    writeOrchestrator({ ...staleSnapshot, surfaceId: "sf-S2" });

    const onDisk = loadOrchestrator("s");
    assert.ok(onDisk, "record persisted");
    assert.equal(onDisk!.surfaceId, "sf-S2", "heal's corrected surfaceId is stamped");
    assert.equal(
      onDisk!.sessionId,
      "claude-session-NEW",
      "the resume's fresh sessionId is preserved, not reverted to the heal snapshot's",
    );
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realFleetSession !== undefined) process.env.FLEET_SESSION = realFleetSession;
    rmSync(home, { recursive: true, force: true });
  }
});
