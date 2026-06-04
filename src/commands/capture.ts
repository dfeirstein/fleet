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

/**
 * Scaffold skills/<name>/SKILL.md from the source agent's registry record.
 * Returns the path it wrote. Throws if the agent can't be resolved, and refuses
 * to overwrite an existing SKILL.md.
 */
export function capture(name: string, fromAgent: string): string {
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

  // One-line description for the frontmatter, derived from the worker's task.
  // Double-quoted so colons/special chars in the task can't break the YAML.
  const description = JSON.stringify(`Use when you need to: ${oneLine(agent.task)}`);

  const body = `---
name: ${name}
description: ${description}
---

# ${name}

Captured from worker \`${agent.label}\` (${agent.agentId}) on ${new Date().toISOString()}.

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
  return skillPath;
}

/** Collapse a possibly-multiline task into a single trimmed line for YAML. */
function oneLine(task: string): string {
  const flat = task.replace(/\s+/g, " ").trim();
  const max = 200;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
