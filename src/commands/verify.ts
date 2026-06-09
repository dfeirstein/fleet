// `fleet verify <agent> [--check <cmd>]` — independent eval gate (judge != generator).
//
// CLI wiring for src/cli.ts (DO NOT edit cli.ts here — add this yourself):
//   import { verify } from "./commands/verify.js";
//   ...
//   case "verify": {
//     const check = flag(args, "--check"); // the existing --flag parser in cli.ts
//     const { pass, output } = verify(args[0], check);
//     console.log(output);
//     console.log(pass ? "PASS" : "FAIL");
//     process.exit(pass ? 0 : 1);
//   }
//
// Help line to add to the usage text:
//   fleet verify <agent> [--check <cmd>]   Independent eval gate (judge != generator)
//
// The point: the orchestrator verifies a worker's output with a SEPARATE check
// run by the orchestrator, rather than trusting the worker's own self-report.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgent, patch } from "../registry.js";
import { parseProof, type ProofArtifact } from "../proof.js";
import { appendOutcome } from "../outcomes.js";

/** Pick the default check for a directory: `npm test` if defined, else a tsc typecheck. */
function defaultCheck(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "npm test";
    } catch {
      // Unreadable/invalid package.json — fall through to the typecheck default.
    }
  }
  return "npx tsc --noEmit";
}

/** Keep the last ~25 lines of output — enough to see what failed without flooding. */
function tail(text: string, lines = 25): string {
  return text.split("\n").slice(-lines).join("\n").trim();
}

/** Hard cap on a single proof/verify check. A check that exceeds it is killed and
 * treated as FAIL (fail closed) — a hanging proof must never stall `fleet done`/`digest`. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * Run a check command in a directory and report pass/fail + tailed output. This
 * is the independent runner (judge ≠ generator): the caller runs the command
 * itself rather than trusting a worker's self-report. Shared by `fleet verify`
 * and the proof gate (`gateProof`) so both grade through the same path.
 */
export function runCheck(dir: string, cmd: string): { pass: boolean; output: string } {
  try {
    const out = execSync(cmd, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: CHECK_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { pass: true, output: tail(out) };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    // A timeout kill (signal set) is fail-closed: the check did not pass, so say so plainly.
    if (e.killed || e.signal) {
      const combined = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
      const note = `check killed after ${CHECK_TIMEOUT_MS / 1000}s timeout (treated as FAIL)`;
      return { pass: false, output: tail(combined ? `${combined}\n${note}` : note) };
    }
    const combined = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    return { pass: false, output: tail(combined || e.message || "check failed") };
  }
}

/**
 * Decide whether a Captain-run `fleet verify` result should be auto-attached to
 * the worker as a proof-of-work claim. Pure (unit-tested). Attach only when:
 *   - the check PASSED (a failing check proves nothing — never attach);
 *   - the command is a real check (parseProof's no-op guard rejects
 *     `true`-style self-certs);
 *   - the same command isn't already attached (dedup by ref).
 */
export function verifyProofToAttach(
  pass: boolean,
  cmd: string,
  existing: ProofArtifact[] | undefined,
): ProofArtifact | undefined {
  if (!pass) return undefined;
  let artifact: ProofArtifact;
  try {
    artifact = parseProof(`command:${cmd}`);
  } catch {
    return undefined; // empty/no-op command — would self-certify, skip
  }
  if ((existing ?? []).some((p) => p.ref === artifact.ref)) return undefined;
  return artifact;
}

/**
 * Independently verify a worker's output by running a check in the worker's
 * directory — the agent's worktree if it has one, else its cwd.
 */
export function verify(idOrLabel: string, check?: string): { pass: boolean; output: string } {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);

  const dir = agent.worktree?.path ?? agent.cwd;
  const cmd = check ?? defaultCheck(dir);

  const result = runCheck(dir, cmd);

  // A passing Captain-run check IS independent verification (judge ≠ generator),
  // so auto-attach it as a proof — the existing verify habit greens the proof
  // gate instead of leaving idle workers flagged `⚠ done (no proof)`.
  const proof = verifyProofToAttach(result.pass, cmd, agent.proofs);
  if (proof) {
    patch(agent.agentId, { proofs: [...(agent.proofs ?? []), proof] });
    result.output = `${result.output}\n✓ proof attached: ${proof.kind}:${proof.ref}`.trim();
  }

  // Trajectory store: record the independent eval verdict (Move 1). Best-effort.
  appendOutcome({
    event: "verify",
    agentId: agent.agentId,
    label: agent.label,
    verdict: result.pass ? "pass" : "fail",
    check: cmd,
    cwd: dir,
  });

  return result;
}
