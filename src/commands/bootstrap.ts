// `fleet bootstrap [--cwd P]` — ensure a project has strong, current durable
// memory (CLAUDE.md + .claude-docs/). It delegates the writing to a short-lived
// *scribe* worker that runs the `claude-md-architect` skill in the project, so
// the Captain stays in orchestrator mode rather than authoring docs itself.
import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, SPAWN_DEFAULTS } from "./spawn.js";
import { type Agent } from "../registry.js";
import { claudeMdPath, CLAUDE_DOCS_DIR, CURRENCY_CLAUSE } from "../project-memory.js";

export interface BootstrapOptions {
  cwd: string;
  model?: string;
  force?: boolean; // bootstrap even if a substantial CLAUDE.md already exists
}

/** A CLAUDE.md under this many bytes is treated as "thin" and worth (re)bootstrapping. */
const THIN_CLAUDE_MD_BYTES = 400;

/**
 * Default model for the scribe (the claude CLI `--model` alias, verified from
 * `claude --help`). The former "smarter scribe" model tier has been disabled,
 * so scribe/distill/memory workers now run on the fleet-wide Opus default like
 * every other worker. The tiering lever is now EFFORT, not model: the scribe's
 * mechanical scaffolding runs at low effort, but its quality-sensitive
 * distill/verify pass defaults to high (don't starve it — that pass was the
 * reason memory work once ran on the premium tier); execution workers run at
 * xhigh. The explicit const is kept for clarity and an explicit `--model` still
 * overrides.
 */
const SCRIBE_MODEL = "opus";

export function claudeMdState(cwd: string): "missing" | "thin" | "present" {
  const p = claudeMdPath(cwd);
  if (!existsSync(p)) return "missing";
  try {
    return statSync(p).size < THIN_CLAUDE_MD_BYTES ? "thin" : "present";
  } catch {
    return "missing";
  }
}

/** The scribe's brief: run claude-md-architect, seed .claude-docs, bake in the currency clause. */
export function scribeBrief(cwd: string): string {
  return [
    `You are a project-memory SCRIBE. Your one job is to give this project (${cwd}) strong, current durable memory and then stop. Do NOT build product features.`,
    ``,
    `Use the \`claude-md-architect\` skill as your source of best practice. Run it now:`,
    `- If a CLAUDE.md already exists, run Mode 3 (audit) and then optimize it.`,
    `- If this is an existing repo with no CLAUDE.md, run Mode 2 (auto-detect the stack).`,
    `- If it's greenfield/empty, run Mode 1 (Q&A) — ask Doug only the questions detection can't answer.`,
    ``,
    `Requirements for the result:`,
    `1. A lean CLAUDE.md (<120 lines, mistake-driven, verification-first) with the Karpathy Behavioral Rules block and a Reference Docs index.`,
    `2. A ${CLAUDE_DOCS_DIR}/ folder with 3–6 reference docs (framework gotchas, testing, deploy, stack-specific) and the generated index.`,
    `3. Use the skill's Research Phase to put the CURRENT stable version of each major dependency, the current LLM model IDs, and the current API versions into the docs — do NOT rely on your training cutoff; resolve them from npm/PyPI/official docs and cite the source URL + today's date.`,
    `4. Every gotcha/claim states HOW it was verified — a command you ran, a doc you consulted + date, or an observed behavior — or is prefixed \`unverified:\` and queued for verification. Drop failure notes you can't generalize into a rule: distill is "a general rule backed by a checked fact", not a diary of guesses (the progression: fail → investigate → verify → distill → consult). \`fleet audit-docs\` scores this as verification coverage.`,
    `5. Append this exact block to CLAUDE.md verbatim so every future worker inherits the discipline:`,
    ``,
    CURRENCY_CLAUSE,
    ``,
    `When done, commit the new/updated CLAUDE.md and ${CLAUDE_DOCS_DIR}/ to the current branch (do not push). Then report a one-paragraph summary of what you wrote and where.`,
  ].join("\n");
}

/**
 * Spawn the scribe. Returns the worker so the Captain can watch/steer it.
 * No-ops with a note if CLAUDE.md is already substantial (unless force).
 */
export function bootstrap(opts: BootstrapOptions): { agent?: Agent; skipped?: string } {
  const state = claudeMdState(opts.cwd);
  if (state === "present" && !opts.force) {
    return {
      skipped: `CLAUDE.md already present in ${opts.cwd} — skipping. Use \`fleet audit-docs\` to score it, \`fleet currency\` to refresh versions, or \`fleet bootstrap --force\` to rebuild.`,
    };
  }

  // The scribe brief is long (it embeds the full currency clause). Pasting a long
  // multi-paragraph prompt into the TUI hits paste-collapse and stalls unsubmitted,
  // so follow the doctrine's own rule: write the brief to a file and hand the
  // worker a SHORT pointer task that submits cleanly.
  const briefsDir = join(homedir(), ".fleet", "briefs");
  mkdirSync(briefsDir, { recursive: true });
  const briefPath = join(briefsDir, `scribe-${Date.now().toString(36)}.md`);
  writeFileSync(briefPath, scribeBrief(opts.cwd));

  const agent = spawn({
    task: `Read ${briefPath} and execute it exactly. It instructs you to give this project (${opts.cwd}) strong, current durable memory — a lean CLAUDE.md and a ${CLAUDE_DOCS_DIR}/ reference folder — then report back. Do not build product features.`,
    cwd: opts.cwd,
    label: "scribe",
    model: opts.model ?? SCRIBE_MODEL,
    mode: SPAWN_DEFAULTS.mode,
    launch: true,
    autostart: true,
    worktree: false,
    branch: undefined,
    command: undefined,
    standalone: true, // the scribe gets its own watchable workspace
  });
  return { agent };
}
