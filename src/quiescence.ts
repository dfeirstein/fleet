// Stable-idle dwell (B1/B2): one misattributed beat must never end a watch or
// announce a wave. Quiescence is confirmed only when the fleet is observed
// all-idle for at least `minBeats` consecutive beats spanning at least
// `minSpanMs`, AND no worker has a `lastDispatchAt` younger than
// `dispatchHoldMs` — a fresh `fleet send` means work is in flight even if no
// screen shows it yet. Shared by `fleet watch --until-idle` and the daemon's
// wave-complete trigger.

export interface DwellConfig {
  minBeats: number;
  minSpanMs: number;
  dispatchHoldMs: number;
}

export const DWELL_DEFAULTS: DwellConfig = {
  minBeats: 2,
  minSpanMs: 10_000,
  dispatchHoldMs: 15_000,
};

// ── Deterministic done-signal (P2b) ─────────────────────────────────────────
// `fleet done` with a PASSING gate sends the cmux signal `done-<agentId>`
// (`wait-for -S`) and stamps `doneSignalAt` in the registry. Consumers
// (watch/daemon via snapshot→classifyLive) treat a fresh stamp as authoritative
// idle-for-that-agent — a fast path ALONGSIDE screen/notification inference,
// never replacing it: live screen evidence (running/awaiting/error) still wins,
// and workers that never call `fleet done` resolve via inference as today.

/** The cmux signal name announcing a gate-verified completion for an agent. */
export function doneSignalName(agentId: string): string {
  return `done-${agentId}`;
}

/** Inverse of doneSignalName: the agentId, or undefined for foreign signals. */
export function parseDoneSignal(name: string): string | undefined {
  const m = /^done-([A-Za-z0-9]+)$/.exec(name);
  return m?.[1];
}

/**
 * True iff a recorded done-signal belongs to the worker's CURRENT turn: it
 * parses and is not older than the last dispatch. A re-dispatch (`fleet send`)
 * advances lastDispatchAt past the stamp, so a stale signal can never mark the
 * NEXT turn idle. Unparseable timestamps fail closed (no fast path).
 */
export function doneSignalFresh(doneSignalAt: string | undefined, lastDispatchAt: string): boolean {
  if (!doneSignalAt) return false;
  const done = Date.parse(doneSignalAt);
  const dispatch = Date.parse(lastDispatchAt);
  if (!Number.isFinite(done) || !Number.isFinite(dispatch)) return false;
  return done >= dispatch;
}

export class IdleDwell {
  private idleSince: number | undefined;
  private beats = 0;

  constructor(private readonly cfg: DwellConfig = DWELL_DEFAULTS) {}

  /**
   * Record one observation. Returns true only once idleness has been sustained
   * across the configured window. Any active beat — or any dispatch fresher
   * than dispatchHoldMs — resets the dwell from zero.
   */
  beat(allIdle: boolean, lastDispatchAts: (string | undefined)[], nowMs: number): boolean {
    const recentDispatch = lastDispatchAts.some((d) => {
      if (!d) return false;
      const t = Date.parse(d);
      return Number.isFinite(t) && nowMs - t < this.cfg.dispatchHoldMs;
    });
    if (!allIdle || recentDispatch) {
      this.reset();
      return false;
    }
    if (this.idleSince === undefined) this.idleSince = nowMs;
    this.beats++;
    return this.beats >= this.cfg.minBeats && nowMs - this.idleSince >= this.cfg.minSpanMs;
  }

  reset(): void {
    this.idleSince = undefined;
    this.beats = 0;
  }
}
