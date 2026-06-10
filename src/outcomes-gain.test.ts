// Unit tests for the per-project gain aggregation (pure). Covers the trend
// classifier (improving / degrading / flat / insufficient-data), repeat-failure
// detection, empty/sparse logs, malformed-line counting (never crash, never
// silently drop), and the --cwd project filter. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gainReport, parseOutcomeLines, TREND_THRESHOLD } from "./outcomes-gain.js";
import type { OutcomeRecord } from "./outcomes.js";

// Build a JSONL line for one outcome record.
function line(rec: Partial<OutcomeRecord> & Pick<OutcomeRecord, "ts" | "event">): string {
  return JSON.stringify({ session: "s", agentId: "a", label: "l", cwd: "/proj", ...rec });
}

// A whole day's worth of verify/complete events at a fixed failure ratio.
function day(date: string, fails: number, completes: number, cwd = "/proj"): string[] {
  const out: string[] = [];
  for (let i = 0; i < fails; i++) {
    out.push(line({ ts: `${date}T0${i % 9}:00:00.000Z`, event: "verify", verdict: "fail", check: "proof-gate", label: `w${i}`, cwd }));
  }
  for (let i = 0; i < completes; i++) {
    out.push(line({ ts: `${date}T1${i % 9}:00:00.000Z`, event: "complete", label: `w${i}`, cwd }));
  }
  return out;
}

// ── parseOutcomeLines: malformed handling ─────────────────────────────────────

test("parseOutcomeLines counts corrupt lines instead of dropping or crashing", () => {
  const lines = [
    line({ ts: "2026-06-08T00:00:00.000Z", event: "spawn" }),
    "{ not json",          // torn line
    "",                    // blank — ignored, not counted
    "42",                  // valid JSON but not a record object
    '"a string"',          // valid JSON, wrong shape
    JSON.stringify({ event: "spawn" }), // missing ts
  ];
  const { records, malformed } = parseOutcomeLines(lines);
  assert.equal(records.length, 1);
  assert.equal(malformed, 4); // torn + number(42) + string + missing-ts; blank line is ignored
});

test("malformed surfaces in the report, never crashing the aggregation", () => {
  const lines = [...day("2026-06-08", 1, 1), "}}garbage{{"];
  const rep = gainReport(lines);
  assert.equal(rep.malformed, 1);
  assert.equal(rep.projects.length, 1);
});

// ── trend classifier ──────────────────────────────────────────────────────────

test("improving: failure rate falls across buckets", () => {
  const lines = [...day("2026-06-08", 8, 2), ...day("2026-06-09", 1, 9)]; // 80% → 10%
  const rep = gainReport(lines);
  const p = rep.projects[0]!;
  assert.equal(p.trend, "improving");
  assert.match(p.verdict, /improving/);
});

test("degrading: failure rate rises across buckets", () => {
  const lines = [...day("2026-06-08", 1, 9), ...day("2026-06-09", 8, 2)]; // 10% → 80%
  assert.equal(gainReport(lines).projects[0]!.trend, "degrading");
});

test("flat: failure rate barely moves (under the threshold)", () => {
  const lines = [...day("2026-06-08", 3, 7), ...day("2026-06-09", 3, 7)]; // 30% → 30%
  assert.equal(gainReport(lines).projects[0]!.trend, "flat");
});

test("insufficient-data: a single graded bucket never implies a trend", () => {
  const rep = gainReport(day("2026-06-08", 5, 5));
  const p = rep.projects[0]!;
  assert.equal(p.trend, "insufficient-data");
  assert.match(p.verdict, /insufficient data/);
});

test("insufficient-data: spawns with no graded outcomes don't fabricate a trend", () => {
  const lines = [
    line({ ts: "2026-06-08T00:00:00.000Z", event: "spawn" }),
    line({ ts: "2026-06-09T00:00:00.000Z", event: "spawn" }),
  ];
  const p = gainReport(lines).projects[0]!;
  assert.equal(p.trend, "insufficient-data");
  assert.equal(p.buckets.length, 2);
  assert.equal(p.buckets[0]!.failureRate, null); // no fails/completes → null, not 0
  assert.equal(p.buckets[0]!.delegations, 1);
});

test("TREND_THRESHOLD boundary: exactly the threshold counts as a move", () => {
  // first 50%, last 40% → delta = 0.1 == threshold → improving (last <= first - thr)
  const lines = [...day("2026-06-08", 5, 5), ...day("2026-06-09", 4, 6)];
  assert.equal(TREND_THRESHOLD, 0.1);
  assert.equal(gainReport(lines).projects[0]!.trend, "improving");
});

// ── repeat-failure detection ──────────────────────────────────────────────────

test("repeat failures: same (label │ check) seen ≥2× is flagged with its count and dates", () => {
  const lines = [
    line({ ts: "2026-06-08T00:00:00.000Z", event: "verify", verdict: "fail", label: "port-users", check: "proof-gate" }),
    line({ ts: "2026-06-09T00:00:00.000Z", event: "verify", verdict: "fail", label: "port-users", check: "proof-gate" }),
    line({ ts: "2026-06-09T01:00:00.000Z", event: "verify", verdict: "fail", label: "port-orgs", check: "proof-gate" }),
  ];
  const p = gainReport(lines).projects[0]!;
  assert.equal(p.repeatFailures.length, 1);
  assert.equal(p.repeatFailures[0]!.count, 2);
  assert.match(p.repeatFailures[0]!.signature, /port-users/);
  assert.deepEqual(p.repeatFailures[0]!.dates, ["2026-06-08", "2026-06-09"]);
});

test("repeat failures normalize whitespace/case so trivial differences still match", () => {
  const lines = [
    line({ ts: "2026-06-08T00:00:00.000Z", event: "verify", verdict: "fail", label: "Port  Users", check: "Proof-Gate" }),
    line({ ts: "2026-06-08T01:00:00.000Z", event: "verify", verdict: "fail", label: "port users", check: "proof-gate" }),
  ];
  assert.equal(gainReport(lines).projects[0]!.repeatFailures.length, 1);
});

test("a one-off failure is not a repeat", () => {
  const lines = day("2026-06-08", 1, 1); // labels are all distinct (w0…) in day()
  assert.equal(gainReport(lines).projects[0]!.repeatFailures.length, 0);
});

// ── empty / sparse / filtering ────────────────────────────────────────────────

test("empty log → no projects, no malformed", () => {
  const rep = gainReport([]);
  assert.deepEqual(rep.projects, []);
  assert.equal(rep.malformed, 0);
});

test("records with no cwd are excluded from the per-project view", () => {
  const lines = [JSON.stringify({ ts: "2026-06-08T00:00:00.000Z", event: "spawn", label: "x" })];
  assert.equal(gainReport(lines).projects.length, 0);
});

test("--cwd filter scopes to one project; others are dropped", () => {
  const lines = [...day("2026-06-08", 1, 1, "/proj-a"), ...day("2026-06-08", 1, 1, "/proj-b")];
  const all = gainReport(lines);
  assert.equal(all.projects.length, 2);
  const scoped = gainReport(lines, { cwd: "/proj-b" });
  assert.equal(scoped.projects.length, 1);
  assert.equal(scoped.projects[0]!.project, "/proj-b");
});

test("projects are ordered by total activity (most records first)", () => {
  const lines = [...day("2026-06-08", 1, 1, "/small"), ...day("2026-06-08", 5, 5, "/big")];
  const rep = gainReport(lines);
  assert.equal(rep.projects[0]!.project, "/big");
});
