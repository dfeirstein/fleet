// Daemon config + runtime state, under ~/.fleet/daemon/.
//
// Paths are PER-SESSION (keyed by FLEET_SESSION) so each Captain in a quadrant
// runs an independent daemon. The pre-split singleton files are still read as a
// fallback for the default session, so a daemon launched before the split stays
// visible to `daemon status`/`stop` until it's restarted.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";
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
  /** Resource guardrails (Captain NUDGES only — the daemon never auto-kills).
   *  A worker above cpuHogPercent for cpuHogBeats consecutive beats, or whose
   *  resident set exceeds memHogMb, gets escalated. Capability-gated on
   *  `cmux top`; an older cmux skips the check entirely. */
  cpuHogPercent: number;
  cpuHogBeats: number;
  memHogMb: number;
  /** Sidebar state-lamp overrides (state → color/label), merged over the
   *  defaults in src/sidebar.ts — partial configs keep the rest. */
  sidebarColors?: Record<string, string>;
  sidebarLabels?: Record<string, string>;
  /** Context guard (src/daemon/ctx.ts + evaluateContextOccupancy). Thresholds
   *  are STARTING HYPOTHESES, configurable per the research doc — never a
   *  hard-coded universal number. Tune via ~/.fleet/daemon/shared-config.json.
   *  At cautionPct a session should compact at its next breakpoint; it must
   *  always compact before hardPct. */
  contextCautionPct: number;
  contextHardPct: number;
  /** Drive `/compact` to an idle worker ourselves (true) vs nudge-only (false). */
  contextAutoCompactWorkers: boolean;
  /** Drive `/compact` to an idle Captain ourselves (default false → nudge-only:
   *  the Captain persists `fleet state`, compacts, then reloads `fleet state`). */
  contextAutoCompactCaptain: boolean;
  /** Min seconds between an auto-`/compact` and the follow-up escalation if it
   *  didn't take (so we don't re-`/compact` forever). */
  contextCompactCooldownSec: number;
  /** Worker-launch backstop: the value exported as CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
   *  on a worker's claude launch line, so Claude Code's own auto-compaction kicks
   *  in if the daemon ever misses. Sits between caution and hard (60). */
  contextBackstopPct: number;
}

export function daemonDir(): string {
  return join(homedir(), ".fleet", "daemon");
}

/** The session a Captain's per-session inbox is keyed by (FLEET_SESSION →
 *  default). The shared daemon routes each Captain's messages under its own
 *  FLEET_SESSION, so this stays per-Captain even though the daemon is one. */
function daemonSession(): string {
  return process.env.FLEET_SESSION ?? DEFAULT_SESSION;
}

/** Per-Captain routine-message inbox (the channel the orchestrator reads). */
export const inboxPath = () => join(daemonDir(), `inbox-${daemonSession()}.md`);

export const DAEMON_DEFAULTS = {
  heartbeatSec: 12,
  stuckMinutes: 8,
  alertCooldownSec: 300,
  proactive: true,
  // Guardrail defaults: sustained >90% CPU (of one core; macOS accounting) for
  // 5 beats, or >4GB resident. Tunable via ~/.fleet/daemon/shared-config.json.
  cpuHogPercent: 90,
  cpuHogBeats: 5,
  memHogMb: 4096,
  // Context guard: compact at 50% (next breakpoint), hard ceiling 66%. Workers
  // auto-`/compact` when idle; the Captain is nudge-only by default (it must
  // persist `fleet state` before compacting). 10-min cooldown before escalating
  // a `/compact` that didn't take. All starting hypotheses — tune in config.
  contextCautionPct: 50,
  contextHardPct: 66,
  contextAutoCompactWorkers: true,
  contextAutoCompactCaptain: false,
  contextCompactCooldownSec: 600,
  contextBackstopPct: 60,
};

/** Is a recorded daemon still alive? (signal 0 = liveness probe) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── Shared daemon ─────────────────────────────
// ONE daemon watches ALL live Captains. Its lock/state are session-AGNOSTIC
// (unlike the per-session config/state above, which remain for the legacy
// per-Captain daemon until the live cutover). The pid file is the single-
// instance lock; the loop owns it and reclaims it if stale.

const fleetHome = (): string => join(homedir(), ".fleet");

/** Single-instance lock for the shared daemon (spec: ~/.fleet/daemon.pid). */
export const sharedPidPath = (): string => join(fleetHome(), "daemon.pid");
/** Runtime state for `fleet daemon status` (pid, beats, watched Captains). */
export const sharedStatePath = (): string => join(daemonDir(), "shared-state.json");
/** Tunables for the shared daemon (heartbeat/stuck/cooldown/proactive). */
export const sharedSettingsPath = (): string => join(daemonDir(), "shared-config.json");

/** Per-Captain tunables the shared loop applies to every watched Captain. */
export type SharedSettings = Omit<DaemonConfig, "orchestrator" | "session">;

export interface SharedDaemonState {
  pid: number;
  startedAt: string;
  lastBeatAt: string;
  ticks: number;
  /** The cmux workspace the shared daemon runs in (so `stop` can close it). */
  daemonWorkspace?: string;
  /** Sessions of the Captains watched as of the last beat. */
  watching: string[];
}

export function loadSharedSettings(): SharedSettings {
  try {
    const raw = JSON.parse(readFileSync(sharedSettingsPath(), "utf8")) as Partial<SharedSettings>;
    return { ...DAEMON_DEFAULTS, ...raw };
  } catch {
    return { ...DAEMON_DEFAULTS };
  }
}

export function saveSharedSettings(s: SharedSettings): void {
  mkdirSync(daemonDir(), { recursive: true });
  writeFileSync(sharedSettingsPath(), JSON.stringify(s, null, 2));
}

export function readSharedState(): SharedDaemonState | undefined {
  if (!existsSync(sharedStatePath())) return undefined;
  try {
    return JSON.parse(readFileSync(sharedStatePath(), "utf8")) as SharedDaemonState;
  } catch {
    return undefined;
  }
}

export function writeSharedState(state: SharedDaemonState): void {
  mkdirSync(daemonDir(), { recursive: true });
  const tmp = `${sharedStatePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, sharedStatePath()); // atomic replace
}

export function removeSharedState(): void {
  try {
    rmSync(sharedStatePath());
  } catch {
    /* ignore */
  }
}

/** The pid recorded in the lock file, if any. */
export function readSharedDaemonPid(): number | undefined {
  try {
    const n = Number(readFileSync(sharedPidPath(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Is the ONE shared daemon currently running? */
export function sharedDaemonRunning(): boolean {
  const pid = readSharedDaemonPid();
  return pid !== undefined && pidAlive(pid);
}

/**
 * Atomically claim the single-instance lock. Returns true iff acquired. An
 * O_EXCL create means only one racing loop wins; a stale pid file (owner no
 * longer alive) is reclaimed once. The WINNER becomes the shared daemon; any
 * loser exits (see runLoop), so a double `--split` can never double-start.
 */
export function acquireSharedLock(): boolean {
  mkdirSync(fleetHome(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(sharedPidPath(), "wx"); // O_EXCL: fails if it exists
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      const owner = readSharedDaemonPid();
      if (owner !== undefined && owner !== process.pid && pidAlive(owner)) return false; // live owner
      // stale (or our own leftover) — drop it and retry once
      try {
        rmSync(sharedPidPath());
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/** Release the lock, but only if we still own it. */
export function releaseSharedLock(): void {
  const owner = readSharedDaemonPid();
  if (owner === undefined || owner === process.pid) {
    try {
      rmSync(sharedPidPath());
    } catch {
      /* ignore */
    }
  }
}
