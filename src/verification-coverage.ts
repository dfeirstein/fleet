// Verification coverage of project memory — Parth Asawa's fail → investigate →
// verify → distill → consult progression (research/continual-learning-bench-…md).
//
// Fleet verifies WORK (the proof-of-work gate in proof.ts) but not MEMORY: a
// CLAUDE.md / .claude-docs claim can be an open guess ("maybe prc instead of
// prc_usd?") that never gets checked. This PURE classifier scores what fraction
// of substantive claim lines are checked facts vs. uncertainty-flagged guesses,
// so `fleet audit-docs` can surface unverified memory the same way the currency
// rule surfaces stale version pins — extending provenance discipline from
// version pins to gotchas.
//
// Posture (see audit-docs.ts): an unverified line is a FLAGGED WARNING that
// lowers the memory-quality signal — memory may legitimately hold a
// queued-for-verification note, but it must be VISIBLE. It does NOT hard-fail
// the audit on its own; hard-fail stays reserved for inconclusive inputs
// (unreadable file / scorer crash).

/**
 * Uncertainty markers that flag a claim line as UNVERIFIED. Matched
 * case-insensitively. Kept as a SINGLE exported constant so it's easy to tune.
 *
 * Word/phrase markers use boundaries so they don't match inside larger words;
 * punctuation markers (a trailing "?", "(?)") catch open questions. Note the
 * deliberately CONSERVATIVE tradeoff: a bare "maybe"/"possibly" in ordinary
 * prose WILL flag — we'd rather over-flag a hedge than let an open guess pass
 * as a checked fact. "might" alone does NOT flag (only the phrase "might be"),
 * which keeps the common false positive ("you might want to…") quiet.
 */
export const UNVERIFIED_MARKERS: readonly RegExp[] = [
  /\bmaybe\b/i,
  /\bpossibly\b/i,
  /\bprobably\b/i,
  /\bmight be\b/i,
  /\bnot sure\b/i,
  /\bunverified\b/i,
  /\bneeds verification\b/i,
  /verify\?/i,
  /todo:\s*confirm/i,
  /\(\?\)/,
  /\?\s*$/,
];

/** The uncertainty marker a line tripped (its matched text), or undefined if the
 *  line reads as a checked claim. Pure; the heart of the classifier. */
export function markerFor(text: string): string | undefined {
  for (const re of UNVERIFIED_MARKERS) {
    const m = text.match(re);
    if (m) return m[0].trim() || m[0];
  }
  return undefined;
}

export interface ClaimLine {
  /** File as given by the caller (e.g. "CLAUDE.md", ".claude-docs/architecture.md"). */
  file: string;
  /** 1-based line number, for a clickable `file:line` ref. */
  line: number;
  text: string;
  verified: boolean;
  /** The uncertainty marker that flagged it (only set when !verified). */
  marker?: string;
}

export interface CoverageReport {
  verified: number;
  total: number;
  /** verified / total as an integer percent; 100 when there are no claims. */
  percent: number;
  unverified: ClaimLine[];
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*(?:`{3,}|~{3,})/;
// A table-of-contents entry: the bullet body is just a markdown link, optionally
// followed by a short "— description". Skipped — it's navigation, not a claim.
const TOC_ENTRY = /^\[[^\]]+\]\([^)]+\)(?:\s*[—-].*)?$/;

export interface CoverageInput {
  file: string;
  content: string;
  /** CLAUDE.md → true (only bullets under a "Gotchas"-like heading are claims —
   *  the Behavioral/Currency directives aren't factual claims). .claude-docs
   *  bodies → false (every body bullet is a claim). */
  gotchasOnly: boolean;
}

/**
 * Extract the substantive claim lines from one doc and classify each. PURE.
 * Skip rules: code fences (toggled by ``` / ~~~), headings, non-bullet prose
 * and continuation lines, and table-of-contents link entries. In gotchasOnly
 * mode a line counts only while the current section heading matches /gotcha/i.
 */
export function claimLines(content: string, file: string, gotchasOnly: boolean): ClaimLine[] {
  const out: ClaimLine[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let inScope = !gotchasOnly; // body scope is always in-scope; gotchas scope starts closed
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = raw.match(HEADING);
    if (h) {
      if (gotchasOnly) inScope = /gotcha/i.test(h[1] ?? "");
      continue; // a heading is never a claim
    }
    if (!inScope) continue;
    const b = raw.match(BULLET);
    if (!b) continue; // prose / continuation lines aren't standalone claims
    const text = (b[1] ?? "").trim();
    if (!text || TOC_ENTRY.test(text)) continue;
    const marker = markerFor(text);
    out.push({ file, line: i + 1, text, verified: marker === undefined, marker });
  }
  return out;
}

/** Aggregate verification coverage across a project's memory docs. PURE. */
export function verificationCoverage(inputs: CoverageInput[]): CoverageReport {
  const all = inputs.flatMap((f) => claimLines(f.content, f.file, f.gotchasOnly));
  const unverified = all.filter((l) => !l.verified);
  const total = all.length;
  const verified = total - unverified.length;
  const percent = total === 0 ? 100 : Math.round((verified / total) * 100);
  return { verified, total, percent, unverified };
}
