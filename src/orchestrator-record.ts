// The declared orchestrator — a role pinned to a cmux workspace. Shared by the
// registry (to bind session), the daemon (to target + namespace), and the
// orchestrate command (to write it). Kept dependency-free to avoid cycles.
//
// Records are PER-SESSION: `~/.fleet/orchestrator-<session>.json`, keyed by
// FLEET_SESSION. This lets sibling Captains (a quadrant) coexist without one
// re-pointing another's daemon. The legacy singleton `~/.fleet/orchestrator.json`
// is still read as the default session's record so a Captain declared before the
// per-session split isn't stranded.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OrchestratorRecord {
  name: string;
  session: string;
  workspaceId: string;
  surfaceId: string;
  workspaceRef: string;
  declaredAt: string;
}

/** The default session when FLEET_SESSION is unset — the base Captain. */
export const DEFAULT_SESSION = "yoshi";

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

/** The pre-split singleton path, kept for backward-compat reads only. */
function legacyPath(): string {
  return join(fleetDir(), "orchestrator.json");
}

/** The session a record belongs to: explicit arg → FLEET_SESSION → default. */
export function orchestratorSession(session?: string): string {
  return session ?? process.env.FLEET_SESSION ?? DEFAULT_SESSION;
}

/** Per-session orchestrator record path, keyed by session. */
export function orchestratorPath(session?: string): string {
  return join(fleetDir(), `orchestrator-${orchestratorSession(session)}.json`);
}

function readRecord(path: string): OrchestratorRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OrchestratorRecord;
  } catch {
    return undefined;
  }
}

export function loadOrchestrator(session?: string): OrchestratorRecord | undefined {
  const rec = readRecord(orchestratorPath(session));
  if (rec) return rec;
  // Backward-compat: the legacy singleton stands in for the default session until
  // it's re-declared per-session (don't strand a Captain started pre-split).
  if (orchestratorSession(session) === DEFAULT_SESSION) return readRecord(legacyPath());
  return undefined;
}

/**
 * Every live orchestrator record — the per-session files plus the legacy
 * singleton (as the default session, if no per-session file shadows it). Used to
 * detect which Captain owns a given workspace and to count a family's quadrant.
 */
export function loadAllOrchestrators(): OrchestratorRecord[] {
  const out: OrchestratorRecord[] = [];
  const sessions = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(fleetDir());
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!/^orchestrator-.+\.json$/.test(f)) continue;
    const rec = readRecord(join(fleetDir(), f));
    if (rec) {
      out.push(rec);
      sessions.add(rec.session);
    }
  }
  if (!sessions.has(DEFAULT_SESSION)) {
    const legacy = readRecord(legacyPath());
    if (legacy) out.push(legacy);
  }
  return out;
}
