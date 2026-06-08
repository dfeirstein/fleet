# Fleet

Multi-agent orchestrator on top of [cmux](https://github.com/manaflow-ai/cmux).
One Claude Code session (the **Fleet Captain**) runs `fleet …` to launch, steer,
and monitor **worker** Claude Code sessions, each in its own cmux pane, all under
the user's Max plan.

## What This Is
- Language: TypeScript (pure ESM, `"type": "module"`), run via `tsx` — **no build step**
- Runtime: Node 20+ (Node 22 LTS "Jod" local). **Zero runtime deps** (only devDeps: `tsx` pinned `^4.19.2`, `typescript` pinned `^5.7.2`)
- Entry: `bin/fleet` → `tsx src/cli.ts`; one command per file in `src/commands/`
- Stack resolved 2026-06-08 (latest npm: tsx 4.22.4, typescript 6.0.3 — pins lag intentionally). Refresh with `fleet currency`; full table in `.claude-docs/versions.md`.
- Structure:
  - `src/cli.ts` — arg parse → command dispatch (the only switch)
  - `src/cmux.ts` — **the only place that shells out to cmux** (typed wrapper)
  - `src/commands/` — spawn, grid, read, send, status, watch, kill, resume, verify, bootstrap, currency, audit-docs, capture, objective, daemon, notify, doctor, setup, orchestrate
  - `src/daemon/` — always-on heartbeat supervisor (config, inbox, channel, policy, loop)
  - `src/registry.ts` / `project-memory.ts` / `status.ts` / `notifications.ts` — state, memory paths, classifier, turn-end signal
  - `skills/fleet/` — `SKILL.md` + `orchestrator-doctrine.md` (teach a Captain the loop)

## Why Things Are This Way
- cmux is a scriptable terminal, not an orchestrator. Fleet is the control layer:
  it wraps cmux verbs into a small stable command set a Captain can reason over.
- Runtime state lives in `~/.fleet/` (per-session registry, briefs, daemon inbox),
  **not** in the repo. `FLEET_SESSION` selects which fleet a command operates on.
- Key decisions:
  - All cmux access funnels through `src/cmux.ts` — the seam for a future tmux
    backend, and where every addressing/TUI-submission gotcha is solved once.
  - The Captain **delegates** via the fleet by default; it does not act as a
    straight coding agent (see `skills/fleet/orchestrator-doctrine.md`).
  - Independent evaluation gates "done": **judge ≠ generator**, and gates **fail
    closed** (inconclusive = FAIL).

## How to Work Here
```bash
./bin/fleet <command>     # run the CLI (or: npm run fleet -- <command>) — no build
npm run typecheck         # tsc --noEmit — the one automated gate, keep it green
./bin/fleet doctor        # smoke test: install / cmux reachable / PATH / skill
./bin/fleet help          # surface of every command
fleet audit-docs          # eval gate: score CLAUDE.md + flag stale currency (fails closed)
fleet currency            # refresh .claude-docs/versions.md from npm/PyPI registries
```
There is **no test runner** — verify by typecheck + running the CLI. See
`.claude-docs/verification.md`.

### Before Submitting
1. `npm run typecheck` passes.
2. Relative imports end in `.js`; type-only imports use `import type` (ESM +
   `verbatimModuleSyntax`).
3. Any new cmux interaction went through `src/cmux.ts` — never a fresh `execFileSync`.
4. If you touched project memory, `fleet audit-docs` passes and `fleet currency`
   shows no unexpected drift.

## Gotchas
- **Address workers by `--workspace <uuid> --surface <uuid>` together.** Workspace
  alone breaks once a browser surface exists ("Surface is not a terminal"); surface
  alone is unreliable; `workspace:N`/`surface:N` refs renumber — use UUIDs.
- **Submitting to a Claude TUI is a bracketed-paste race.** Type → wait ~450ms →
  Enter → **verify the input cleared** (re-Enter up to 6×). `submitToClaude()` owns this.
- **Long prompts hit paste-collapse.** Write the brief to a file and hand the
  worker a short "read this file and execute it" pointer task.
- **The PTY boots lazily** — `new-workspace` returns before the terminal is live;
  always `waitForTerminal()` before sending.
- `noUncheckedIndexedAccess` is on — array/record indexing is `T | undefined`; handle it.
- **Never write a version/model ID/API shape from memory** — see Currency below.
- IMPORTANT: a generator never grades its own work; route verification through a
  *separate* reviewer, and re-check a fix with the reviewer, not the fixer.

## Behavioral Rules
Bias toward caution over speed. Use judgment on trivial tasks.
- **Think first**: state assumptions; ask if unclear; surface tradeoffs and simpler alternatives.
- **Simplicity**: minimum code that solves the task. No speculative features, abstractions, configurability, or error handling for impossible cases.
- **Surgical edits**: every changed line must trace to the request. Don't "improve" adjacent code. Match existing style. Remove only orphans your changes created.
- **Goal-driven**: define success criteria up front. State a brief plan with verify steps. Loop until verified (e.g., "add validation" -> "write tests for invalid inputs, then make them pass").

## Reference Docs
On-demand documentation index — each file loads when its topic is relevant.
Maintained by `fleet bootstrap`/`fleet currency`; re-audit with `fleet audit-docs`.
```
architecture|.claude-docs/architecture.md|Module map, the cmux.ts shell-out seam, spawn flow, ~/.fleet state, the daemon
cmux-addressing|.claude-docs/cmux-addressing.md|Workspace+surface UUID addressing, TUI bracketed-paste submit, lazy PTY boot
typescript-esm|.claude-docs/typescript-esm.md|ESM + tsx: .js import extensions, import type, strict/noUncheckedIndexedAccess, no build
verification|.claude-docs/verification.md|No test runner — typecheck + CLI + fleet verify/audit-docs (fail-closed) eval gates
project-memory|.claude-docs/project-memory.md|bootstrap/currency/audit-docs subsystem that keeps CLAUDE.md + .claude-docs current
versions|.claude-docs/versions.md|Live-resolved dependency versions + LLM model IDs with provenance (fleet currency)
```

## Currency (do not trust the training cutoff)

Never write a package version, LLM model ID, or API signature from memory.
Resolve it from an authoritative live source and record it with provenance:

- Versions: the npm / PyPI registry (see .claude-docs/versions.md, refreshed by `fleet currency`).
- Model IDs & API versions: the provider's official docs (mapped in .claude-docs/currency.json).
- If a fact is missing or older than 7 days, fetch it from source, use it, and write it back with source URL + date.
- Prefer the latest stable release unless this file pins an older version for a stated reason.
