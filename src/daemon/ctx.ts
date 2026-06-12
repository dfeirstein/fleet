// Context-occupancy telemetry: read + validate the per-session sidecars the
// statusline writes to ~/.fleet/ctx/<session_id>.json on each refresh, and
// classify each into a fresh-or-UNKNOWN occupancy reading.
//
// FAIL CLOSED (CLAUDE.md): a missing dir, corrupt JSON, an off-schema record, or
// a reading older than the staleness window all collapse to UNKNOWN — the
// context guard takes NO compaction action on unknown data and never reports it
// as healthy (the policy in policy.ts enforces this; this module only surfaces
// `known`). Pure parsing/classification lives here so it's unit-testable; the
// only impure edge is `readSidecars` (one readdir + readFileSync per file).
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

/** A reading older than this is UNKNOWN (the statusline refreshes ~every 300ms
 *  while active, so 10 minutes of silence means the session is gone/parked). */
export const CTX_STALE_SEC = 600;

/** The sidecar contract written by the statusline (schema 1). Only the fields
 *  the guard consumes are required at parse time; the rest are best-effort. */
export interface CtxSidecar {
  schema: number;
  session_id: string;
  /** Epoch SECONDS of the last statusline refresh. */
  ts: number;
  /** Context window occupancy, 0–100. */
  pct: number;
  used_tokens?: number;
  window_tokens?: number;
  model?: string;
  cwd?: string;
  cost_usd?: number;
  /** The fleet session name (empty/absent for non-fleet sessions). */
  fleet_session?: string;
  /** The worker's FLEET_AGENT_ID (empty/absent for a Captain or non-fleet session). */
  fleet_agent_id?: string;
  compactions?: number;
  hist?: [number, number][];
}

/** A classified occupancy reading. `known: false` is UNKNOWN — fail closed. */
export interface Occupancy {
  /** True only on a fresh, valid reading; false → no action, never "healthy". */
  known: boolean;
  /** Occupancy percent (meaningful only when `known`; carried even when stale
   *  so callers can show a dimmed value if they choose). */
  pct: number;
  /** A sidecar existed but its `ts` is past the staleness window. */
  stale: boolean;
  /** The sidecar's monotonic `compactions` counter (when present) — an increment
   *  between readings means the session compacted even if we missed the dip. */
  compactions?: number;
}

export function ctxDir(): string {
  return join(homedir(), ".fleet", "ctx");
}

/**
 * Parse + validate one sidecar's raw JSON. Returns undefined on anything that
 * isn't a well-formed reading (bad JSON, missing/!numeric ts or pct, pct out of
 * range, non-string session_id) — the caller treats undefined as "no reading".
 */
export function parseSidecar(raw: string): CtxSidecar | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.session_id !== "string") return undefined;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return undefined;
  if (typeof o.pct !== "number" || !Number.isFinite(o.pct) || o.pct < 0 || o.pct > 100) return undefined;
  return o as unknown as CtxSidecar;
}

/**
 * Read every valid sidecar from `dir` (defaults to ~/.fleet/ctx). A missing
 * directory or an unreadable/corrupt file is skipped, never thrown — the guard
 * degrades to UNKNOWN for the affected sessions, never crashes the beat.
 */
export function readSidecars(dir = ctxDir()): CtxSidecar[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no dir yet (statusline never ran) → everything UNKNOWN
  }
  const out: CtxSidecar[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const sc = parseSidecar(readFileSync(join(dir, f), "utf8"));
      if (sc) out.push(sc);
    } catch {
      /* unreadable this beat — skip (UNKNOWN) */
    }
  }
  return out;
}

/** Classify a (possibly absent) sidecar into a fresh-or-UNKNOWN reading. */
export function classifyOccupancy(
  sidecar: CtxSidecar | undefined,
  nowSec: number,
  staleSec = CTX_STALE_SEC,
): Occupancy {
  if (!sidecar) return { known: false, pct: 0, stale: false };
  const stale = nowSec - sidecar.ts > staleSec;
  return {
    known: !stale,
    pct: sidecar.pct,
    stale,
    compactions: typeof sidecar.compactions === "number" ? sidecar.compactions : undefined,
  };
}

/** The sidecar for a worker — matched by FLEET_AGENT_ID (workers inherit it). */
export function workerSidecar(sidecars: CtxSidecar[], agentId: string): CtxSidecar | undefined {
  return sidecars.find((s) => s.fleet_agent_id === agentId);
}

/**
 * The Captain's sidecar — matched by `fleet_session` == the Captain's session
 * with an empty `fleet_agent_id` (a Captain is a fleet session that owns no
 * agent id). The brief lists a cwd fallback, but the orchestrator record stores
 * no cwd, so we match on session only (see context-guard.md).
 */
export function captainSidecar(sidecars: CtxSidecar[], session: string): CtxSidecar | undefined {
  return sidecars.find((s) => !s.fleet_agent_id && s.fleet_session === session);
}
