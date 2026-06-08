// `fleet recall "<query>"` — the lookup half of the context engine (design Move 5).
//
// The Captain keeps its window lean by pushing detail to disk (outcome log, wave
// files, .claude-docs) and pulling it back ON DEMAND with recall — which runs the
// search OUTSIDE the window and returns only the matching lines, never the whole
// transcript. Zero-dep core (ripgrep/grep); opt-in semantic tier (QMD) if installed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_DOCS_DIR } from "../project-memory.js";

export type RecallSource = "qmd" | "ripgrep" | "grep" | "none";

export interface RecallResult {
  source: RecallSource;
  hits: string[];
  roots: string[];
}

function hasCmd(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Search the durable store for `query`. Roots: ~/.fleet (outcome logs) + the
 * project's .claude-docs (wave files, profiles, reference docs). Default is the
 * zero-dep grep core (which actually searches THESE roots). QMD is explicit
 * opt-in (`qmd: true`): it searches its OWN registered collections, so it only
 * helps once the user has indexed Fleet's store as a QMD collection
 * (`qmd collection add ~/.fleet --name fleet`). A no-match exit is "no hits".
 */
export function recall(query: string, opts: { cwd?: string; limit?: number; qmd?: boolean } = {}): RecallResult {
  const cwd = opts.cwd ?? process.cwd();
  const limit = opts.limit ?? 40;
  const roots = [join(homedir(), ".fleet"), join(cwd, CLAUDE_DOCS_DIR)].filter((p) => existsSync(p));
  if (roots.length === 0) return { source: "none", hits: [], roots };

  // Opt-in power tier: QMD semantic search over its registered collections.
  // NOTE: `qmd query` searches ALL collections registered with qmd, not just our
  // two `roots` — scope is broader than the grep core and not bounded by `roots`.
  // Best-effort — any failure falls through to the grep core.
  if (opts.qmd && hasCmd("qmd")) {
    try {
      const out = execFileSync("qmd", ["query", query], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20000,
      });
      // Keep only lines that look like real hits (a path + line), not a
      // localized "no results" sentinel.
      const hits = out.split("\n").map((l) => l.trimEnd()).filter((l) => l && /[\/.]\w+/.test(l) && /:\d|\.md|\.jsonl/.test(l));
      if (hits.length) return { source: "qmd", hits: hits.slice(0, limit), roots };
    } catch {
      // fall through to grep
    }
  }

  // Zero-dep core: ripgrep if present, else grep. Fixed-string match (-F) so the
  // query can't be interpreted as a regex.
  const useRg = hasCmd("rg");
  const bin = useRg ? "rg" : "grep";
  const args = useRg
    ? ["-F", "-i", "-n", "--no-heading", "--max-count", "3", "-g", "*.md", "-g", "*.jsonl", "--", query, ...roots]
    : ["-F", "-rin", "--include=*.md", "--include=*.jsonl", "--", query, ...roots];
  try {
    const out = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
    const hits = out.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, limit);
    return { source: useRg ? "ripgrep" : "grep", hits, roots };
  } catch {
    // grep/rg exit 1 on no match — treat as empty, not an error.
    return { source: useRg ? "ripgrep" : "grep", hits: [], roots };
  }
}
