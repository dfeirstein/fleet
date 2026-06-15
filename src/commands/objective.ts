// `fleet objective` — loop-until-done. Spawn a worker on a goal, wait for its
// turn to finish, then run a shell `done-check`. If the check passes, we're
// done; if not, feed the (distilled) failure back into the goal and try again,
// up to --max attempts. This is the orchestration pattern of a stop CONDITION
// rather than a fixed count: the loop ends when the check passes, not after N.
//
// Two monitor-style modes layer on top (Hermes-inspired): a `--wake-check` gate
// that skips spending a worker when a cheap deterministic check says nothing
// changed, and `--no-agent` which runs the `--done` check each tick with NO
// worker at all (a recurring 0-token monitor that alerts the Captain on FAIL).
// CLI wiring lives in src/cli.ts (HELP block + `case "objective"`).
import { execFileSync, spawnSync } from "node:child_process";
import { spawn } from "./spawn.js";
import { kill } from "./kill.js";
import { snapshot } from "./status.js";
import { verify } from "./verify.js";
import { notifyOrchestrator } from "./notify.js";
import { distillFailure, shouldWake } from "../done-loop.js";

export interface ObjectiveOptions {
  cwd: string;
  maxIterations: number;
  model?: string;
  /** Run the stop-condition through `fleet verify` (the eval gate) against the
   *  worker — runs in the worker's cwd/worktree and uses the shared gate
   *  (judge≠generator) instead of an inline shell check. (compose B+D) */
  viaVerify?: boolean;
  /** Pre-spawn gate: a cheap deterministic check whose last `{"wakeAgent":bool}`
   *  line decides whether to spend a worker this tick (fail-open — see shouldWake). */
  wakeCheck?: string;
  /** Sleep this many seconds between ticks → recurring/monitor behavior. Unset
   *  = today's tight loop (no sleep). */
  intervalSec?: number;
  /** Deterministic monitor: never spawn a worker; run `doneCheck` each tick and
   *  alert the Captain on FAIL. Requires a done-check (validated at the CLI). */
  noAgent?: boolean;
  /** Max total loop ticks. Default = maxIterations when intervalSec is unset
   *  (today's loop is byte-identical), 50 when intervalSec is set. */
  maxTicks?: number;
}

export interface ObjectiveResult {
  done: boolean;
  iterations: number;
  /** Total loop ticks executed (incl. skipped wake-check ticks and monitor
   *  ticks). `iterations` stays = worker spawns for backward compatibility. */
  ticks: number;
}

const POLL_SECONDS = 5;
// How long to wait for a single worker turn to finish before giving up on it
// and running the done-check anyway. ~10 min matches a slow-but-real task.
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
// A freshly spawned worker may briefly read "idle" at its prompt before it
// picks up the dispatched task. Ignore an idle reading inside this window
// unless we've already seen the worker actively working.
const STARTUP_GRACE_MS = 45 * 1000;

function sleepSeconds(s: number): void {
  execFileSync("sleep", [String(s)]);
}

/** Run the done-check in `cwd`. Exit 0 → satisfied. Captures combined output
 *  (for the failure feed-forward) plus stdout alone (the wake-check verdict
 *  convention is the last STDOUT JSON line — stderr must not sway it). */
function runCheck(cmd: string, cwd: string): { ok: boolean; code: number; output: string; stdout: string } {
  const res = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  const stdout = res.stdout ?? "";
  const output = `${stdout}${res.stderr ?? ""}`;
  return { ok: res.status === 0, code: res.status ?? -1, output, stdout };
}

function safeKill(idOrLabel: string): void {
  try {
    kill(idOrLabel);
  } catch {
    // Worker may already be gone — killing is best-effort cleanup.
  }
}

/**
 * Poll the fleet until the given agent's turn ends. Returns the terminal status
 * observed: "idle" (turn finished), a needs-attention/dead status (the worker
 * can't progress on its own), or "timeout". snapshot() folds in cmux's
 * turn-end notifications, so "idle" is a real "this turn is done" signal.
 */
function waitForIdle(agentId: string, timeoutMs: number): string {
  const start = Date.now();
  let sawActive = false;
  for (;;) {
    const row = snapshot().find((r) => r.agentId === agentId);
    if (!row) return "gone";
    const st = row.status;
    if (st === "running") sawActive = true;
    if (st === "idle") {
      if (sawActive || Date.now() - start > STARTUP_GRACE_MS) return "idle";
    } else if (st === "error" || st === "dead" || st === "rate-limited" || st === "awaiting-input") {
      // The worker is blocked or broken; stop waiting and let the check decide.
      return st;
    }
    if (Date.now() - start > timeoutMs) return "timeout";
    sleepSeconds(POLL_SECONDS);
  }
}

export function objective(goal: string, doneCheck: string, opts: ObjectiveOptions): ObjectiveResult {
  const maxIterations = opts.maxIterations > 0 ? opts.maxIterations : 3;
  const model = opts.model ?? "opus";
  const intervalSet = opts.intervalSec != null && opts.intervalSec > 0;
  const noAgent = opts.noAgent === true;
  // --max-ticks default: explicit value wins; else 50 once --interval makes this
  // a recurring monitor; else --no-agent does exactly ONE check (it never spawns,
  // so it does not borrow the worker's --max budget); else the worker path
  // mirrors maxIterations so the default tight loop is byte-identical to before.
  const maxTicks =
    opts.maxTicks != null && opts.maxTicks > 0 ? opts.maxTicks : intervalSet ? 50 : noAgent ? 1 : maxIterations;

  let ticks = 0;
  let spawns = 0;
  let currentGoal = goal;
  // The last --no-agent monitor check result (undefined until one runs). Lets an
  // interval monitor that completes its tick budget report the real last health
  // (a monitor that failed its checks must NOT exit success), mirroring the
  // one-shot --no-agent return below.
  let lastMonitorOk: boolean | undefined;

  while (ticks < maxTicks) {
    ticks++;
    // Spawn-budget guard FIRST, before the wake gate: once the worker budget
    // (--max) is spent, report exhaustion immediately rather than let a
    // wake-check skip+sleep keep a doomed objective ticking to --max-ticks
    // (hours of wasted wall-clock with long intervals). No-op on the default
    // path: maxTicks == maxIterations exits via the ticks bound before spawns
    // can reach the budget at a tick's top.
    if (!noAgent && spawns >= maxIterations) break; // exhausted (loud)
    // Whether another tick will run after this one — gate the inter-tick sleep
    // on it so a bounded one-shot (e.g. --max-ticks 1) returns immediately
    // instead of sleeping a full interval after its final tick.
    const moreTicks = ticks < maxTicks;

    // Pre-spawn wake gate (Feature B): only spend a worker when the cheap
    // deterministic check says state changed. Fail-open — see shouldWake. The
    // gate decides whether to spend a WORKER, so it applies only to the worker
    // path — never gate the --no-agent monitor (the CLI also rejects that combo,
    // but stay correct if objective() is called directly).
    if (opts.wakeCheck && !noAgent) {
      const wc = runCheck(opts.wakeCheck, opts.cwd);
      if (!shouldWake(wc.stdout, wc.code)) {
        console.log(`  wake-check: no work this tick — skipped (0 tokens)`);
        if (intervalSet) {
          if (moreTicks) sleepSeconds(opts.intervalSec!);
          continue;
        }
        // Nothing to do right now → success with 0 spawns (one-shot gate).
        return { done: true, iterations: spawns, ticks };
      }
    }

    // Deterministic monitor (Feature C): never spawn a worker. Run the --done
    // check each tick, report PASS/FAIL, and alert the Captain (urgent) on FAIL.
    if (noAgent) {
      const c = runCheck(doneCheck, opts.cwd);
      lastMonitorOk = c.ok;
      if (c.ok) {
        console.log(`  ✓ monitor PASS (tick ${ticks}/${maxTicks}): ${doneCheck}`);
      } else {
        console.log(`  ✗ monitor FAIL (exit ${c.code}, tick ${ticks}/${maxTicks}): ${doneCheck}`);
        try {
          notifyOrchestrator(`monitor FAIL: \`${doneCheck}\` exited ${c.code}.\n${distillFailure(c.output)}`, true);
        } catch (e) {
          // No Captain declared / channel down — keep the monitor alive rather
          // than crash the loop on the first failed alert.
          console.log(`  (could not alert orchestrator: ${(e as Error).message})`);
        }
      }
      // Bounded by --max-ticks (default 1 → exactly one check when neither
      // --interval nor --max-ticks is set). Sleep only between ticks when an
      // interval is set; the post-loop return reports the LAST check below.
      if (intervalSet && moreTicks) sleepSeconds(opts.intervalSec!);
      continue;
    }

    // Normal worker path. The spawn-budget guard at the top of the loop bounds
    // spawns separately from ticks (a wake-gated monitor may tick many times but
    // never exceeds --max worker spawns) — checked there so an exhausted budget
    // beats the wake gate.
    spawns++;
    console.log(`\n── objective: attempt ${spawns}/${maxIterations} ──`);
    const agent = spawn({
      task: currentGoal,
      cwd: opts.cwd,
      label: `objective-${spawns}`,
      model,
      mode: "auto",
      launch: true,
      autostart: true,
      worktree: false,
      standalone: true, // each objective attempt runs in its own workspace
    });
    console.log(`  spawned ${agent.agentId} (${agent.label}) — waiting for its turn to finish…`);

    const outcome = waitForIdle(agent.agentId, WAIT_TIMEOUT_MS);

    // Run the stop-condition. Via the eval gate (`fleet verify`, run in the
    // worker's cwd/worktree — compose B+D) or as an inline shell check in --cwd.
    // Either way, run it BEFORE killing the worker so the agent still resolves.
    let check: { ok: boolean; code: number; output: string };
    if (opts.viaVerify) {
      console.log(`  worker turn ended (${outcome}); eval gate: fleet verify ${agent.label} --check ${doneCheck}`);
      const v = verify(agent.agentId, doneCheck);
      check = { ok: v.pass, code: v.pass ? 0 : 1, output: v.output };
    } else {
      console.log(`  worker turn ended (${outcome}); running done-check: ${doneCheck}`);
      check = runCheck(doneCheck, opts.cwd);
    }
    safeKill(agent.agentId);

    if (check.ok) {
      console.log(`  ✓ ${opts.viaVerify ? "eval gate" : "done-check"} passed on attempt ${spawns}.`);
      return { done: true, iterations: spawns, ticks };
    }

    console.log(`  ✗ ${opts.viaVerify ? "eval gate" : "done-check"} failed (exit ${check.code}) on attempt ${spawns}.`);
    // Feed the DISTILLED failure forward so the next worker fixes, not thrashes.
    currentGoal =
      `${goal}\n\n` +
      `---\n` +
      `A previous attempt (#${spawns}) did not satisfy the done-check \`${doneCheck}\`.\n` +
      `Its output was:\n\n` +
      `${distillFailure(check.output)}\n\n` +
      `Fix the remaining issues so that running \`${doneCheck}\` exits 0.`;
    // Pause before the next attempt — but not after the final tick or once the
    // spawn budget is spent (the next iteration would just break).
    if (intervalSet && moreTicks && spawns < maxIterations) sleepSeconds(opts.intervalSec!);
  }

  // The loop ran its course. Genuine exhaustion (done:false) is ONLY when a
  // worker actually ran and never passed (a passing attempt early-returns).
  if (spawns > 0) {
    console.log(`\n✗ objective not met after ${spawns} attempt(s).`);
    return { done: false, iterations: spawns, ticks };
  }
  // No worker ran. An interval --no-agent monitor reports its LAST check (a
  // monitor that kept failing must not exit success — mirrors the one-shot
  // return); a pure wake-gated run that never even checked is a clean success.
  const done = lastMonitorOk ?? true;
  console.log(`\n${done ? "✓" : "✗"} loop completed ${ticks} tick(s) — no worker spawned (last monitor: ${lastMonitorOk === undefined ? "n/a" : lastMonitorOk ? "PASS" : "FAIL"}).`);
  return { done, iterations: spawns, ticks };
}
