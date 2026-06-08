# Project-memory subsystem (bootstrap · currency · audit-docs)

Fleet's highest-leverage feature is keeping *other projects'* durable memory
strong and current — and it eats its own dog food (this very `CLAUDE.md` +
`.claude-docs/` were produced by it). The subsystem is three commands plus shared
paths in `src/project-memory.ts`.

## The shared contract: `src/project-memory.ts`

Single source of truth so `bootstrap`, `currency`, and `audit-docs` agree:

- `CLAUDE_DOCS_DIR = ".claude-docs"` — the reference folder name.
- `CURRENCY_TTL_DAYS = 7` — how long a resolved version/model fact stays fresh.
- Path helpers: `claudeMdPath`, `claudeDocsDir`, `currencyJsonPath`, `versionsMdPath`.
- `CURRENCY_CLAUSE` — the worker-facing currency discipline, written verbatim into
  a bootstrapped project's `CLAUDE.md` so every worker inherits it.

## `fleet bootstrap [--cwd P] [--force]` — `src/commands/bootstrap.ts`

Gives a project strong durable memory by spawning a short-lived **scribe** worker
that runs the `claude-md-architect` skill *in that project*. The Captain stays in
orchestrator mode; it does **not** hand-write CLAUDE.md itself.

- `claudeMdState()` classifies the target: `missing` / `thin` (<400 bytes) /
  `present`. Bootstrap no-ops on `present` unless `--force`.
- The scribe brief is long, so bootstrap writes it to `~/.fleet/briefs/scribe-*.md`
  and hands the worker a short pointer task (the paste-collapse rule from
  [cmux-addressing.md](cmux-addressing.md)).
- The brief mandates: lean CLAUDE.md (<120 lines) + Karpathy rules + Reference
  Docs index, a `.claude-docs/` folder, live-resolved versions with provenance,
  and the `CURRENCY_CLAUSE` appended verbatim. Then commit (no push) and report.

## `fleet currency [--cwd P] [--force]` — `src/commands/currency.ts`

The engine behind "never trust the training cutoff". Mostly deterministic and
token-free — a **registry lookup, not inference**.

- Reads declared deps from `package.json` / `requirements.txt` / `pyproject.toml`.
- Resolves the latest version of each from the **npm** (`registry.npmjs.org`) and
  **PyPI** (`pypi.org`) registries, with bounded concurrency (8).
- Model IDs come from a curated `MODEL_REGISTRY` (there is no universal "latest
  model" registry) — update it when a provider ships a new model.
- Writes `.claude-docs/currency.json` (machine cache: fact + source URL + fetch
  date) and `.claude-docs/versions.md` (human table). Honors the 7-day TTL: only
  missing/stale facts are re-fetched, so reruns are cheap.
- Prints a **drift diff** (pinned vs latest) so upgrades are a decision, not a
  surprise. (At time of writing: `typescript ^5.7.2 → 6.0.3`,
  `tsx ^4.19.2 → 4.22.4` — both major/minor updates available but not yet taken.)

**Fail-closed rule:** never stamp a failed registry lookup with today's date — a
cached failure masks real drift for the whole TTL. Unresolved facts are marked
`unresolved`, not dated as fresh.

## `fleet audit-docs [--cwd P] [--min N]` — `src/commands/audit-docs.ts`

The eval gate for project memory. Scores `CLAUDE.md` (via the `claude-md-architect`
audit rubric) and flags any currency fact past its TTL. **Exits non-zero on fail**
— it fails closed: a missing scorer or unreadable file is a FAIL, not a pass. Run
it after editing memory; if the score dropped or facts are stale, spawn a scribe
to refresh.

## How this maps to the doctrine

`skills/fleet/orchestrator-doctrine.md` § "Project memory is sacred" is the
narrative; these three commands are its implementation. Bootstrap seeds memory,
currency keeps it current, audit-docs gates it. Workers inherit all of it for free
because Claude Code auto-loads `CLAUDE.md` and loads `.claude-docs/` on demand via
the Reference Docs index.
