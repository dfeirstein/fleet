// `fleet objective` — loop-until-done. Spawn a worker on a goal, wait for its
// turn to finish, then run a shell `done-check`. If the check passes, we're
// done; if not, feed the failure back into the goal and try again, up to
// --max attempts. This is the orchestration pattern of a stop CONDITION rather
// than a fixed count: the loop ends when the check passes, not after N tries.
//
// ── CLI wiring for src/cli.ts (DO NOT auto-applied — add by hand) ──
// Add to the HELP string (after the `watch` block):
//
//   objective <goal...> --done <check>          Loop a worker until a stop
//         [--cwd P] [--max N] [--model M]        condition (shell check) passes
//
// Add a case to the switch in main():
//
//   case "objective": {
//     const goal = positionals.join(" ").trim();
//     if (!goal) return fail("objective requires a <goal>");
//     const doneCheck = str(flags.done);
//     if (!doneCheck) return fail("objective requires --done \"<shell check>\"");
//     const res = objective(goal, doneCheck, {
//       cwd: str(flags.cwd) ?? process.cwd(),
//       maxIterations: str(flags.max) ? Number(str(flags.max)) : 3,
//       model: str(flags.model),
//     });
//     console.log(res.done
//       ? `✓ objective met after ${res.iterations} attempt(s)`
//       : `✗ objective NOT met after ${res.iterations} attempt(s)`);
//     if (!res.done) process.exitCode = 1;
//     break;
//   }
//
// And import at the top of cli.ts:
//   import { objective } from "./commands/objective.js";
import { execFileSync, spawnSync } from "node:child_process";
import { spawn } from "./spawn.js";
import { kill } from "./kill.js";
import { snapshot } from "./status.js";

export interface ObjectiveOptions {
  cwd: string;
  maxIterations: number;
  model?: string;
}

export interface ObjectiveResult {
  done: boolean;
  iterations: number;
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

/** Run the done-check in `cwd`. Exit 0 → satisfied. Captures combined output. */
function runCheck(cmd: string, cwd: string): { ok: boolean; code: number; output: string } {
  const res = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { ok: res.status === 0, code: res.status ?? -1, output };
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
  let currentGoal = goal;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(`\n── objective: attempt ${iteration}/${maxIterations} ──`);
    const agent = spawn({
      task: currentGoal,
      cwd: opts.cwd,
      label: `objective-${iteration}`,
      model,
      mode: "auto",
      launch: true,
      autostart: true,
      worktree: false,
    });
    console.log(`  spawned ${agent.agentId} (${agent.label}) — waiting for its turn to finish…`);

    const outcome = waitForIdle(agent.agentId, WAIT_TIMEOUT_MS);
    console.log(`  worker turn ended (${outcome}); running done-check: ${doneCheck}`);

    const check = runCheck(doneCheck, opts.cwd);
    safeKill(agent.agentId);

    if (check.ok) {
      console.log(`  ✓ done-check passed on attempt ${iteration}.`);
      return { done: true, iterations: iteration };
    }

    console.log(`  ✗ done-check failed (exit ${check.code}) on attempt ${iteration}.`);
    // Feed the failure forward so the next worker has the context it needs.
    currentGoal =
      `${goal}\n\n` +
      `---\n` +
      `A previous attempt (#${iteration}) did not satisfy the done-check \`${doneCheck}\`.\n` +
      `Its output was:\n\n` +
      `${check.output.trim() || "(no output)"}\n\n` +
      `Fix the remaining issues so that running \`${doneCheck}\` exits 0.`;
  }

  console.log(`\n✗ objective not met after ${maxIterations} attempts.`);
  return { done: false, iterations: maxIterations };
}
