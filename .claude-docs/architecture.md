# Architecture — how fleet is wired

Fleet is a thin TypeScript CLI that turns the cmux terminal into a multi-agent
control plane. One Claude Code session (the **Fleet Captain**) runs `fleet …`
commands to launch, steer, and monitor **worker** Claude Code sessions, each in
its own cmux pane.

## Layers (outer → inner)

```
bin/fleet            # bash auto-update layer (24h throttle, ff-only on clean main, notices
                     #   → stderr — stdout stays clean) → `tsx src/cli.ts "$@"` (no build step)
src/cli.ts           # arg parsing → command dispatch (the only switch statement)
src/commands/*.ts    # one file per verb: spawn, grid, read, send, status, watch,
                     #   kill, resume, orchestrate, verify, gc, update, done, bootstrap,
                     #   currency, audit-docs, capture, objective, daemon, notify, doctor, setup
                     #   (+ pure decision cores beside their verb: captain-args.ts, gc.ts)
src/cmux.ts          # THE ONLY place that shells out to cmux (typed wrapper)
src/registry.ts      # ~/.fleet/<session>.json — persistent "who's doing what"
src/status.ts        # screen-text heuristic classifier (running/idle/awaiting/…)
src/notifications.ts # cmux notification feed → deterministic turn-end signal
src/dashboard.ts     # mirror fleet state into the cmux sidebar
src/git.ts           # worktree create/remove for isolated parallel writers
src/project-memory.ts# shared paths + the currency clause (bootstrap/currency/audit-docs)
src/cmux-sessions.ts # typed reader for cmux's durable session map (~/.cmuxterm/claude-hook-sessions.json)
src/autoupdate.ts    # pure auto-update decision core (throttle / eligibility / lockfile-moved),
                     #   shared by the bin/fleet layer and `fleet update`
src/orchestrator-record.ts # the Captain's own record in ~/.fleet — TWO writers: captain
                     #   spawn/resume + daemon self-heal (last-writer-wins, no lock)
src/daemon/*.ts      # always-on heartbeat supervisor (config, inbox, channel, policy, selfheal, loop)
skills/fleet/        # SKILL.md + orchestrator-doctrine.md — teach a Captain the loop
```

## The one hard rule: cmux access funnels through `src/cmux.ts`

Every interaction with the cmux app goes through `src/cmux.ts`. The rest of the
codebase **never** calls `execFileSync`/`cmux` directly. This is the seam where a
future tmux backend would slot in, and it's where all the addressing and
TUI-submission gotchas are handled once. If you need a new cmux operation, add a
typed function here — don't shell out from a command file.

`cmux()` returns trimmed stdout (throws `CmuxError`); `cmuxJson<T>()` parses
`--json` output. The binary is resolved from `CMUX_BIN` → bundled app path →
`PATH`.

## Control flow of a spawn

1. `fleet spawn <task>` → `src/commands/spawn.ts`
2. `cmux.newWorkspace({ name, cwd, command })` boots a workspace and launches
   Claude Code via `--command` (cmux owns the PTY — more reliable than typing
   into a not-yet-live terminal).
3. `cmux.waitForTerminal()` polls `read-screen` until the PTY renders.
4. The task prompt is submitted with `cmux.submitToClaude()` (handles the
   bracketed-paste race — see [cmux-addressing](cmux-addressing.md)).
5. The worker is recorded in the registry (`~/.fleet/<session>.json`) keyed by
   workspace+surface UUIDs.

## Runtime state lives in `~/.fleet/` (not in the repo)

- `~/.fleet/<session>.json` — the per-project registry of workers.
- `~/.fleet/briefs/` — long worker briefs written to file then handed to a worker
  as a short "read this file" pointer task (sidesteps paste limits).
- `~/.fleet/daemon/inbox.md` — daemon escalations the Captain reads at turn start.

`FLEET_SESSION` selects which registry a command operates on. Each Captain gets
its own isolated session so multiple fleets don't collide.

## Completion detection (deterministic, with fallback)

cmux's wrapped Claude Code emits a notification when a worker's turn ends. `fleet`
reads that feed (`notification.list`) for a deterministic idle signal, falls back
to a screen-text heuristic (`src/status.ts`), and guards against stale
notifications from a previous turn via `lastDispatchAt`. See README "How a
worker's done is detected".

## The daemon

`fleet daemon start` runs a token-free heartbeat in its own cmux pane. Each beat
it reconciles the fleet, refreshes the sidebar, clears stuck `--yolo` bypass
dialogs, and escalates anything needing attention (awaiting-input, stuck/zombie,
error, rate-limited) — urgent + Captain-idle injects a turn; otherwise it appends
to the inbox.

ONE shared daemon watches all live Captains in a quadrant. Before dropping a
Captain whose recorded surface is gone, the beat self-heals stale records
(`src/daemon/selfheal.ts`, PR #42): if the workspace still exists and the durable
session map shows exactly ONE live candidate surface there (siblings' panes
excluded), it re-stamps the record's `surfaceId` (persisted via
`writeOrchestrator`, so every reader self-corrects). Ambiguous matches (>1
candidate) re-stamp nothing, and a record neither live nor re-matchable for ≥2
beats fires one loud escalation before it stops being watched — never silence.
Because the daemon and captain spawn/resume both write the orchestrator record
(last-writer-wins, no lock), always re-load it before mutating.
