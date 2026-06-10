// Per-project gain view over the delegation-outcome log — Fleet's analog of
// CL-Bench's headline "gain" metric (research/continual-learning-bench-…md,
// rec #5). The outcome log records {spawn, verify, complete, kill} per worker
// over time; this PURE aggregation asks whether a project's memory is actually
// paying off: is its delegation failure rate trending down, and are the SAME
// failures recurring?
//
// Posture mirrors the fail-closed gate discipline applied to CONCLUSIONS: never
// imply a trend from too little data (<2 graded buckets → "insufficient-data"),
// and never silently drop a corrupt log line (count it as `malformed` and let
// the caller surface it). Matching fidelity is deliberately honest — repeat
// failures are exact normalized-text matches on (label │ check), NOT semantic.

import type { OutcomeRecord } from "./outcomes.js";

export type GainTrend = "improving" | "flat" | "degrading" | "insufficient-data";

export interface GainBucket {
  /** Bucket key — the UTC calendar day (YYYY-MM-DD) the records fell in. */
  key: string;
  /** spawn events: tasks delegated in this bucket. */
  delegations: number;
  /** verify events with verdict "fail" — gate-fails / verify-fails. */
  fails: number;
  /** complete events — workers that passed the proof gate. */
  completes: number;
  /** fails / (fails + completes); null when the bucket graded nothing
   *  (delegations may still be >0 — spawns without a recorded outcome). */
  failureRate: number | null;
}

export interface RepeatFailure {
  /** Normalized "label │ check" — the recorded failure signature. */
  signature: string;
  /** How many failure records share this signature (≥2). */
  count: number;
  /** Distinct bucket days on which it recurred (sorted). */
  dates: string[];
}

export interface ProjectGain {
  /** The project directory (the record's `cwd`). Worktrees count as their own
   *  project — the log records no parent-repo link, so we don't fabricate one. */
  project: string;
  buckets: GainBucket[];
  repeatFailures: RepeatFailure[];
  trend: GainTrend;
  /** One-line, honest verdict (states "insufficient data" when it applies). */
  verdict: string;
}

export interface GainReport {
  projects: ProjectGain[];
  /** Log lines that failed to parse — counted, never silently dropped. */
  malformed: number;
}

/** A graded outcome rate must move at least this much (in absolute rate, 0..1)
 *  between the first and last graded bucket to read as a trend, not noise. */
export const TREND_THRESHOLD = 0.1;

/** Parse raw JSONL lines into records, counting (not dropping) corrupt ones.
 *  PURE — corrupt-line handling lives here so the gain report can report it. */
export function parseOutcomeLines(lines: string[]): { records: OutcomeRecord[]; malformed: number } {
  const records: OutcomeRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as OutcomeRecord;
      // A line that parses to a non-object (e.g. `42`, `"x"`) or lacks the
      // shape we key on is corrupt for our purposes — count it, don't trust it.
      if (r && typeof r === "object" && typeof r.event === "string" && typeof r.ts === "string") {
        records.push(r);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

function normalizeSignature(label: string, check: string | undefined): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(label)} │ ${norm(check ?? "")}`;
}

function bucketsFor(records: OutcomeRecord[]): GainBucket[] {
  const byDay = new Map<string, GainBucket>();
  for (const r of records) {
    const key = r.ts.slice(0, 10); // YYYY-MM-DD (UTC, from the ISO timestamp)
    let b = byDay.get(key);
    if (!b) {
      b = { key, delegations: 0, fails: 0, completes: 0, failureRate: null };
      byDay.set(key, b);
    }
    if (r.event === "spawn") b.delegations++;
    else if (r.event === "complete") b.completes++;
    else if (r.event === "verify" && r.verdict === "fail") b.fails++;
  }
  const buckets = [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const b of buckets) {
    const graded = b.fails + b.completes;
    b.failureRate = graded === 0 ? null : b.fails / graded;
  }
  return buckets;
}

function repeatFailuresFor(records: OutcomeRecord[]): RepeatFailure[] {
  // signature -> { count, dates set }
  const seen = new Map<string, { count: number; dates: Set<string> }>();
  for (const r of records) {
    if (r.event !== "verify" || r.verdict !== "fail") continue;
    const sig = normalizeSignature(r.label, r.check);
    let e = seen.get(sig);
    if (!e) {
      e = { count: 0, dates: new Set() };
      seen.set(sig, e);
    }
    e.count++;
    e.dates.add(r.ts.slice(0, 10));
  }
  const repeats: RepeatFailure[] = [];
  for (const [signature, e] of seen) {
    if (e.count >= 2) {
      repeats.push({ signature, count: e.count, dates: [...e.dates].sort() });
    }
  }
  // Most-recurring first, then stable by signature.
  return repeats.sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
}

function trendFor(buckets: GainBucket[]): { trend: GainTrend; verdict: string } {
  const graded = buckets.filter((b): b is GainBucket & { failureRate: number } => b.failureRate !== null);
  if (graded.length < 2) {
    return {
      trend: "insufficient-data",
      verdict: `insufficient data — only ${graded.length} bucket(s) with graded outcomes (need ≥2 to call a trend)`,
    };
  }
  const first = graded[0]!.failureRate;
  const last = graded[graded.length - 1]!.failureRate;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const span = `${pct(first)} → ${pct(last)}`;
  if (last <= first - TREND_THRESHOLD) {
    return { trend: "improving", verdict: `improving — failure rate ${span} across ${graded.length} buckets` };
  }
  if (last >= first + TREND_THRESHOLD) {
    return { trend: "degrading", verdict: `degrading — failure rate ${span} across ${graded.length} buckets` };
  }
  return { trend: "flat", verdict: `flat — failure rate ${span} across ${graded.length} buckets` };
}

/**
 * Aggregate the gain view from raw outcome-log lines. PURE.
 * - `opts.cwd`, when set, restricts to one project (exact cwd match).
 * - Records with no `cwd` are dropped from the per-project view (they can't be
 *   attributed to a project) but their lines still counted toward parsing.
 * Projects are ordered by total activity (most records first), then by name.
 */
export function gainReport(lines: string[], opts: { cwd?: string } = {}): GainReport {
  const { records, malformed } = parseOutcomeLines(lines);
  const byProject = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    if (!r.cwd) continue;
    if (opts.cwd !== undefined && r.cwd !== opts.cwd) continue;
    const list = byProject.get(r.cwd);
    if (list) list.push(r);
    else byProject.set(r.cwd, [r]);
  }
  const projects: ProjectGain[] = [];
  for (const [project, recs] of byProject) {
    const buckets = bucketsFor(recs);
    const { trend, verdict } = trendFor(buckets);
    projects.push({ project, buckets, repeatFailures: repeatFailuresFor(recs), trend, verdict });
  }
  projects.sort((a, b) => {
    const an = a.buckets.reduce((s, x) => s + x.delegations + x.fails + x.completes, 0);
    const bn = b.buckets.reduce((s, x) => s + x.delegations + x.fails + x.completes, 0);
    return bn - an || (a.project < b.project ? -1 : 1);
  });
  return { projects, malformed };
}
