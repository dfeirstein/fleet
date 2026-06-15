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
 * distilled failure (parsed "what actually failed", not the raw dump) so the
 * next turn fixes instead of thrashing (matches the objective loop's wording).
 */
export function redispatchPrompt(check: string, output: string, attempt: number): string {
  return (
    `The done-check \`${check}\` is still failing (re-dispatch #${attempt}).\n` +
    `Its output was:\n\n` +
    `${distillFailure(output)}\n\n` +
    `Fix the remaining issues so that running \`${check}\` exits 0.`
  );
}

// ── Feature A: distillFailure — parse "what actually failed" out of raw check
// output so the feed-forward steers a fix instead of a thrash. Pure, no deps.
const FAILURE_SIGNAL = /fail|not ok|error|exception|traceback|panic:|assertion|expected|received|[✗✘✕✖]/i;

/**
 * Distill raw check output into the lines that explain the failure. Collects
 * failure-signal lines (test/assert/error patterns) in order, de-duplicated; if
 * none match, falls back to the tail (where the real error usually lands). Caps
 * to `maxLines` (default 12) and `maxChars` (default 2000), appending a
 * `… (truncated; N more line(s))` marker when it drops lines.
 */
export function distillFailure(output: string, opts?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = opts?.maxLines ?? 12;
  const maxChars = opts?.maxChars ?? 2000;
  if (!output.trim()) return "(no output)";

  const lines = output.split("\n").map((l) => l.trimEnd());
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key) continue; // skip blank lines
    if (FAILURE_SIGNAL.test(line) && !seen.has(key)) {
      seen.add(key);
      matched.push(line);
    }
  }

  // Matched signal lines are the whole story; otherwise the tail holds it.
  const candidates =
    matched.length > 0 ? matched : lines.filter((l) => l.trim()).slice(-maxLines);

  const total = candidates.length;
  let kept = candidates.slice(0, maxLines);
  // Char cap: drop whole lines from the end until under budget. Guard against a
  // single oversized line eating everything — clip it inline AND mark the clip
  // so a one-line assertion/JSON error never reads as complete-but-fine.
  while (kept.length > 1 && kept.join("\n").length > maxChars) kept.pop();
  if (kept.length === 1 && kept[0]!.length > maxChars) {
    const marker = " … (truncated)";
    kept = [kept[0]!.slice(0, Math.max(0, maxChars - marker.length)) + marker];
  }

  const dropped = total - kept.length;
  if (dropped > 0) kept.push(`… (truncated; ${dropped} more line(s))`);
  return kept.join("\n");
}

// ── Feature B: shouldWake — the pre-spawn gate's decision. A cheap wake-check
// prints its verdict; only an explicit `{"wakeAgent": false}` on the LAST such
// line skips the (expensive) worker spawn this tick.
/**
 * Decide whether to wake (spawn) the worker from a wake-check's output + exit.
 *
 * FAIL-OPEN — this is the INVERSE of a verify gate's fail-closed, on purpose:
 * silently *skipping* real work is the dangerous direction, so anything
 * inconclusive WAKES. The verdict must be the FINAL non-empty output line: a
 * clean `{"wakeAgent": <boolean>}` there is honored (false=skip, true=wake);
 * anything else — malformed JSON, plain text, a non-boolean `wakeAgent`, no
 * output, or a non-zero exit — WAKES. We do NOT scan upward past trailing noise
 * to an earlier verdict: a stale `false` hiding behind garbage must never
 * suppress work. Do NOT "fix" this to fail-closed.
 */
export function shouldWake(wakeCheckOutput: string, exitCode: number): boolean {
  if (exitCode !== 0) return true; // a broken wake-check must not gate work out
  const lines = wakeCheckOutput.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed) {
      last = trimmed;
      break;
    }
  }
  if (!last) return true; // no output → wake
  try {
    const parsed: unknown = JSON.parse(last);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "wakeAgent" in parsed &&
      typeof (parsed as { wakeAgent: unknown }).wakeAgent === "boolean"
    ) {
      return (parsed as { wakeAgent: boolean }).wakeAgent; // the final line is the verdict
    }
  } catch {
    // final line isn't clean JSON → fall through to wake
  }
  return true; // final line wasn't a clean verdict → wake (fail-open)
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
