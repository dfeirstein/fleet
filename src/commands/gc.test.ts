import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planGc,
  sessionLiveness,
  isGone,
  discoverSessions,
  type SessionLiveness,
  type LivenessProbes,
  type Existence,
  type RegistryRead,
} from "./gc.js";
import { CmuxError } from "../cmux.js";
import type { Agent } from "../registry.js";
import type { OrchestratorRecord } from "../orchestrator-record.js";

function decide(s: SessionLiveness) {
  return planGc([s])[0]!;
}

const REC: OrchestratorRecord = {
  name: "cap",
  session: "s",
  workspaceId: "ws-1",
  surfaceId: "sf-1",
  workspaceRef: "workspace:1",
  declaredAt: "2026-06-11T00:00:00Z",
};

/** A registry read of N placeholder agents (only `handle()` fields matter). */
function agents(n: number): RegistryRead {
  const list: Agent[] = Array.from({ length: n }, (_, i) => ({ workspaceId: `aws-${i}` }) as Agent);
  return { agents: list, unreadable: false };
}

function probes(over: Partial<LivenessProbes>): LivenessProbes {
  return {
    orchestrators: [],
    surface: (): Existence => "absent",
    workspace: (): Existence => "absent",
    readRegistry: () => ({ agents: [], unreadable: false }),
    ...over,
  };
}

test("dead session (no Captain, all workers dead) is removed", () => {
  const d = decide({ session: "old", captain: "absent", workers: ["dead", "dead"] });
  assert.equal(d.action, "remove");
  assert.match(d.reason, /dead/);
});

test("a session with no workers and no Captain is removed", () => {
  // residue with nothing live behind it — registry already empty, captain gone.
  assert.equal(decide({ session: "stub", captain: "absent", workers: [] }).action, "remove");
});

test("a live Captain keeps the session", () => {
  const d = decide({ session: "yoshi", captain: "live", workers: ["dead"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /Captain/);
});

test("a live worker keeps the session even with no Captain", () => {
  const d = decide({ session: "busy", captain: "absent", workers: ["dead", "live"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /worker/);
});

test("an unverifiable Captain check is kept (fail closed)", () => {
  const d = decide({ session: "maybe", captain: "unverifiable", workers: [] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /unverifiable/);
});

test("an unverifiable worker check is kept (fail closed)", () => {
  const d = decide({ session: "maybe", captain: "absent", workers: ["dead", "unverifiable"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /unverifiable/);
});

test("mixed: a live signal wins over an unverifiable one (reported as live, not kept-unverifiable)", () => {
  const d = decide({ session: "mix", captain: "absent", workers: ["live", "unverifiable"] });
  assert.equal(d.action, "keep");
  assert.match(d.reason, /worker/);
});

// ── Fail-closed mapping: a per-check error must KEEP, never remove ────────────

test("isGone: only cmux's not_found code reads as gone", () => {
  assert.equal(isGone(new CmuxError("x", ["a"], "Error: not_found: Workspace not found")), true);
  // a transient/other cmux failure is NOT gone (must not delete a live session)
  assert.equal(isGone(new CmuxError("x", ["a"], "Error: internal: socket hang up")), false);
  assert.equal(isGone(new Error("boom")), false);
  assert.equal(isGone(undefined), false);
});

test("a worker workspace probe that errors (unknown) → unverifiable → keep", () => {
  const s = sessionLiveness("s", probes({ readRegistry: () => agents(1), workspace: () => "unknown" }));
  assert.deepEqual(s.workers, ["unverifiable"]);
  assert.equal(decide(s).action, "keep");
});

test("a Captain surface probe that errors (unknown) → unverifiable → keep", () => {
  const s = sessionLiveness("s", probes({ orchestrators: [REC], surface: () => "unknown" }));
  assert.equal(s.captain, "unverifiable");
  assert.equal(decide(s).action, "keep");
});

test("a definitively-gone session (not_found probes) is dead → remove", () => {
  // every probe returns 'absent' (the not_found answer) and no Captain record.
  const s = sessionLiveness("s", probes({ readRegistry: () => agents(2) }));
  assert.deepEqual(s.workers, ["dead", "dead"]);
  assert.equal(decide(s).action, "remove");
});

test("an unreadable (corrupt) registry → unverifiable worker → keep", () => {
  const s = sessionLiveness("s", probes({ readRegistry: () => ({ agents: [], unreadable: true }) }));
  assert.deepEqual(s.workers, ["unverifiable"]);
  assert.equal(decide(s).action, "keep");
});

test("a malformed Captain record (missing ids) → unverifiable → keep", () => {
  const broken = { ...REC, surfaceId: "" };
  const s = sessionLiveness("s", probes({ orchestrators: [broken] }));
  assert.equal(s.captain, "unverifiable");
  assert.equal(decide(s).action, "keep");
});

test("a live Captain surface (present) keeps the session", () => {
  const s = sessionLiveness("s", probes({ orchestrators: [REC], surface: () => "present" }));
  assert.equal(s.captain, "live");
  assert.equal(decide(s).action, "keep");
});

// ── discoverSessions excludes the legacy singleton (Bug 5, bughunt 2026-06-13) ─
// `~/.fleet/orchestrator.json` is the pre-split Captain record (its own `session`
// is the default "yoshi", not "orchestrator"). The generic-branch matcher derived
// session "orchestrator" from it; the lookup then missed (no record has
// session==="orchestrator"), so the live Captain didn't protect it → planGc said
// "remove" → gc --apply rmSync'd the Captain's record. The fix excludes the bare
// singleton from discovery (and adds "orchestrator" to RESERVED).

test("discoverSessions: the legacy singleton orchestrator.json is NOT a gc-eligible session", () => {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "fleet-gc-"));
  process.env.HOME = home; // redirects fleetDir() → <home>/.fleet
  try {
    const fleet = join(home, ".fleet");
    mkdirSync(fleet, { recursive: true });
    // The pre-split Captain record — note session "yoshi", not "orchestrator".
    writeFileSync(
      join(fleet, "orchestrator.json"),
      JSON.stringify({
        name: "cap",
        session: "yoshi",
        workspaceId: "ws-1",
        surfaceId: "sf-1",
        workspaceRef: "workspace:1",
        declaredAt: "2026-06-13T00:00:00Z",
      }),
    );
    // An ordinary registry session alongside it, to prove discovery still works.
    writeFileSync(join(fleet, "realsession.json"), JSON.stringify({ session: "realsession", agents: {} }));

    const sessions = discoverSessions();
    assert.ok(!sessions.includes("orchestrator"), "the legacy singleton is never enumerated as a session");
    assert.ok(sessions.includes("realsession"), "ordinary registry sessions are still discovered");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("each session is decided independently", () => {
  const decisions = planGc([
    { session: "dead1", captain: "absent", workers: ["dead"] },
    { session: "live1", captain: "live", workers: [] },
    { session: "unsure1", captain: "unverifiable", workers: [] },
  ]);
  assert.deepEqual(
    decisions.map((d) => `${d.session}:${d.action}`),
    ["dead1:remove", "live1:keep", "unsure1:keep"],
  );
});
