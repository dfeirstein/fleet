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
