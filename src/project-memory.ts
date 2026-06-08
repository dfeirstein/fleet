// Shared constants + paths for a project's durable memory: its CLAUDE.md and the
// `.claude-docs/` reference folder. Used by `fleet bootstrap`, `fleet currency`,
// and `fleet audit-docs` so they agree on conventions (folder name, TTL, the
// currency clause baked into CLAUDE.md and worker briefs).
import { join } from "node:path";

/** The reference-docs folder, matching the claude-md-architect skill convention. */
export const CLAUDE_DOCS_DIR = ".claude-docs";

/** How long a resolved version/model fact stays fresh before `fleet currency` re-fetches it. */
export const CURRENCY_TTL_DAYS = 7;

export function claudeMdPath(cwd: string): string {
  return join(cwd, "CLAUDE.md");
}
export function claudeDocsDir(cwd: string): string {
  return join(cwd, CLAUDE_DOCS_DIR);
}
/** Machine-readable currency cache (resolved facts + provenance + fetch dates). */
export function currencyJsonPath(cwd: string): string {
  return join(claudeDocsDir(cwd), "currency.json");
}
/** Human-readable version table embedded/linked from CLAUDE.md. */
export function versionsMdPath(cwd: string): string {
  return join(claudeDocsDir(cwd), "versions.md");
}

/**
 * The currency discipline, in worker-facing language. `fleet bootstrap` writes
 * this into a project's CLAUDE.md so every worker inherits it; until a project
 * carries it, the Captain pastes it into the brief. The honest framing: an agent
 * cannot know what's stale, so the rule is "resolve from source", not "use latest".
 */
export const CURRENCY_CLAUSE = `## Currency (do not trust the training cutoff)

Never write a package version, LLM model ID, or API signature from memory.
Resolve it from an authoritative live source and record it with provenance:

- Versions: the npm / PyPI registry (see ${CLAUDE_DOCS_DIR}/versions.md, refreshed by \`fleet currency\`).
- Model IDs & API versions: the provider's official docs (mapped in ${CLAUDE_DOCS_DIR}/currency.json).
- If a fact is missing or older than ${CURRENCY_TTL_DAYS} days, fetch it from source, use it, and write it back with source URL + date.
- Prefer the latest stable release unless this file pins an older version for a stated reason.`;
