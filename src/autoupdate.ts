// Pure decision core for the self-updating launcher. The actual auto-update runs
// in bash inside `bin/fleet` (the only pre-tsx hook), but the *decisions* it
// makes — throttle, eligibility, whether the lockfile moved — are mirrored here
// as pure functions so they're testable (node:test) and reused by the explicit
// `fleet update` command (src/commands/update.ts). Keep the two in lockstep.

/** Auto-update is attempted at most once per this window (24h). */
export const THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Throttle gate: has enough time passed since the last check?
 * `stampAgeMs === null` means no stamp yet (never checked) → always check.
 */
export function shouldCheckForUpdate(stampAgeMs: number | null, throttleMs: number = THROTTLE_MS): boolean {
  if (stampAgeMs === null) return true;
  return stampAgeMs >= throttleMs;
}

/**
 * Auto-update only ever touches a clean checkout on `main` with no opt-out.
 * A developer on a feature branch or with local edits is exempt automatically;
 * `FLEET_NO_AUTOUPDATE=1` is the explicit escape hatch. Returns the reason a
 * check is skipped so `fleet update` can echo a clear refusal.
 */
export function autoUpdateEligible(ctx: { branch: string; clean: boolean; optOut: boolean }): {
  ok: boolean;
  reason: string;
} {
  if (ctx.optOut) return { ok: false, reason: "FLEET_NO_AUTOUPDATE=1 is set" };
  if (ctx.branch !== "main") return { ok: false, reason: `on branch '${ctx.branch}', not main` };
  if (!ctx.clean) return { ok: false, reason: "working tree has uncommitted changes" };
  return { ok: true, reason: "" };
}

/**
 * Reinstall deps only when the pull actually moved the lockfile — `npm ci` is
 * the expensive step and a no-op churn otherwise. `changedFiles` is the list of
 * paths that differ between the old and new HEAD (repo-relative).
 */
export function lockfileChanged(changedFiles: string[]): boolean {
  return changedFiles.some((f) => f === "package-lock.json");
}
