// The decision core for `fleet spawn --done '<check>'` — a stop condition the
// daemon drives on a spawned worker's stable-idle. Pure + unit-tested; all the
// side effects (running the check, attaching proof, re-dispatching, escalating)
// live in the daemon beat (src/daemon/loop.ts). Keeping the rules here means the
// loop's bounds + gating are checkable without a live fleet.
//
// Semantics: the spawn dispatch is the first attempt. When the worker goes
// idle the daemon runs the check; pass → proof auto-attaches (verify mechanics);
// fail → re-dispatch the SAME worker with the failure output, up to `maxLoops`
// re-dispatches (default 3); past that → exhausted (loud escalation, never an
// infinite loop).

/** A freshly dispatched worker can read "idle" for a beat before it picks up the
 *  task. Mirror objective.ts's startup grace: only run the check once we've seen
 *  the worker active this turn, OR this long has elapsed since the dispatch. */
export const DONE_STARTUP_GRACE_MS = 45 * 1000;

export interface DoneCheckGate {
  /** The worker carries a `--done` check. */
  hasCheck: boolean;
  /** The worker's classified status this beat. */
  status: string;
  /** The loop already exhausted its budget — never run again. */
  exhausted: boolean;
  /** We've seen this worker active since the dispatch we'd be checking. */
  sawActive: boolean;
  /** The startup grace has elapsed since the dispatch (fallback to sawActive,
   *  so a daemon that adopts an already-idle worker still checks it). */
  graceElapsed: boolean;
  /** We already ran the check for this turn (dedup by lastDispatchAt). */
  alreadyChecked: boolean;
}

/**
 * Whether the daemon should run the done-check this beat. Gated to `idle` only:
 * a `running` worker is mid-turn, and a `blocked-on-you`/`awaiting-input`/
 * `error`/`dead` worker must NEVER be auto-re-dispatched (the brief's rule) —
 * those are surfaced by the existing escalations instead.
 */
export function shouldRunDoneCheck(g: DoneCheckGate): boolean {
  return (
    g.hasCheck &&
    !g.exhausted &&
    !g.alreadyChecked &&
    g.status === "idle" &&
    (g.sawActive || g.graceElapsed)
  );
}

export type DoneLoopOutcome = "pass" | "redispatch" | "exhausted";

/**
 * What to do given a check result and how many re-dispatches have already
 * happened. `loopCount` is re-dispatches performed so far (0 at spawn); the loop
 * re-dispatches while `loopCount < maxLoops`, then exhausts. Bounded always.
 */
export function doneLoopOutcome(pass: boolean, loopCount: number, maxLoops: number): DoneLoopOutcome {
  if (pass) return "pass";
  return loopCount < maxLoops ? "redispatch" : "exhausted";
}

/**
 * The steering text fed back to the SAME worker on a failed check. Carries the
 * failure output so the next turn has the context it needs (matches the
 * objective loop's feed-forward wording).
 */
export function redispatchPrompt(check: string, output: string, attempt: number): string {
  return (
    `The done-check \`${check}\` is still failing (re-dispatch #${attempt}).\n` +
    `Its output was:\n\n` +
    `${output.trim() || "(no output)"}\n\n` +
    `Fix the remaining issues so that running \`${check}\` exits 0.`
  );
}

/** The loud escalation message when the loop exhausts its budget without a pass. */
export function exhaustedMessage(label: string, check: string, maxLoops: number, output: string): string {
  const why = output.trim() ? ` Last failure: ${output.trim().split("\n").slice(-1)[0]}.` : "";
  return (
    `${label}'s --done check \`${check}\` never passed after ${maxLoops} re-dispatch(es) — ` +
    `loop exhausted, NOT auto-retried again.${why} ` +
    `Investigate the root cause (don't just bump --max), then re-dispatch with \`fleet send ${label} ...\`.`
  );
}
