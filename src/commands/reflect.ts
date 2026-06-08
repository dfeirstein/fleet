// `fleet reflect` — scaffold a doctrine-delta PROPOSAL from outcome-log signal
// (design Move 7). This is the safe, human-in-the-loop half of self-evolution:
// it reads what actually happened (delegations, verify failures) and writes a
// proposal file for a human/reviewed-Captain to fill — it NEVER edits the live
// doctrine. Adoption is via PR review only. See docs/doctrine-deltas/README.md.
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readOutcomes, type OutcomeRecord } from "../outcomes.js";

function tally(items: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function reflect(session?: string): { path: string; spawns: number; fails: number } {
  const all: OutcomeRecord[] = readOutcomes(session);
  const spawns = all.filter((e) => e.event === "spawn").length;
  const verifies = all.filter((e) => e.event === "verify");
  const fails = verifies.filter((v) => v.verdict === "fail");
  const failChecks = tally(fails.map((f) => f.check ?? "(unknown)")).slice(0, 8);
  const recentFails = fails.slice(-6).map((f) => `- ${f.label}: \`${f.check ?? ""}\``);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = fileURLToPath(new URL("../../docs/doctrine-deltas/", import.meta.url));
  const path = join(dir, `${stamp}-proposal.md`);

  const body = [
    `# Doctrine-delta proposal — ${stamp}`,
    ``,
    `> Scaffolded by \`fleet reflect\`. This changes NO doctrine. Fill it in, then`,
    `> adopt only via PR review (judge ≠ generator). See ./README.md.`,
    ``,
    `## Signal (from the delegation-outcome log)`,
    `- delegations: ${spawns}`,
    `- verify failures: ${fails.length} / ${verifies.length} checks`,
    ``,
    `### Most-failed checks`,
    failChecks.length ? failChecks.map(([c, n]) => `- ${n}× \`${c}\``).join("\n") : "_(none)_",
    ``,
    `### Recent failures`,
    recentFails.length ? recentFails.join("\n") : "_(none)_",
    ``,
    `## Proposal (fill in)`,
    ``,
    `**Problem.** _What recurring failure/inefficiency does the signal show?_`,
    ``,
    `**The one delta.** _A single narrow change to the doctrine/a skill/a CLI pattern._`,
    ``,
    `**Scope check.** _Project-AGNOSTIC? (If it's a project fact, it goes to that`,
    `project's CLAUDE.md/.claude-docs instead — reject here.)_`,
    ``,
    `**Evaluation.** _Which past objectives would test it? What fleet metric`,
    `(wave success rate / tokens-per-objective / escalation count) should improve`,
    `without regressing a smoke set?_`,
    ``,
    `**Decision.** _Adopt via PR / reject / needs more signal._`,
    ``,
  ].join("\n");

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  return { path, spawns, fails: fails.length };
}
