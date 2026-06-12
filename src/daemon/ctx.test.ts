// Unit tests for the context-occupancy sidecar reader (pure parsing + staleness
// classification + worker/Captain matching) and the on-disk read path against a
// temp dir. FAIL CLOSED is the property under test: corrupt/off-schema/stale →
// UNKNOWN, never a healthy reading. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSidecar,
  classifyOccupancy,
  readSidecars,
  workerSidecar,
  captainSidecar,
  CTX_STALE_SEC,
  type CtxSidecar,
} from "./ctx.js";

const NOW_SEC = 1_760_000_000;

function sidecar(over: Partial<CtxSidecar> = {}): CtxSidecar {
  return {
    schema: 1,
    session_id: "s1",
    ts: NOW_SEC,
    pct: 42,
    fleet_session: "cliff",
    fleet_agent_id: "agent-1",
    ...over,
  };
}

// ── parseSidecar: valid / corrupt / off-schema ───────────────────────────────

test("parseSidecar accepts a well-formed sidecar", () => {
  const sc = parseSidecar(JSON.stringify(sidecar()));
  assert.ok(sc);
  assert.equal(sc!.pct, 42);
  assert.equal(sc!.fleet_agent_id, "agent-1");
});

test("parseSidecar rejects corrupt JSON (→ undefined, treated as no reading)", () => {
  assert.equal(parseSidecar("{not json"), undefined);
  assert.equal(parseSidecar(""), undefined);
  assert.equal(parseSidecar("null"), undefined);
});

test("parseSidecar rejects off-schema records (missing/!numeric ts or pct, out-of-range pct)", () => {
  assert.equal(parseSidecar(JSON.stringify({ session_id: "s", pct: 10 })), undefined); // no ts
  assert.equal(parseSidecar(JSON.stringify({ session_id: "s", ts: NOW_SEC })), undefined); // no pct
  assert.equal(parseSidecar(JSON.stringify({ session_id: "s", ts: "x", pct: 10 })), undefined); // ts !number
  assert.equal(parseSidecar(JSON.stringify({ session_id: "s", ts: NOW_SEC, pct: 150 })), undefined); // pct > 100
  assert.equal(parseSidecar(JSON.stringify({ session_id: "s", ts: NOW_SEC, pct: -1 })), undefined); // pct < 0
  assert.equal(parseSidecar(JSON.stringify({ ts: NOW_SEC, pct: 10 })), undefined); // no session_id
});

// ── classifyOccupancy: fresh / stale / absent (fail closed) ──────────────────

test("classifyOccupancy: a fresh reading is KNOWN (and carries the compactions counter)", () => {
  const occ = classifyOccupancy(sidecar({ pct: 55, compactions: 2 }), NOW_SEC);
  assert.deepEqual(occ, { known: true, pct: 55, stale: false, compactions: 2 });
});

test("classifyOccupancy: a reading older than the staleness window is UNKNOWN (fail closed)", () => {
  const occ = classifyOccupancy(sidecar({ pct: 90, ts: NOW_SEC - CTX_STALE_SEC - 1 }), NOW_SEC);
  assert.equal(occ.known, false); // never reported healthy on stale data
  assert.equal(occ.stale, true);
  assert.equal(occ.pct, 90); // pct carried for display, but known=false gates action
});

test("classifyOccupancy: exactly at the staleness boundary is still KNOWN", () => {
  const occ = classifyOccupancy(sidecar({ ts: NOW_SEC - CTX_STALE_SEC }), NOW_SEC);
  assert.equal(occ.known, true);
});

test("classifyOccupancy: a missing sidecar is UNKNOWN, not stale", () => {
  assert.deepEqual(classifyOccupancy(undefined, NOW_SEC), { known: false, pct: 0, stale: false });
});

// ── matching: worker by FLEET_AGENT_ID, Captain by session + empty agent id ──

test("workerSidecar matches on FLEET_AGENT_ID", () => {
  const all = [sidecar({ fleet_agent_id: "agent-1" }), sidecar({ fleet_agent_id: "agent-2", pct: 5 })];
  assert.equal(workerSidecar(all, "agent-2")?.pct, 5);
  assert.equal(workerSidecar(all, "nope"), undefined);
});

test("captainSidecar matches session with an EMPTY agent id (and ignores worker sidecars)", () => {
  const all = [
    sidecar({ fleet_agent_id: "agent-1", fleet_session: "cliff" }), // a worker — not the Captain
    sidecar({ fleet_agent_id: "", fleet_session: "cliff", pct: 70 }), // the Captain
  ];
  assert.equal(captainSidecar(all, "cliff")?.pct, 70);
  assert.equal(captainSidecar(all, "other"), undefined);
});

// ── readSidecars: temp-dir round trip + tolerance ────────────────────────────

test("readSidecars reads valid files, skips corrupt ones, and ignores non-.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ctx-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify(sidecar({ fleet_agent_id: "agent-1" })));
    writeFileSync(join(dir, "b.json"), "{corrupt");
    writeFileSync(join(dir, "c.txt"), JSON.stringify(sidecar({ fleet_agent_id: "agent-9" }))); // not .json
    const all = readSidecars(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.fleet_agent_id, "agent-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSidecars on a missing directory returns [] (statusline never ran → all UNKNOWN)", () => {
  assert.deepEqual(readSidecars(join(tmpdir(), "fleet-ctx-does-not-exist-xyz")), []);
});
