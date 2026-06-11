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
import { workspaceExists, surfaceExists, cmuxJson } from "../cmux.js";
import { handle, type Agent } from "../registry.js";
import { loadAllOrchestrators } from "../orchestrator-record.js";

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

/** Read a session's registry agents directly (the registry module is env-keyed
 *  to ONE session; gc spans all of them, so it reads each file by path). */
function loadAgents(session: string): Agent[] {
  const path = join(fleetDir(), `${session}.json`);
  if (!existsSync(path)) return [];
  try {
    const reg = JSON.parse(readFileSync(path, "utf8")) as { agents?: Record<string, Agent> };
    return Object.values(reg.agents ?? {});
  } catch {
    return [];
  }
}

/** True if cmux answers at all — the gate for trusting an "absent" existence
 *  answer. When false, every liveness check is reported unverifiable. */
function cmuxReachable(): boolean {
  try {
    cmuxJson(["rpc", "workspace.list"]);
    return true;
  } catch {
    return false;
  }
}

function sessionLiveness(session: string, reachable: boolean): SessionLiveness {
  const captainRec = loadAllOrchestrators().find((o) => o.session === session);
  const captain: SessionLiveness["captain"] = !captainRec
    ? "absent"
    : !reachable
      ? "unverifiable"
      : captainRec.workspaceId &&
          captainRec.surfaceId &&
          surfaceExists({ workspace: captainRec.workspaceId, surface: captainRec.surfaceId })
        ? "live"
        : "absent";
  const workers: Liveness[] = loadAgents(session).map((a) =>
    !reachable ? "unverifiable" : workspaceExists(handle(a)) ? "live" : "dead",
  );
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
  const decisions = planGc(discoverSessions().map((s) => sessionLiveness(s, reachable)));
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
