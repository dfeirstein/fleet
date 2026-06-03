// Daemon config + runtime state, under ~/.fleet/daemon/.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface DaemonConfig {
  /** The orchestrator session the daemon reports to. */
  orchestrator: { workspace: string; surface?: string };
  heartbeatSec: number;
  /** A "running" worker whose screen hasn't changed for this long is "stuck". */
  stuckMinutes: number;
  /** Min seconds between repeat alerts for the same agent+condition. */
  alertCooldownSec: number;
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
export const configPath = () => join(daemonDir(), "config.json");
export const statePath = () => join(daemonDir(), "state.json");
export const inboxPath = () => join(daemonDir(), "inbox.md");

export const DAEMON_DEFAULTS = {
  heartbeatSec: 12,
  stuckMinutes: 8,
  alertCooldownSec: 300,
};

export function saveConfig(cfg: DaemonConfig): void {
  mkdirSync(daemonDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function loadConfig(): DaemonConfig | undefined {
  if (!existsSync(configPath())) return undefined;
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as DaemonConfig;
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
  if (!existsSync(statePath())) return undefined;
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as DaemonState;
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
