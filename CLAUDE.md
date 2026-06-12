# Fleet

Multi-agent orchestrator on top of [cmux](https://github.com/manaflow-ai/cmux). One Claude Code
session (the **Fleet Captain**) runs `fleet …` to launch, steer, and monitor **worker** Claude Code
sessions, each in its own cmux pane, all under the user's Max plan.

## What This Is
- Language: TypeScript (pure ESM, `"type": "module"`), run via `tsx` — **no build step**
- Runtime: Node 20+ (Node 22 LTS "Jod" local). **Zero runtime deps** (only devDeps: `tsx` pinned `^4.19.2`, `typescript` pinned `^5.7.2`, `@types/node` `^25.9.2`)
- Entry: `bin/fleet` (bash auto-update layer) → `tsx src/cli.ts`; one command per file in `src/commands/`
- Stack resolved 2026-06-08 (latest npm: tsx 4.22.4, typescript 6.0.3 — pins lag intentionally). Refresh with `fleet currency`; full table in `.claude-docs/versions.md`.
- Structure:
  - `src/cli.ts` — arg parse → command dispatch (the only switch)
  - `src/cmux.ts` — **the only place that shells out to cmux** (typed wrapper)
  - `src/commands/` — spawn, grid, read, send, status, watch, kill, resume, verify, gc, update, done, bootstrap, currency, audit-docs, capture, objective, daemon, notify, doctor, setup, orchestrate
  - `src/daemon/` — always-on heartbeat supervisor (config, inbox, channel, policy, selfheal, loop).
    **ONE shared daemon** watches ALL live Captains in a quadrant (`loadAllOrchestrators` filtered by
    `surfaceExists`, plus a `~/.fleet/daemon.pid` single-instance lock); `captain --split` calls
    `ensureSharedDaemon()` and NEVER spawns a per-Captain daemon. `fleet daemon start` returns before
    the new pane's PTY boots — an immediate `daemon status` may say "not running" for ~2-3s (boot race).
  - `src/events.ts` — event reactor: classifies the cmux event stream into worker-state signals (daemon + watch consume it). `src/proof.ts` + `commands/done.ts` — the proof-of-work gate.
  - `src/registry.ts` / `project-memory.ts` / `status.ts` / `notifications.ts` / `autoupdate.ts` — state, memory paths, classifier, turn-end signal, update-throttle decision core
  - `skills/fleet/` — `SKILL.md` + `orchestrator-doctrine.md` (teach a Captain the loop)

## Why Things Are This Way
- cmux is a scriptable terminal, not an orchestrator — fleet is the control layer that wraps cmux verbs
  into a small stable command set a Captain can reason over. Runtime state lives in `~/.fleet/` (per-session
  registry, briefs, daemon inbox), **not** in the repo; `FLEET_SESSION` selects which fleet a command operates on.
- Key decisions: all cmux access funnels through `src/cmux.ts` — the seam for a future tmux backend, where
  every addressing/TUI-submission gotcha is solved once; the Captain **delegates** via the fleet by default
  (see `skills/fleet/orchestrator-doctrine.md`); independent evaluation gates "done" — **judge ≠ generator**,
  and gates **fail closed** (inconclusive = FAIL).

## How to Work Here
```bash
./bin/fleet <command>     # run the CLI — no build; `fleet help` lists every command
npm run typecheck         # tsc --noEmit — the one automated gate, keep it green
./bin/fleet doctor        # smoke test: install / cmux reachable / PATH / skill / install-mode
./bin/fleet setup --hotkey # also bind ⌘⇧Y in cmux.json → `fleet captain --split` (JSONC-safe merge, backs up, reload-config)
fleet audit-docs          # eval gate: score CLAUDE.md + flag stale currency (fails closed)
fleet currency            # refresh .claude-docs/versions.md from npm/PyPI registries
```
There is **no test runner EXCEPT `node:test`** for pure decision cores (the event classifier, the proof
gate, `gc` planning, daemon selfheal, autoupdate, captain-args) — run with `npm test` (`node --import tsx
--test`); everything else verifies by typecheck + CLI + live E2E. See `.claude-docs/verification.md`.

### Before Submitting
1. `npm run typecheck` passes.
2. Every PR adds its entry to `CHANGELOG.md` under **Unreleased** (one terse bullet, PR number added at merge).
3. Relative imports end in `.js`; type-only imports use `import type` (ESM + `verbatimModuleSyntax`).
4. Any new cmux interaction went through `src/cmux.ts` — never a fresh `execFileSync`.
5. If you touched project memory, `fleet audit-docs` passes and `fleet currency` shows no unexpected drift.

## Gotchas
- **Quadrant siblings share ONE workspace** (each Captain is a separate surface/pane). Reason about Captain
  liveness/teardown by **surface** (`surfaceExists`), not workspace — a workspace check can't tell a closed
  sibling pane from its live neighbors.
- **Address workers by `--workspace <uuid> --surface <uuid>` together.** Workspace alone breaks once a browser
  surface exists ("Surface is not a terminal"); surface alone is unreliable; `workspace:N`/`surface:N` refs renumber — use UUIDs.
- **Submitting to a Claude TUI is a bracketed-paste race** — and a paste into a still-booting splash is silently
  eaten. Gate on TUI readiness first, then type → ~450ms → Enter → verify the input cleared (re-Enter up to
  6×). `submitToClaude()` owns all of this (readiness gate: PR #45 tests).
- **Long prompts hit paste-collapse.** Write the brief to a file and hand the worker a short "read this file and execute it" pointer task.
- **The PTY boots lazily** — `new-workspace` returns before the terminal is live; always `waitForTerminal()` before sending.
- **Never resume a Captain via `claude --continue`** — with multiple sessions sharing a cwd it forks into the
  wrong conversation; resume by explicit `claude --resume <sessionId>` (resolved from the orchestrator record /
  durable session map). Verified: PR #44 tests + live fork observed 2026-06-11 (issue #36).
- **The orchestrator record has TWO writers** — captain spawn/resume (whole-record `writeFileSync`) and daemon
  self-heal (`writeOrchestrator` re-stamping `surfaceId`); last-writer-wins, no lock — re-load before mutating
  or a stale copy clobbers the other writer's stamp. Verified: PR #42 + #44 tests; code read 2026-06-11.
- **`bin/fleet` runs a bash auto-update layer before tsx** — its stdout must stay clean (callers parse command
  output); notices go to stderr only. Throttled to once/24h, ff-only on a clean `main`, `FLEET_NO_AUTOUPDATE=1`
  opts out, any failure degrades to running the existing code. Verified: PR #47 autoupdate tests + live install 2026-06-11.
- **Existence probes must distinguish `not_found` from transient errors** — model them `present|absent|unknown`;
  only cmux's `not_found` machine code means gone, any other failure is `unknown` → KEEP (fail closed — a flaky
  probe must never read as dead). Verified: PR #46 `planGc` tests.
- `noUncheckedIndexedAccess` is on — array/record indexing is `T | undefined`; handle it.
- **Never write a version/model ID/API shape from memory** — see Currency below.
- IMPORTANT: a generator never grades its own work; route verification through a *separate*
  reviewer, and re-check a fix with the reviewer, not the fixer.
- **Event stream is push-*triggered-pull***: `notification.*`/`feed.*` payloads are redacted — pull
  content via `*.list` RPC. Feed items key on `session_id`, not `workspace_id` (map from `agent.hook.*`).
  Ignore `category:"sidebar"` frames (our own echoes → infinite loop). Gate on `cmux capabilities`;
  fall back to polling. See `.claude-docs/event-stream.md`.
- **Proof gate `note:` is metadata-only** — never satisfies "done" alone; `complete` needs a
  checkable `test:`/`file:` proof (judge ≠ generator, fail closed).
- **Parallel branches off one base merge sequentially.** Each later PR re-merges updated main in its own
  worktree: at append seams keep BOTH sides (main's first); tests are the UNION of all suites — post-merge
  count must equal the sum, and a failing test means fix the integration, never delete the test; in CHANGELOG
  keep your own bullet under Unreleased and move merged siblings' bullets under their date heading with `(#PR)`.
- **Memory is verified like work.** Each gotcha/claim in CLAUDE.md/.claude-docs states how it was checked
  (command run, doc + date, observed behavior) or is flagged pending a check and queued; `fleet audit-docs`
  scores verification coverage and we drop guesses we can't turn into a checked rule (fail → investigate → verify → distill → consult).

## Behavioral Rules
Bias toward caution over speed. Use judgment on trivial tasks.
- **Think first**: state assumptions; ask if unclear; surface tradeoffs and simpler alternatives.
- **Simplicity**: minimum code that solves the task. No speculative features, abstractions, configurability, or error handling for impossible cases.
- **Surgical edits**: every changed line must trace to the request. Don't "improve" adjacent code. Match existing style. Remove only orphans your changes created.
- **Goal-driven**: define success criteria up front. State a brief plan with verify steps. Loop until verified (e.g., "add validation" -> "write tests for invalid inputs, then make them pass").

## Reference Docs
On-demand docs index — each file loads when its topic is relevant. Maintained by `fleet bootstrap`/`fleet currency`; re-audit with `fleet audit-docs`.
```
architecture|.claude-docs/architecture.md|Module map, the cmux.ts shell-out seam, spawn flow, ~/.fleet state, the daemon + selfheal, bin/fleet auto-update layer
event-stream|.claude-docs/event-stream.md|Event reactor (cmux event stream → worker state) + the proof-of-work gate: redacted payloads, session↔workspace map, sidebar self-echo, done-signal, note: fail-closed rule
context-guard|.claude-docs/context-guard.md|Daemon context-occupancy guard: ~/.fleet/ctx sidecar telemetry, 50%/66% compaction policy (auto-/compact idle workers, nudge the Captain), fail-closed staleness, configurable thresholds
cmux-addressing|.claude-docs/cmux-addressing.md|Workspace+surface UUID addressing, TUI readiness gate + bracketed-paste submit, lazy PTY boot
typescript-esm|.claude-docs/typescript-esm.md|ESM + tsx: .js import extensions, import type, strict/noUncheckedIndexedAccess, no build
verification|.claude-docs/verification.md|node:test for pure decision cores + typecheck + CLI + fleet verify/audit-docs (fail-closed) eval gates
project-memory|.claude-docs/project-memory.md|bootstrap/currency/audit-docs subsystem that keeps CLAUDE.md + .claude-docs current
versions|.claude-docs/versions.md|Live-resolved dependency versions + LLM model IDs with provenance (fleet currency)
```

## Currency (do not trust the training cutoff)
Never write a package version, LLM model ID, or API signature from memory — resolve it from an authoritative
live source and record it with provenance: versions from the npm/PyPI registry (`.claude-docs/versions.md`,
refreshed by `fleet currency`); model IDs & API versions from the provider's official docs (mapped in
`.claude-docs/currency.json`). If a fact is missing or older than 7 days, fetch it from source, use it, and
write it back with source URL + date. Prefer the latest stable release unless this file pins an older version for a stated reason.
