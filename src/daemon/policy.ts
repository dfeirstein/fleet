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
  /** agentId -> consecutive beats above the CPU threshold (resource guardrail
   *  dwell — a single sampling spike must not nudge the Captain). */
  cpuHighBeats: Record<string, number>;
  /** agentId -> condition -> last resource-alert epoch ms. Separate from
   *  lastAlert: evaluate() clears that map whenever STATUS is healthy, which
   *  would wipe a resource cooldown mid-breach and re-nag every beat. */
  lastResourceAlert: Record<string, Record<string, number>>;
  /** workspace → last-applied sidebar paint fingerprint (color|description),
   *  so the state-lamp sync only writes on CHANGE, never per-beat repaints. */
  sidebarPaint: Record<string, string>;
}

export function newMemory(): DaemonMemory {
  return {
    lastAlert: {},
    screenSince: {},
    waveActive: false,
    idleDwell: new IdleDwell(),
    cpuHighBeats: {},
    lastResourceAlert: {},
    sidebarPaint: {},
  };
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
    `into CLAUDE.md / .claude-docs — each line states how it was verified (command/doc+date/observed) or is ` +
    `marked \`unverified:\` and queued; drop guesses you can't turn into a checked rule ` +
    `(fail → investigate → verify → distill → consult). Gate with \`fleet audit-docs${auditHint}\` ` +
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
  /** RPC steering: the worker's oldest pending Feed prompt, so the blocked
   *  nudge can carry the summary + the exact `fleet reply` command. SURFACING
   *  ONLY — the daemon must never auto-answer a prompt (a permission is a
   *  policy decision; a human or Captain explicitly replies). */
  pendingPrompt?: {
    kind: string;
    hint: string;
    secondsLeft: number;
    replyCmd: string;
    /** Other prompts also pending for this worker (reply needs --prompt <id>). */
    morePending: number;
  };
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
    const p = sig.pendingPrompt;
    if (p) {
      // Surface the prompt + the ready-to-run reply; never answer it ourselves.
      const how =
        p.secondsLeft > 0
          ? `answer with \`${p.replyCmd}\` (~${p.secondsLeft}s left in the RPC window)`
          : `the 120s RPC window closed — answer via \`fleet send ${sig.agentId} ...\` or its pane`;
      const more = p.morePending > 0 ? ` (+${p.morePending} more pending — see \`fleet prompts\`)` : "";
      text += ` Pending ${p.kind}: "${p.hint}" — ${how}${more}.`;
    }
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

// ── Resource guardrails ──────────────────────────────────────────────────────
// Turn a `cmux top` sample + surface-health probe into a Captain NUDGE. The
// daemon never auto-kills (judge ≠ generator applies to lifecycle too): every
// breach is surfaced for the orchestrator to decide.

export interface ResourceSample {
  /** macOS process accounting — can exceed 100 across cores. */
  cpuPercent: number;
  /** Resident set summed over the worker surface's process tree. */
  residentBytes: number;
}

export interface ResourceThresholds {
  cpuHogPercent: number;
  cpuHogBeats: number;
  memHogMb: number;
}

/**
 * Sustained-breach detection, pure over DaemonMemory. CPU must stay above the
 * threshold for cpuHogBeats CONSECUTIVE beats (a dip resets the dwell — one
 * sampling spike never nudges); an RSS breach nudges immediately. A missing
 * sample (capability-gated telemetry, worker absent from the sweep) resets the
 * dwell and never nudges. Precedence: health failure > RSS > CPU.
 */
export function evaluateResources(
  agent: { agentId: string; label: string },
  sample: ResourceSample | undefined,
  healthFailure: string | undefined,
  mem: DaemonMemory,
  nowMs: number,
  cooldownMs: number,
  th: ResourceThresholds,
): DaemonMsg | null {
  // CPU dwell bookkeeping runs every beat regardless of which condition wins.
  if (sample && sample.cpuPercent > th.cpuHogPercent) {
    mem.cpuHighBeats[agent.agentId] = (mem.cpuHighBeats[agent.agentId] ?? 0) + 1;
  } else {
    delete mem.cpuHighBeats[agent.agentId];
  }

  let cond: string | null = null;
  let text = "";
  if (healthFailure) {
    cond = "health";
    text = `${agent.label} failed its surface-health probe (${healthFailure}) — inspect with \`fleet read ${agent.label}\`; if it's a zombie, you decide on \`fleet kill\`.`;
  } else if (sample && sample.residentBytes > th.memHogMb * 1024 * 1024) {
    cond = "memhog";
    const gb = (sample.residentBytes / 1024 ** 3).toFixed(1);
    text = `${agent.label} is using ${gb}GB resident memory (threshold ${(th.memHogMb / 1024).toFixed(1)}GB) — inspect it; consider \`fleet kill\` or a respawn (your call, the daemon never kills).`;
  } else if ((mem.cpuHighBeats[agent.agentId] ?? 0) >= th.cpuHogBeats) {
    cond = "cpuhog";
    text = `${agent.label} has been above ${th.cpuHogPercent}% CPU for ${mem.cpuHighBeats[agent.agentId]} beats — possibly spinning; inspect with \`fleet read ${agent.label}\` (the daemon never kills).`;
  }

  if (!cond) {
    delete mem.lastResourceAlert[agent.agentId]; // healthy again → re-arm
    return null;
  }
  const last = mem.lastResourceAlert[agent.agentId]?.[cond] ?? 0;
  if (nowMs - last < cooldownMs) return null;
  mem.lastResourceAlert[agent.agentId] = {
    ...(mem.lastResourceAlert[agent.agentId] ?? {}),
    [cond]: nowMs,
  };
  return { text, urgent: false }; // a nudge, not an interrupt
}
