// Heartbeat policy: turn a worker's observed state into an escalation message,
// with per-agent+condition cooldown so a persistent condition alerts once, not
// every tick. Bounded autonomy — the daemon ACTS only on safe things (handled
// in loop.ts, e.g. clearing a stuck bypass dialog); everything risky is
// surfaced here for the orchestrator to decide.

export interface DaemonMemory {
  /** agentId -> condition -> last alert epoch ms */
  lastAlert: Record<string, Record<string, number>>;
  /** agentId -> { screen hash, epoch ms it last changed } (for stuck detection) */
  screenSince: Record<string, { hash: string; since: number }>;
  /** idle-initiative edge tracking */
  prevAnyRunning: boolean;
  waveAnnounced: boolean;
}

export function newMemory(): DaemonMemory {
  return { lastAlert: {}, screenSince: {}, prevAnyRunning: false, waveAnnounced: false };
}

/**
 * Idle initiative: the proactive wake-prompt fired ONCE when the fleet goes
 * from "something running" to "fully idle". It's a prompt to the orchestrator,
 * so it both reports the result and invites the next move.
 */
export function waveCompleteMessage(live: { label: string; status: string }[]): string {
  const summary = live.map((a) => `${a.label} ${a.status === "idle" ? "✓" : a.status}`).join(", ");
  return (
    `Wave complete — ${summary}. ` +
    `If a next step is worth taking (verify the output, review the diff, start the next wave), ` +
    `go ahead; otherwise a one-line ack is fine.`
  );
}

export interface AgentSignal {
  agentId: string;
  label: string;
  status: string;
  stuckMs: number; // how long a "running" worker's screen has been unchanged
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

  if (sig.status === "awaiting-input") {
    cond = "awaiting";
    urgent = true;
    text = `${sig.label} is awaiting input — needs a decision.`;
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
