// `fleet audit-docs [--cwd P]` — the eval gate for project memory. It scores the
// project's CLAUDE.md with the claude-md-architect scorer (judge ≠ generator: a
// separate tool, not the worker that wrote it) and flags any currency fact past
// its TTL. Used after a wave to decide whether project memory needs a refresh.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeMdPath, currencyJsonPath, CURRENCY_TTL_DAYS } from "../project-memory.js";

/** Candidate locations for the claude-md-architect audit scorer. */
function scorerPath(): string | undefined {
  const candidates = [
    join(homedir(), ".claude", "skills", "claude-md-architect", "scripts", "audit_claude_md.py"),
    join(homedir(), ".claude", "plugins", "claude-md-architect", "scripts", "audit_claude_md.py"),
  ];
  return candidates.find((p) => existsSync(p));
}

export interface AuditResult {
  hasClaudeMd: boolean;
  score?: number;
  grade?: string;
  report: string;
  staleCurrency: string[];
  currencyChecked: boolean;
  pass: boolean;
}

function parseScore(out: string): { score?: number; grade?: string } {
  const machine = out.match(/SCORE:(\d+)\|/);
  const grade = out.match(/Grade:\s*([A-F])/i);
  return {
    score: machine ? Number(machine[1]) : undefined,
    grade: grade ? grade[1]!.toUpperCase() : undefined,
  };
}

/** Currency entries whose resolved fact is older than the cache's TTL. */
function staleCurrency(cwd: string): { stale: string[]; checked: boolean } {
  const p = currencyJsonPath(cwd);
  if (!existsSync(p)) return { stale: [], checked: false };
  try {
    const cache = JSON.parse(readFileSync(p, "utf8")) as {
      ttlDays?: number;
      entries?: Array<{ name: string; fetchedAt?: string }>;
    };
    const ttl = cache.ttlDays ?? CURRENCY_TTL_DAYS;
    const stale = (cache.entries ?? [])
      .filter((e) => {
        if (!e.fetchedAt) return true;
        const age = (Date.now() - new Date(e.fetchedAt).getTime()) / 86_400_000;
        return !Number.isFinite(age) || age >= ttl;
      })
      .map((e) => e.name);
    return { stale, checked: true };
  } catch {
    return { stale: [], checked: false };
  }
}

/**
 * Audit a project's durable memory. `minScore` is the gate threshold (default
 * 60 = grade C or better). Passes when CLAUDE.md exists, scores >= minScore, and
 * no currency fact is stale.
 */
export function auditDocs(opts: { cwd: string; minScore?: number }): AuditResult {
  const minScore = opts.minScore ?? 60;
  const mdPath = claudeMdPath(opts.cwd);
  const hasClaudeMd = existsSync(mdPath);

  let report = "";
  let score: number | undefined;
  let grade: string | undefined;

  if (!hasClaudeMd) {
    report = `No CLAUDE.md in ${opts.cwd}. Run \`fleet bootstrap --cwd ${opts.cwd}\` to create one.`;
  } else {
    const scorer = scorerPath();
    if (!scorer) {
      report = `claude-md-architect scorer not found — install the skill to score CLAUDE.md. (CLAUDE.md exists.)`;
    } else {
      try {
        report = execFileSync("python3", [scorer, mdPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        ({ score, grade } = parseScore(report));
      } catch (err) {
        report = `scorer failed: ${(err as Error).message}`;
      }
    }
  }

  const { stale, checked } = staleCurrency(opts.cwd);
  const pass = hasClaudeMd && (score === undefined || score >= minScore) && stale.length === 0;

  return { hasClaudeMd, score, grade, report, staleCurrency: stale, currencyChecked: checked, pass };
}
