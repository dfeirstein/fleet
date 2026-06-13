// `fleet gc [--apply]` — sweep dead-session residue out of ~/.fleet.
//
// ~/.fleet accumulates a registry JSON, a `.state.json`, a capture dir, and a
// daemon state file per fleet session. Finished test/demo/old sessions leave all
// of that behind; there was no cleanup verb (issue #40). `gc` lists (default) or
// removes (`--apply`) that residue for sessions that are provably dead: no live
// Captain AND no live worker.
//
// It FAILS CLOSED. The keep/remove decision is a pure module (`planGc`, tested);
// the impure shell discovers sessions, probes cmux for liveness, and — only when
// cmux is reachable so an "absent" answer is trustworthy — removes. If cmux can't
// be reached, every check is "unverifiable" and nothing is touched. The protected
// set (outcomes logs, briefs, browser-states, worktrees, shared daemon files,
// orchestrator records/prompts) is never enumerated as eligible in the first place.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { listSurfaces, listGridCells, cmuxJson, isGone } from "../cmux.js";
import { handle, type Agent } from "../registry.js";
import { loadAllOrchestrators, type OrchestratorRecord } from "../orchestrator-record.js";

// ── The keep/remove decision (pure; node:test) ───────────────────────────────

export type Liveness = "live" | "dead" | "unverifiable";

export interface SessionLiveness {
  session: string;
  /** The session's declared Captain: live (its surface exists), absent (no
   *  orchestrator record), or unverifiable (cmux unreachable, record present). */
  captain: "live" | "absent" | "unverifiable";
  /** Per-worker liveness, drawn from the session's registry. */
  workers: Liveness[];
}

export interface GcDecision {
  session: string;
  action: "keep" | "remove";
  reason: string;
}

/**
 * Decide each session's fate from its liveness signals. A session is removed
 * ONLY when every signal is a confirmed negative: no live Captain, no live
 * worker, and nothing unverifiable. Any live signal or any unverifiable check
 * keeps it (fail closed — an unresolvable check is treated as "might be alive").
 */
export function planGc(sessions: SessionLiveness[]): GcDecision[] {
  return sessions.map((s) => {
    if (s.captain === "live") {
      return { session: s.session, action: "keep", reason: "live Captain" };
    }
    if (s.workers.includes("live")) {
      return { session: s.session, action: "keep", reason: "live worker(s)" };
    }
    if (s.captain === "unverifiable" || s.workers.includes("unverifiable")) {
      return { session: s.session, action: "keep", reason: "kept (unverifiable — cmux check failed)" };
    }
    return { session: s.session, action: "remove", reason: "dead — no live Captain, no live workers" };
  });
}

// ── The eligible-residue enumeration (pure path math) ─────────────────────────

export type GcItemKind = "registry" | "state" | "capture-dir" | "daemon-state" | "daemon-state-tmp";

export interface GcItem {
  kind: GcItemKind;
  path: string;
}

export interface GcSessionPlan {
  session: string;
  action: "keep" | "remove";
  reason: string;
  /** Files that exist and are eligible (populated for `remove` sessions only). */
  items: GcItem[];
}

export interface GcResult {
  apply: boolean;
  reachable: boolean;
  plans: GcSessionPlan[];
  /** Absolute paths actually removed (`--apply` only). */
  removed: string[];
}

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

function daemonDir(): string {
  return join(fleetDir(), "daemon");
}

// Root entries that are NEVER a session's residue — shared state, cross-session
// learning history, and live-asset dirs. A "session" matching one of these names
// is ignored so a name collision can never delete a protected dir.
const RESERVED = new Set(["briefs", "browser-states", "daemon", "worktrees", "verify-artifacts"]);

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A session name must be a plain slug — never a path or a reserved root entry. */
function isSessionName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes("..") && !RESERVED.has(name);
}

/**
 * Every session that has removable residue or a liveness record under ~/.fleet:
 * registry `<s>.json`, state `<s>.state.json`, a capture dir `<s>/` (identified
 * by its `capture/` subdir — fleet's own layout, so an arbitrary dir is never
 * mistaken for one), daemon `state-<s>.json(.tmp)`, and orchestrator records.
 * Outcomes logs and daemon inboxes are protected and intentionally NOT seeded.
 */
export function discoverSessions(): string[] {
  const sessions = new Set<string>();
  for (const name of readdirSafe(fleetDir())) {
    if (RESERVED.has(name)) continue;
    const full = join(fleetDir(), name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (existsSync(join(full, "capture")) && isSessionName(name)) sessions.add(name);
      continue;
    }
    let s: string | undefined;
    if (name.endsWith(".state.json")) s = name.slice(0, -".state.json".length);
    else if (name.startsWith("orchestrator-") && name.endsWith(".json") && !name.startsWith("orchestrator-prompt-"))
      s = name.slice("orchestrator-".length, -".json".length);
    else if (name.endsWith(".json") && !name.endsWith(".lock") && !name.startsWith("orchestrator-"))
      s = name.slice(0, -".json".length);
    if (s && isSessionName(s)) sessions.add(s);
  }
  for (const name of readdirSafe(daemonDir())) {
    const m = /^state-(.+?)\.json(?:\..*\.tmp)?$/.exec(name);
    if (m && isSessionName(m[1]!)) sessions.add(m[1]!);
  }
  return [...sessions].sort();
}

export interface RegistryRead {
  agents: Agent[];
  /** Registry file present but unparseable — we can't enumerate its workers, so
   *  the session's liveness is indeterminate (must KEEP, never remove). An ABSENT
   *  registry is not unreadable: a session legitimately has no workers. */
  unreadable: boolean;
}

/** Read a session's registry agents directly (the registry module is env-keyed
 *  to ONE session; gc spans all of them, so it reads each file by path). */
function loadAgents(session: string): RegistryRead {
  const path = join(fleetDir(), `${session}.json`);
  if (!existsSync(path)) return { agents: [], unreadable: false };
  try {
    const reg = JSON.parse(readFileSync(path, "utf8")) as { agents?: Record<string, Agent> };
    return { agents: Object.values(reg.agents ?? {}), unreadable: false };
  } catch {
    return { agents: [], unreadable: true };
  }
}

/** True if cmux answers at all — a fast upfront gate. When false the whole sweep
 *  short-circuits to keep-everything (see `gc`); per-check probes below still
 *  fail closed if cmux dies MID-sweep after answering here. */
function cmuxReachable(): boolean {
  try {
    cmuxJson(["rpc", "workspace.list"]);
    return true;
  } catch {
    return false;
  }
}

// ── Error-distinguishing existence checks (the fail-closed core) ──────────────
// The swallow-to-false helpers in cmux.ts can't tell "gone" from "cmux errored",
// so a transient error would read as dead and `--apply` would delete a LIVE
// session. These return a THIRD state, "unknown", for any non-`not_found` failure
// — which maps to `unverifiable` → KEEP. `isGone` (the not_found discriminator)
// now lives in cmux.ts so the status probe shares the SAME tri-state check;
// re-exported here for the existing gc tests.
export { isGone };

export type Existence = "present" | "absent" | "unknown";

/** Worker liveness: its workspace is present / absent / indeterminate. */
function workspacePresence(workspace: string): Existence {
  try {
    listSurfaces(workspace, { quietStderr: true });
    return "present";
  } catch (e) {
    return isGone(e) ? "absent" : "unknown";
  }
}

/** Captain liveness: its surface is present / absent / indeterminate. A reachable
 *  workspace whose grid holds no matching surface is a clean "absent"; only a
 *  non-`not_found` throw is "unknown". */
function surfacePresence(workspace: string, surface: string): Existence {
  try {
    return listGridCells(workspace, { quietStderr: true }).some((c) => c.surfaceId === surface)
      ? "present"
      : "absent";
  } catch (e) {
    return isGone(e) ? "absent" : "unknown";
  }
}

/** Injected liveness sources — real ones in `gc`, fakes in tests so the
 *  Existence→Liveness mapping (the fail-closed heart) is unit-testable. */
export interface LivenessProbes {
  orchestrators: OrchestratorRecord[];
  surface(workspace: string, surface: string): Existence;
  workspace(workspace: string): Existence;
  readRegistry(session: string): RegistryRead;
}

/** Map a session's raw signals to keep/remove liveness. Called ONLY when cmux
 *  answered upfront; every per-check `unknown` (a probe that errored without a
 *  `not_found`) becomes `unverifiable` so planGc keeps the session. */
export function sessionLiveness(session: string, probes: LivenessProbes): SessionLiveness {
  const rec = probes.orchestrators.find((o) => o.session === session);
  let captain: SessionLiveness["captain"];
  if (!rec) {
    captain = "absent";
  } else if (!rec.workspaceId || !rec.surfaceId) {
    captain = "unverifiable"; // malformed record — can't confirm dead, so keep
  } else {
    const p = probes.surface(rec.workspaceId, rec.surfaceId);
    captain = p === "present" ? "live" : p === "absent" ? "absent" : "unverifiable";
  }
  const read = probes.readRegistry(session);
  const workers: Liveness[] = read.unreadable
    ? ["unverifiable"] // registry exists but unparseable — indeterminate, keep
    : read.agents.map((a) => {
        const p = probes.workspace(handle(a));
        return p === "present" ? "live" : p === "absent" ? "dead" : "unverifiable";
      });
  return { session, captain, workers };
}

/** Eligible residue for a session that EXISTS on disk (existence-filtered). */
function eligibleItems(session: string): GcItem[] {
  const items: GcItem[] = [];
  const reg = join(fleetDir(), `${session}.json`);
  if (existsSync(reg)) items.push({ kind: "registry", path: reg });
  const state = join(fleetDir(), `${session}.state.json`);
  if (existsSync(state)) items.push({ kind: "state", path: state });
  const cap = join(fleetDir(), session);
  if (existsSync(cap) && statSync(cap).isDirectory()) items.push({ kind: "capture-dir", path: cap });
  const dState = join(daemonDir(), `state-${session}.json`);
  if (existsSync(dState)) items.push({ kind: "daemon-state", path: dState });
  for (const f of readdirSafe(daemonDir())) {
    if (f.startsWith(`state-${session}.json.`) && f.endsWith(".tmp"))
      items.push({ kind: "daemon-state-tmp", path: join(daemonDir(), f) });
  }
  return items;
}

export function gc(opts: { apply?: boolean } = {}): GcResult {
  const apply = opts.apply === true;
  const reachable = cmuxReachable();
  const sessions = discoverSessions();
  // cmux down → keep everything (nothing can be confirmed dead). Hoist the
  // orchestrator records once (read per-session before — the nit).
  const probes: LivenessProbes = {
    orchestrators: loadAllOrchestrators(),
    surface: surfacePresence,
    workspace: workspacePresence,
    readRegistry: loadAgents,
  };
  const decisions: GcDecision[] = reachable
    ? planGc(sessions.map((s) => sessionLiveness(s, probes)))
    : sessions.map((s) => ({
        session: s,
        action: "keep" as const,
        reason: "kept (unverifiable — cmux unreachable)",
      }));
  const removed: string[] = [];
  const plans: GcSessionPlan[] = decisions.map((d) => {
    const items = d.action === "remove" ? eligibleItems(d.session) : [];
    if (apply && d.action === "remove") {
      for (const it of items) {
        rmSync(it.path, { recursive: true, force: true });
        removed.push(it.path);
      }
    }
    return { session: d.session, action: d.action, reason: d.reason, items };
  });
  return { apply, reachable, plans, removed };
}
