// Heartbeat policy: turn a worker's observed state into an escalation message,
// with per-agent+condition cooldown so a persistent condition alerts once, not
// every tick. Bounded autonomy — the daemon ACTS only on safe things (handled
// in loop.ts, e.g. clearing a stuck bypass dialog); everything risky is
// surfaced here for the orchestrator to decide.

import { IdleDwell } from "../quiescence.js";

export interface DaemonMemory {
  /** agentId -> condition -> last alert epoch ms */
  lastAlert: Record<string, Record<string, number>>;
  /** agentId -> { screen hash, epoch ms it last changed } (for stuck detection) */
  screenSince: Record<string, { hash: string; since: number }>;
  /** A worker has been seen active since the last wave announcement — the
   *  wave-complete prompt fires once per wave and re-arms on new activity. */
  waveActive: boolean;
  /** Stable-idle dwell: wave-complete only after sustained all-idle (B2) —
   *  a single misclassified beat must not announce a wave. */
  idleDwell: IdleDwell;
}

export function newMemory(): DaemonMemory {
  return { lastAlert: {}, screenSince: {}, waveActive: false, idleDwell: new IdleDwell() };
}

/**
 * Idle initiative: the proactive wake-prompt fired ONCE when the fleet goes
 * from "something running" to "fully idle". It's a prompt to the orchestrator,
 * so it both reports the result, nudges a project-memory refresh, and invites
 * the next move. The memory nudge is what makes CLAUDE.md/.claude-docs evolve
 * with the work instead of going stale.
 */
export function waveCompleteMessage(
  live: { label: string; status: string; cwd?: string; worktree?: { repo: string } }[],
): string {
  const summary = live.map((a) => `${a.label} ${a.status === "idle" ? "✓" : a.status}`).join(", ");
  // Distinct project dirs the wave touched (worktree workers map to their repo).
  const projects = [...new Set(live.map((a) => a.worktree?.repo ?? a.cwd).filter((d): d is string => !!d))];
  const auditHint = projects.length === 1 ? ` --cwd ${projects[0]}` : "";
  return (
    `Wave complete — ${summary}. ` +
    `Collect results with \`fleet digest\` (writes each worker's raw output to disk and returns only compact ` +
    `digests — don't \`fleet read\` transcripts into your window). ` +
    `Then evolve project memory: distill what the workers learned (new gotchas, decisions, version pins) ` +
    `into CLAUDE.md / .claude-docs, and gate with \`fleet audit-docs${auditHint}\` ` +
    `(and \`fleet currency\` if versions look stale) — spawn a scribe to refresh if it fails. ` +
    `Then take the next step if one's worth it (verify the output, review the diff, start the next wave); ` +
    `otherwise a one-line ack is fine.`
  );
}

export interface AgentSignal {
  agentId: string;
  label: string;
  status: string;
  stuckMs: number; // how long a "running" worker's screen has been unchanged
  /** Feature 3: the worker is idle (done candidate) but attached no proof. A
   *  cheap registry check — the runnable gate lives in `fleet done`/`digest`. */
  doneNoProof?: boolean;
}

export interface DaemonMsg {
  text: string;
  urgent: boolean;
}

export function evaluate(
  sig: AgentSignal,
  mem: DaemonMemory,
  nowMs: number,
  cooldownMs: number,
  stuckThreshMs: number,
): DaemonMsg | null {
  let cond: string | null = null;
  let urgent = false;
  let text = "";

  if (sig.status === "awaiting-input" || sig.status === "blocked-on-you") {
    cond = "awaiting";
    urgent = true;
    text = `${sig.label} is blocked on you — needs a decision.`;
  } else if (sig.status === "error") {
    cond = "error";
    urgent = true;
    text = `${sig.label} hit an error.`;
  } else if (sig.status === "rate-limited") {
    cond = "rate";
    urgent = false;
    text = `${sig.label} is rate-limited.`;
  } else if (sig.status === "running" && sig.stuckMs > stuckThreshMs) {
    cond = "stuck";
    urgent = true;
    text = `${sig.label} looks stuck — no output for ~${Math.round(sig.stuckMs / 60000)}m.`;
  } else if (sig.doneNoProof) {
    cond = "noproof";
    urgent = false; // a nag, not an interrupt
    text = `${sig.label} idled without proof — attach one (\`fleet done ${sig.label} --proof <kind:ref>\`) or verify before logging it complete.`;
  }

  if (!cond) {
    delete mem.lastAlert[sig.agentId]; // healthy again → allow future alerts
    return null;
  }

  const last = mem.lastAlert[sig.agentId]?.[cond] ?? 0;
  if (nowMs - last < cooldownMs) return null; // within cooldown — already alerted

  mem.lastAlert[sig.agentId] = { ...(mem.lastAlert[sig.agentId] ?? {}), [cond]: nowMs };
  return { text, urgent };
}
