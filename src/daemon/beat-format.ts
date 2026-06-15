// Pure formatter for the daemon's consolidated heartbeat line — no I/O, no cmux.
// The daemon beats once per Captain, so the old logs were two bare lines
// ("N agents" per Captain, "N captains" per cycle) that READ like flapping. This
// renders ONE attributed, scannable rollup line per beat cycle.
//
// Per-Captain status legend (only NON-ZERO buckets shown; a Captain with no
// workers reads "<session> idle", never a bare 0):
//   r=running  i=idle  L=rate-limited  b=blocked-on-you  a=awaiting-input
//   e=error    d=dead
// Actions ("⚡ self-heal 1 · redispatch 1 · wave✓") and telemetry
// ("cpu 142%⚠", "surface⚠") are rolled up across the cycle and shown ONLY when
// something happened / is wrong, so a steady-state beat stays clean.
//
// Color is opt-in (caller passes color:true only on a TTY) and never leaks into
// piped output — the default is clean monochrome text.

import type { AgentStatus } from "../registry.js";

/** Worker tallies for one Captain, bucketed onto the 7 display states. */
export interface WorkerStatusCounts {
  running: number;
  idle: number;
  rateLimited: number;
  blocked: number;
  awaitingInput: number;
  error: number;
  dead: number;
}

/** What the daemon DID for one Captain this beat — omitted fields mean "none". */
export interface BeatActions {
  selfHeal?: number;
  redispatch?: number;
  donePass?: number;
  doneExhausted?: number;
  waveComplete?: boolean;
  alerts?: number;
}

/** One Captain's contribution to the beat line. */
export interface CaptainBeatSummary {
  session: string;
  counts: WorkerStatusCounts;
  actions: BeatActions;
  /** Highest worker CPU% sampled this beat (may exceed 100 across cores). */
  cpuMaxPct?: number;
  /** A worker has been above the CPU threshold long enough to look stuck. */
  spinning?: boolean;
  /** A worker failed its surface-health probe. */
  unhealthy?: boolean;
  /** beat() threw for this Captain this cycle — render it errored, never drop it. */
  beatError?: boolean;
}

export interface BeatLineModel {
  beat: number;
  uptimeMs: number;
  captains: CaptainBeatSummary[];
  at: string; // HH:MM:SS
}

/** Fresh zeroed tallies. */
export function emptyCounts(): WorkerStatusCounts {
  return { running: 0, idle: 0, rateLimited: 0, blocked: 0, awaitingInput: 0, error: 0, dead: 0 };
}

/**
 * Map the 9-status registry union onto the 7 display buckets. "unknown"
 * (booting/indeterminate) counts as running — it's treated as active by the
 * wave logic; "undispatched" (spawned, not yet sent a task) counts as idle.
 */
export function bucketOf(status: AgentStatus): keyof WorkerStatusCounts {
  switch (status) {
    case "running":
    case "unknown":
      return "running";
    case "idle":
    case "undispatched":
      return "idle";
    case "rate-limited":
      return "rateLimited";
    case "blocked-on-you":
      return "blocked";
    case "awaiting-input":
      return "awaitingInput";
    case "error":
      return "error";
    case "dead":
      return "dead";
  }
}

/** Tally a Captain's worker statuses into the display buckets. */
export function countWorkers(statuses: AgentStatus[]): WorkerStatusCounts {
  const c = emptyCounts();
  for (const s of statuses) c[bucketOf(s)]++;
  return c;
}

// ── rendering ──────────────────────────────────────────────────────────────

// Display order + glyph for each non-zero bucket.
const STATUS_GLYPH: ReadonlyArray<readonly [keyof WorkerStatusCounts, string]> = [
  ["running", "r"],
  ["idle", "i"],
  ["rateLimited", "L"],
  ["blocked", "b"],
  ["awaitingInput", "a"],
  ["error", "e"],
  ["dead", "d"],
];

const MAX_SEGMENTS = 6; // beyond this, summarize the tail as "+N more"

function totalWorkers(c: WorkerStatusCounts): number {
  return c.running + c.idle + c.rateLimited + c.blocked + c.awaitingInput + c.error + c.dead;
}

// Raw ANSI (zero runtime deps); each helper is a no-op when color is off, so
// piped output is always clean text.
function wrap(s: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const bold = (s: string, color: boolean) => wrap(s, "1", color);
const dim = (s: string, color: boolean) => wrap(s, "2", color);
const yellow = (s: string, color: boolean) => wrap(s, "33", color);
const red = (s: string, color: boolean) => wrap(s, "31", color);

function captainSegment(s: CaptainBeatSummary, color: boolean): string {
  if (s.beatError) return `${s.session} ${red("✗beat-error", color)}`;
  const parts: string[] = [];
  for (const [key, glyph] of STATUS_GLYPH) {
    const n = s.counts[key];
    if (n > 0) parts.push(`${n}${glyph}`);
  }
  // No workers reads "idle" (the word) — distinct from "1i" (one idle worker).
  if (totalWorkers(s.counts) === 0) return `${s.session} idle`;
  return `${s.session} ${parts.join(" ")}`;
}

/** Roll the per-Captain actions up into one "⚡ …" segment, or undefined if quiet. */
function actionsSegment(captains: CaptainBeatSummary[]): string | undefined {
  let selfHeal = 0;
  let redispatch = 0;
  let donePass = 0;
  let doneExhausted = 0;
  let alerts = 0;
  let wave = false;
  for (const c of captains) {
    const a = c.actions;
    selfHeal += a.selfHeal ?? 0;
    redispatch += a.redispatch ?? 0;
    donePass += a.donePass ?? 0;
    doneExhausted += a.doneExhausted ?? 0;
    alerts += a.alerts ?? 0;
    if (a.waveComplete) wave = true;
  }
  const parts: string[] = [];
  if (selfHeal) parts.push(`self-heal ${selfHeal}`);
  if (redispatch) parts.push(`redispatch ${redispatch}`);
  if (donePass) parts.push(`done-pass ${donePass}`);
  if (doneExhausted) parts.push(`done-exhausted ${doneExhausted}`);
  if (wave) parts.push("wave✓");
  if (alerts) parts.push(`alert ${alerts}`);
  return parts.length ? `⚡ ${parts.join(" · ")}` : undefined;
}

/** Roll telemetry up into a segment, or undefined when nothing's notable. */
function telemetrySegment(captains: CaptainBeatSummary[], color: boolean): string | undefined {
  let spinning = false;
  let unhealthy = false;
  let cpuMax: number | undefined;
  for (const c of captains) {
    if (c.spinning) {
      spinning = true;
      if (c.cpuMaxPct !== undefined) cpuMax = Math.max(cpuMax ?? 0, c.cpuMaxPct);
    }
    if (c.unhealthy) unhealthy = true;
  }
  const parts: string[] = [];
  if (spinning && cpuMax !== undefined) parts.push(yellow(`cpu ${Math.round(cpuMax)}%⚠`, color));
  if (unhealthy) parts.push(red("surface⚠", color));
  return parts.length ? parts.join(" · ") : undefined;
}

/** Compact uptime: `8s`, `47m`, `2h13m`. */
export function formatUptime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * Render the whole beat as ONE line. `opts.color` (default false) gates raw
 * ANSI; callers pass true only when `process.stdout.isTTY` so pipes stay clean.
 */
export function formatBeatLine(model: BeatLineModel, opts: { color?: boolean } = {}): string {
  const color = opts.color === true;
  const head = `[daemon] beat ${bold(String(model.beat), color)} · ${dim(formatUptime(model.uptimeMs), color)}`;
  const time = dim(model.at, color);

  if (model.captains.length === 0) return `${head} · no captains · ${time}`;

  const shown = model.captains.slice(0, MAX_SEGMENTS).map((c) => captainSegment(c, color));
  // Never silently drop a Captain: the tail count covers every overflow, and
  // their actions/telemetry still roll up below (only the breakdown is elided).
  if (model.captains.length > MAX_SEGMENTS) shown.push(`+${model.captains.length - MAX_SEGMENTS} more`);

  const tail = [actionsSegment(model.captains), telemetrySegment(model.captains, color)].filter(
    (x): x is string => x !== undefined,
  );

  return `${head} · ${[...shown, ...tail].join(" · ")} · ${time}`;
}
