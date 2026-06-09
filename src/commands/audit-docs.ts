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

/** State of the currency cache: distinguishes "never created" (the explicitly
 *  allowed soft case) from "exists but corrupt/unreadable" (fails closed). */
export type CurrencyState = "ok" | "missing" | "unreadable";

export interface AuditResult {
  hasClaudeMd: boolean;
  score?: number;
  grade?: string;
  report: string;
  staleCurrency: string[];
  currencyChecked: boolean;
  currencyState: CurrencyState;
  /** Why the gate failed (empty on pass). */
  failReasons: string[];
  /** Explicitly-allowed soft cases, stated so the gate contract is visible. */
  gateNotes: string[];
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
function staleCurrency(cwd: string): { stale: string[]; state: CurrencyState } {
  const p = currencyJsonPath(cwd);
  if (!existsSync(p)) return { stale: [], state: "missing" };
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
    return { stale, state: "ok" };
  } catch {
    return { stale: [], state: "unreadable" };
  }
}

export interface AuditDecisionInput {
  hasClaudeMd: boolean;
  /** Was the claude-md-architect scorer found on disk? */
  scorerFound: boolean;
  /** Parsed score; undefined = scorer crashed or emitted no parseable score. */
  score?: number;
  minScore: number;
  staleCurrency: string[];
  currencyState: CurrencyState;
}

/**
 * The audit-docs pass/fail decision — pure, unit-tested. FAILS CLOSED: an
 * inconclusive input (scorer missing/crashed, currency cache unreadable) is a
 * FAIL with a stated reason, never a silent pass. The ONE allowed soft case is
 * a currency cache that doesn't exist yet — and that is stated in the output
 * (gate contract visible), not silently skipped.
 */
export function decideAudit(i: AuditDecisionInput): { pass: boolean; reasons: string[]; notes: string[] } {
  const reasons: string[] = [];
  const notes: string[] = [];
  if (!i.hasClaudeMd) {
    reasons.push("no CLAUDE.md — run `fleet bootstrap`");
  } else if (!i.scorerFound) {
    reasons.push("scorer not installed — inconclusive, fail closed (install the claude-md-architect skill)");
  } else if (i.score === undefined) {
    reasons.push("scorer crashed or produced no score — inconclusive, fail closed");
  } else if (i.score < i.minScore) {
    reasons.push(`CLAUDE.md scored ${i.score} < ${i.minScore}`);
  }
  if (i.currencyState === "unreadable") {
    reasons.push("currency cache unreadable/corrupt — inconclusive, fail closed (re-run `fleet currency`)");
  } else if (i.currencyState === "missing") {
    notes.push(
      "currency: no cache file yet — soft pass by gate contract (a missing cache is allowed; an unreadable one fails). Run `fleet currency` to resolve versions/model-IDs.",
    );
  } else if (i.staleCurrency.length > 0) {
    reasons.push(`${i.staleCurrency.length} currency fact(s) past TTL — run \`fleet currency\``);
  }
  return { pass: reasons.length === 0, reasons, notes };
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
  const scorer = hasClaudeMd ? scorerPath() : undefined;

  if (!hasClaudeMd) {
    report = `No CLAUDE.md in ${opts.cwd}. Run \`fleet bootstrap --cwd ${opts.cwd}\` to create one.`;
  } else if (!scorer) {
    report = `claude-md-architect scorer not found — install the skill to score CLAUDE.md. (CLAUDE.md exists.)`;
  } else {
    try {
      report = execFileSync("python3", [scorer, mdPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      ({ score, grade } = parseScore(report));
    } catch (err) {
      report = `scorer failed: ${(err as Error).message}`;
    }
  }

  const { stale, state } = staleCurrency(opts.cwd);
  const { pass, reasons, notes } = decideAudit({
    hasClaudeMd,
    scorerFound: scorer !== undefined,
    score,
    minScore,
    staleCurrency: stale,
    currencyState: state,
  });

  return {
    hasClaudeMd,
    score,
    grade,
    report,
    staleCurrency: stale,
    currencyChecked: state === "ok",
    currencyState: state,
    failReasons: reasons,
    gateNotes: notes,
    pass,
  };
}
