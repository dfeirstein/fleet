// Typed reader for cmux's durable session map: ~/.cmuxterm/claude-hook-sessions.json.
//
// cmux maintains this file across app restarts (agent-hooks.md): per-session
// agentLifecycle (running/idle/needsInput), session↔workspace/surface mapping,
// and the sanitized launch argv — enough to re-link restored workspaces to
// registry entries and rebuild `claude --resume` invocations after a cmux
// restart strands the registry.
//
// The file is cmux-INTERNAL and could change shape silently, so treat it as
// external/untrusted input: validate every entry, skip what doesn't parse, and
// a missing/corrupt file degrades to "no data" (callers behave exactly as
// before this module existed). Read-only — cmux owns the `.lock` beside it.
// This module reads a FILE, not the cmux CLI, so it lives beside the registry
// rather than behind the src/cmux.ts seam.
//
// Format fact (verified live, cmux 0.64.12): the file keys sessions by BARE
// uuid, while the event stream / feed key the same session as `claude-<uuid>`
// (see workstreamKeys below).
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AgentStatus } from "./registry.js";

export type AgentLifecycle = "running" | "idle" | "needsInput";

/** One validated session record (only the fields fleet consumes). */
export interface DurableSession {
  sessionId: string; // bare claude session uuid
  workspaceId?: string;
  surfaceId?: string;
  cwd?: string;
  agentLifecycle?: AgentLifecycle;
  isRestorable?: boolean;
  /** Epoch SECONDS (cmux writes fractional unix time). */
  updatedAt?: number;
  /** Sanitized launch argv; [0] is the executable path. */
  launchArgs?: string[];
}

export interface DurableSessionMap {
  sessions: DurableSession[];
  /** workspaceId → the workspace's active sessionId. */
  activeSessionByWorkspace: Map<string, string>;
}

export function hookSessionsPath(): string {
  return join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Pure shape validation: raw file text → validated map, or undefined when the
 *  whole document is unusable. Individually bad entries are skipped, not fatal. */
export function parseHookSessions(raw: string): DurableSessionMap | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;

  const sessions: DurableSession[] = [];
  const sessRec = isRecord(data["sessions"]) ? (data["sessions"] as Record<string, unknown>) : {};
  for (const [key, v] of Object.entries(sessRec)) {
    if (!isRecord(v)) continue;
    const sessionId = str(v["sessionId"]) ?? key;
    if (!sessionId) continue;
    const lc = v["agentLifecycle"];
    const launch = isRecord(v["launchCommand"]) ? v["launchCommand"] : undefined;
    const rawArgs = launch?.["arguments"];
    const launchArgs = Array.isArray(rawArgs)
      ? rawArgs.filter((a): a is string => typeof a === "string")
      : undefined;
    sessions.push({
      sessionId,
      workspaceId: str(v["workspaceId"]),
      surfaceId: str(v["surfaceId"]),
      cwd: str(v["cwd"]),
      agentLifecycle: lc === "running" || lc === "idle" || lc === "needsInput" ? lc : undefined,
      isRestorable: typeof v["isRestorable"] === "boolean" ? v["isRestorable"] : undefined,
      updatedAt: typeof v["updatedAt"] === "number" ? v["updatedAt"] : undefined,
      launchArgs: launchArgs?.length ? launchArgs : undefined,
    });
  }

  const activeSessionByWorkspace = new Map<string, string>();
  const actRec = isRecord(data["activeSessionsByWorkspace"])
    ? (data["activeSessionsByWorkspace"] as Record<string, unknown>)
    : {};
  for (const [ws, v] of Object.entries(actRec)) {
    if (!isRecord(v)) continue;
    const sid = str(v["sessionId"]);
    if (sid) activeSessionByWorkspace.set(ws, sid);
  }

  return { sessions, activeSessionByWorkspace };
}

/** Read + validate the durable file. Missing/unreadable/corrupt → undefined,
 *  so every consumer degrades to pre-durable-map behavior. Reads lazily (on
 *  call, never at module load — the file can be large). */
export function readHookSessions(path = hookSessionsPath()): DurableSessionMap | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseHookSessions(raw);
}

/** The event-stream/feed keys for a durable session: feed `workstream_id` and
 *  agent.hook `session_id` are `claude-<uuid>` while this file stores the bare
 *  uuid (verified live) — return both so map seeding matches either form. */
export function workstreamKeys(sessionId: string): string[] {
  return sessionId.startsWith("claude-") ? [sessionId] : [sessionId, `claude-${sessionId}`];
}

/**
 * Find the durable session for a registered worker. Match strength order:
 * surfaceId (unique per pane) → workspaceId (the active-session index first,
 * then any session in that workspace) → cwd, only when exactly ONE session ran
 * there (same-project siblings share a cwd — an ambiguous match is no match).
 */
export function findSession(
  map: DurableSessionMap,
  probe: { surfaceId?: string; workspaceId?: string; cwds?: (string | undefined)[] },
): DurableSession | undefined {
  if (probe.surfaceId) {
    const hit = map.sessions.find((s) => s.surfaceId === probe.surfaceId);
    if (hit) return hit;
  }
  if (probe.workspaceId) {
    const activeSid = map.activeSessionByWorkspace.get(probe.workspaceId);
    const hit =
      (activeSid && map.sessions.find((s) => s.sessionId === activeSid)) ||
      map.sessions.find((s) => s.workspaceId === probe.workspaceId);
    if (hit) return hit;
  }
  for (const cwd of probe.cwds ?? []) {
    if (!cwd) continue;
    const hits = map.sessions.filter((s) => s.cwd === cwd);
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=@%^+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The exact shell invocation that resumes this session with its full context,
 *  built from the sanitized captured argv + `--resume <sessionId>` (any stale
 *  `--resume` pair from a previous resume is dropped first). */
export function resumeCommand(s: DurableSession): string {
  const argv = s.launchArgs?.length ? [...s.launchArgs] : ["claude"];
  const i = argv.indexOf("--resume");
  if (i >= 0) argv.splice(i, 2);
  argv.push("--resume", s.sessionId);
  return argv.map(shellQuote).join(" ");
}

/** A `running` lifecycle self-refreshes (every hook event advances updatedAt),
 *  so a stale `running` means the worker is NOT running anymore. */
export const RUNNING_FRESH_MS = 120_000;

/**
 * Map a durable lifecycle to a fleet status HINT — consulted only when the
 * screen probe is `unknown`, never overriding live evidence (probe-running
 * wins; see classifyLive). idle/needsInput are resting states and stay valid
 * indefinitely; `running` is trusted only while fresh (see RUNNING_FRESH_MS).
 */
export function lifecycleHint(
  s: DurableSession,
  nowMs: number,
): Extract<AgentStatus, "running" | "idle" | "awaiting-input"> | undefined {
  switch (s.agentLifecycle) {
    case "idle":
      return "idle";
    case "needsInput":
      return "awaiting-input";
    case "running":
      return nowMs - (s.updatedAt ?? 0) * 1000 <= RUNNING_FRESH_MS ? "running" : undefined;
    default:
      return undefined;
  }
}
