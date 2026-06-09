// Daemon config + runtime state, under ~/.fleet/daemon/.
//
// Paths are PER-SESSION (keyed by FLEET_SESSION) so each Captain in a quadrant
// runs an independent daemon. The pre-split singleton files are still read as a
// fallback for the default session, so a daemon launched before the split stays
// visible to `daemon status`/`stop` until it's restarted.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { DEFAULT_SESSION } from "../orchestrator-record.js";

export interface DaemonConfig {
  /** The orchestrator session the daemon reports to. */
  orchestrator: { workspace: string; surface?: string };
  /** The fleet session (registry) the daemon watches — bound to the orchestrator. */
  session?: string;
  heartbeatSec: number;
  /** A "running" worker whose screen hasn't changed for this long is "stuck". */
  stuckMinutes: number;
  /** Min seconds between repeat alerts for the same agent+condition. */
  alertCooldownSec: number;
  /** Proactive idle-initiative wake-prompts on wave completion. */
  proactive: boolean;
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  lastBeatAt: string;
  ticks: number;
  /** The cmux workspace the daemon runs in (so `stop` can close it). */
  daemonWorkspace?: string;
}

export function daemonDir(): string {
  return join(homedir(), ".fleet", "daemon");
}

/** The session this daemon's files are keyed by (FLEET_SESSION → default). */
function daemonSession(): string {
  return process.env.FLEET_SESSION ?? DEFAULT_SESSION;
}

export const configPath = () => join(daemonDir(), `config-${daemonSession()}.json`);
export const statePath = () => join(daemonDir(), `state-${daemonSession()}.json`);
export const inboxPath = () => join(daemonDir(), `inbox-${daemonSession()}.md`);

// Pre-split singleton paths — read-only fallbacks for the default session.
const legacyConfigPath = () => join(daemonDir(), "config.json");
const legacyStatePath = () => join(daemonDir(), "state.json");
const legacyInboxPath = () => join(daemonDir(), "inbox.md");

/** A read path that prefers the per-session file but falls back to the legacy
 *  singleton for the default session (so a pre-split daemon stays discoverable). */
function readPath(perSession: string, legacy: string): string {
  if (existsSync(perSession)) return perSession;
  if (daemonSession() === DEFAULT_SESSION && existsSync(legacy)) return legacy;
  return perSession;
}

export const DAEMON_DEFAULTS = {
  heartbeatSec: 12,
  stuckMinutes: 8,
  alertCooldownSec: 300,
  proactive: true,
};

export function saveConfig(cfg: DaemonConfig): void {
  mkdirSync(daemonDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function loadConfig(): DaemonConfig | undefined {
  const p = readPath(configPath(), legacyConfigPath());
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonConfig;
  } catch {
    return undefined;
  }
}

export function writeState(state: DaemonState): void {
  mkdirSync(daemonDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  // atomic-ish replace
  writeFileSync(statePath(), readFileSync(tmp));
}

export function readState(): DaemonState | undefined {
  const p = readPath(statePath(), legacyStatePath());
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonState;
  } catch {
    return undefined;
  }
}

/** Is a recorded daemon still alive? (signal 0 = liveness probe) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
