// `fleet capture <name> --from <agent>` — promote a proven worker into a
// reusable skill. The orchestrator delegates a task once via an agent; once that
// worker has produced a working script, `capture` freezes its task + cwd into a
// SKILL.md so future runs can re-execute the script deterministically instead of
// paying to re-delegate to a fresh agent (the "pre-compute / reuse" payoff).
//
// CLI wiring to add to src/cli.ts (do NOT edit it here — left for review):
//   } else if (cmd === "capture") {
//     const name = args[0];
//     const fromIdx = args.indexOf("--from");
//     const fromAgent = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
//     if (!name || !fromAgent) {
//       console.error("usage: fleet capture <name> --from <agent>");
//       process.exit(1);
//     }
//     console.log(capture(name, fromAgent));
//   }
// Help line:
//   fleet capture <name> --from <agent>   Promote a proven worker into a reusable skill
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgent } from "../registry.js";
import { verify } from "./verify.js";

// Library drift is a real failure: LLM-authored skills promoted on a single
// success can net to zero and degrade retrieval. So a captured skill is GATED:
//   provisional — captured, not yet independently verified; do not auto-run blindly.
//   active      — passed an independent check (judge≠generator); safe to reuse.
//   quarantined — failed its check; kept for inspection, not for reuse.
export type SkillStatus = "provisional" | "active" | "quarantined";

export interface CaptureResult {
  path: string;
  status: SkillStatus;
  verifyOutput?: string;
}

/**
 * Scaffold skills/<name>/SKILL.md from the source agent's record. With `check`,
 * run that check INDEPENDENTLY in the worker's dir (the gate, judge≠generator):
 * pass → active, fail → quarantined. Without a check the skill stays provisional
 * and is promoted later by verified real reuse (the canary path). Refuses to
 * overwrite an existing skill.
 */
export function capture(name: string, fromAgent: string, check?: string): CaptureResult {
  const agent = resolveAgent(fromAgent);
  if (!agent) {
    throw new Error(`no agent matching "${fromAgent}" (try \`fleet ls\`)`);
  }

  // skills/ lives at the repo root, two levels up from src/commands/.
  const skillDir = fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url));
  const skillPath = join(skillDir, "SKILL.md");
  if (existsSync(skillPath)) {
    throw new Error(`skill "${name}" already exists at ${skillPath} — pick another name or edit it directly`);
  }

  // Run the independent gate if a check was supplied.
  let status: SkillStatus = "provisional";
  let verifyOutput: string | undefined;
  let verifyLine = "";
  if (check) {
    const res = verify(fromAgent, check);
    status = res.pass ? "active" : "quarantined";
    verifyOutput = res.output;
    verifyLine = `verifiedAt: ${JSON.stringify(new Date().toISOString())}\nverifyCheck: ${JSON.stringify(check)}\nverifyVerdict: ${res.pass ? "pass" : "fail"}\n`;
  }

  // One-line description for the frontmatter, derived from the worker's task.
  // Double-quoted so colons/special chars in the task can't break the YAML.
  const description = JSON.stringify(`Use when you need to: ${oneLine(agent.task)}`);

  const body = `---
name: ${name}
description: ${description}
status: ${status}
capturedFrom: ${JSON.stringify(`${agent.label} (${agent.agentId})`)}
capturedAt: ${JSON.stringify(new Date().toISOString())}
reuseCount: 0
${verifyLine}---

# ${name}

Captured from worker \`${agent.label}\` (${agent.agentId}). **Status: ${status}.**
${statusNote(status)}

This skill freezes a proven worker into a reusable, deterministic recipe. Run the
script in the **Reusable script** section instead of re-delegating the task to a
fresh agent — that is the pre-compute / reuse payoff.

## Originating task

The worker was given this task verbatim:

> ${agent.task.replace(/\n/g, "\n> ")}

- **cwd:** \`${agent.cwd}\`
- **model:** \`${agent.model}\`

## Reusable script

<!-- TODO: paste the script(s) the worker produced so future runs are cheap and
     deterministic. Replace this block with the exact commands / code to re-run
     the captured work without spawning an agent. -->

\`\`\`bash
# TODO: paste the proven script here
\`\`\`
`;

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, body);
  return { path: skillPath, status, verifyOutput };
}

function statusNote(status: SkillStatus): string {
  switch (status) {
    case "active":
      return "Passed an independent check — safe to reuse.";
    case "quarantined":
      return "FAILED its independent check — do NOT reuse until fixed and re-verified.";
    default:
      return "Not yet independently verified — gate it with `fleet capture … --verify <check>` or promote on verified real reuse before trusting it.";
  }
}

/** Collapse a possibly-multiline task into a single trimmed line for YAML. */
function oneLine(task: string): string {
  const flat = task.replace(/\s+/g, " ").trim();
  const max = 200;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
