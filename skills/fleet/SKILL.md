---
name: fleet
description: Orchestrate multiple Claude Code worker agents in parallel using the `fleet` CLI on top of cmux. Use when the user asks to "spawn agents", "run agents in parallel", "fan out", "orchestrate", "use a team of agents", "split into a grid of agents", "have N agents build X", or otherwise wants the current Claude session to act as an orchestrator that launches and steers other Claude Code workers. Workers run under the user's Max plan (no API key). Works from any project directory; each project gets its own isolated fleet.
---

# Fleet — multi-agent orchestrator on cmux

You (this Claude Code session) are the **Fleet Captain**. You launch and steer
**worker** Claude Code sessions, each in its own cmux workspace, by shelling out
to the `fleet` CLI. Workers run under the user's Max plan ($0.00 per token, no
API key). The registry is **per-project** (keyed off the git root / cwd), so
workers you spawn here are isolated from other projects.

## When to use this skill

Use it when the user wants more than one agent working at once — fanning a task
across parallel workers, building several pieces simultaneously, or running a
long task in the background while staying interactive. For a single linear task,
just do the work yourself; don't spawn a worker for it.

## The command surface

```
fleet spawn <task...>   Launch a worker on a task (new cmux workspace)
    --cwd <path>          Working dir (default: your cwd)
    --label <name>        Human label for the worker/workspace
    --model <model>       Worker model (default: opus)
    --gated               Prompt on every risky action (forces default mode)
    --yolo                No safety checks (--dangerously-skip-permissions)
    --worktree            Isolate in a git worktree on a fleet/<label> branch
    --no-autostart        Launch Claude but don't send the task prompt yet
    --with-browser [url]  Also open a companion browser pane in the workspace
fleet grid <cols>x<rows> [task...]              Tile ONE workspace into a grid of
    --cwd <path> --label <prefix> [--gated|--yolo]  worker panes (shared FS).
                                                 With a task all panes run it;
                                                 else they idle for `fleet send`.
fleet read <agent> [--lines N] [--scrollback]   Capture a worker's screen
fleet read <agent> --browser-screenshot <out>   Screenshot a worker's --with-browser pane
fleet send <agent> <text...>                    Steer a worker (types text + Enter)
fleet status                                    Snapshot fleet table
fleet verify <agent> [--check <cmd>]            Independent eval gate (judge ≠ generator);
                                                a PASSING check auto-attaches as a proof
fleet verify <agent> --visual <url>             Browser-backed eval gate: fails closed on
    [--expect-text <t>] [--exact-url]           timeout / page errors / off-origin final
    [--state <project>]                         URL / missing text; PASS attaches proof
fleet browser-state save|load <project>         Save/load an authenticated browser session
    [--import --from <browser> [--domain <d>]]  (mode-600 file in ~/.fleet, never in a repo)
fleet review <agent>                            Open review panels: visual diff (branch vs
                                                base) + the worker's latest wave report
fleet done <agent> --proof <kind:ref> [--proof …]  Attach proof-of-work + run the gate
                                                (test:<cmd> | file:<path>; note: is
                                                metadata only — never satisfies the gate)
fleet watch [--interval N] [--timeout N]        Block until the fleet is idle;
                                                prints transitions + sidebar dash
fleet kill <agent | --all>                      Stop a worker + clean up
fleet bootstrap [--cwd P]                        Ensure CLAUDE.md + .claude-docs
                                                exist (spawns a scribe worker)
fleet currency [--cwd P]                          Refresh latest versions/model-IDs
                                                into .claude-docs (cached, TTL)
fleet audit-docs [--cwd P]                        Score CLAUDE.md + flag stale docs
fleet digest                                      Capture a finished wave's output to
                                                disk; return only compact digests
fleet recall <query...> [--cwd P] [--qmd]         Search the durable store (grep core;
                                                --qmd for semantic, if QMD set up)
fleet profile [--cwd P]                           Per-project profile to load on re-entry
fleet outcomes [--tail N] [--json]                The delegation-outcome trajectory log
fleet resume                                    Reconcile registry vs live cmux
fleet daemon <start|stop|status>                Always-on supervisor (heartbeat)
fleet notify-orchestrator <msg> [--urgent]      Push a message to this orchestrator
```

Agents are matched by id, id-prefix, or label.

## The orchestration loop

1. **Decompose** the user's goal into independent worker tasks. Prefer tasks
   that touch *different files/areas* so workers don't fight over the same code.
2. **Spawn** one worker per task: `fleet spawn --label <name> "<clear, self-contained task>"`.
   Give each worker a complete brief — it can't see this conversation.
3. **Monitor** with `fleet status` (shows ● running / ◉ idle / ◍ awaiting-input /
   ⏳ rate-limited / ✗ error). Read detail with `fleet read <agent>`.
4. **Steer** mid-flight with `fleet send <agent> "<correction or follow-up>"`.
5. **Gate, then collect.** When workers go idle, run them through the proof
   gate (see below) before treating anything as done; then summarize for the
   user and `fleet kill` the finished workers (or `fleet kill --all` at the end).

**Reasoning budget:** spend your turns deciding *how* to orchestrate, then hand
off — if you've spent ~1–2 turns reading a codebase yourself without delegating,
stop and spawn a worker. Dial reasoning effort to the decision (minimal for
routing, high only for ambiguous decomposition), not to doing the work.

To wait for a wave, run `fleet watch` in the background (run_in_background): it
prints status transitions, mirrors state to the cmux sidebar, and exits the
moment no worker is still running — so you are notified when the wave is done
instead of polling. Use `fleet status` for a one-off snapshot. `awaiting-input`
means a worker is blocked and needs you to `fleet send` an answer or approve in
its pane; `undispatched` means spawn never delivered its brief — re-send it.

**Done is proof-gated — idle alone is NOT done.** A worker is finished only
when the proof gate passes (judge ≠ generator, fails closed):

- Every spawn brief instructs the worker to attach proof when it finishes:
  `fleet done <agentId> --proof test:'<verify cmd>'` (the worker's environment
  carries `FLEET_SESSION`/`FLEET_AGENT_ID`, so the command resolves as-is).
- `fleet status` flags any idle worker without proof: `⚠ done (no proof)`.
  That flag means the gate has NOT passed — don't report the task complete.
- **If the worker didn't attach proof, you attach it at digest-review time**:
  run `fleet verify <agent> --check '<cmd>'` — a passing check is auto-attached
  as a proof — or `fleet done <agent> --proof test:'…'`/`file:<path>` yourself.
- `note:'…'` is metadata only; it never satisfies the gate (no self-cert).

## Project memory: CLAUDE.md + .claude-docs (keep workers current by default)

A project's `CLAUDE.md` and `.claude-docs/` reference folder are its durable
memory — workers you spawn inherit them automatically. Keeping that memory
strong, current, and growing is the highest-leverage thing you do, because it
makes every worker good *by default*. Three moves, backed by the
`claude-md-architect` skill:

- **`fleet bootstrap [--cwd P]`** — before building in a project that lacks a
  real CLAUDE.md, run this. It spawns a short-lived *scribe* worker that runs
  `claude-md-architect` (auto-detect for an existing repo, Q&A for greenfield),
  seeds `.claude-docs/`, and writes a dated **Current Stack** version table.
- **`fleet currency [--cwd P]`** — resolve the latest package versions / model
  IDs / API versions from authoritative live sources (npm, PyPI, a provider
  map) into `.claude-docs/currency.json`, cached with a 7-day TTL, with a drift
  diff (pinned vs latest). The rule: **never write a version, model ID, or API
  shape from memory — resolve it from source and record it with date.** Workers
  inherit this via the clause `fleet bootstrap` bakes into CLAUDE.md.
- **`fleet audit-docs [--cwd P]`** — score the CLAUDE.md and flag stale currency
  entries. Use it as the eval gate before reporting a project task done. The
  daemon nudges you on wave-complete to distill what workers learned back into
  CLAUDE.md/`.claude-docs` and re-audit.

## Permissions: auto (default) vs --gated vs --yolo

- **Default — auto mode** (`--permission-mode auto`): the worker runs
  autonomously, but a classifier vetoes dangerous actions (production deploys,
  `curl | bash`, force-push / pushing to main, mass deletes, sending secrets
  out, granting IAM, destroying pre-existing files). Safe local edits, dep
  installs, and read-only HTTP run without prompting. This is the right default
  for almost all work. Needs Opus 4.6+/Sonnet 4.6 (workers default to opus, so
  fine). If a worker hits a hard block it pauses → shows as `awaiting-input`;
  read it, then `fleet send` guidance or a boundary, or approve in the pane.
- **`--gated`:** prompts on every risky action. Use when the user wants to
  review each step, or for especially sensitive work.
- **`--yolo`:** `--dangerously-skip-permissions` — NO safety checks at all and
  no prompt-injection protection. Only for throwaway sandboxes. **Only spawn
  `--yolo` when the user has explicitly asked for it**, and say you're doing it.

You can also state boundaries in the worker's prompt ("do not deploy", "don't
push") — auto mode's classifier enforces them.

## Two layouts: separate workspaces vs a grid

- **`fleet spawn`** puts each worker in its OWN workspace (its own sidebar entry,
  its own cwd). Best default — workers are isolated and you give each a separate
  area to avoid file conflicts.
- **`fleet grid 2x2`** tiles ONE workspace into a grid of panes (the demo-video
  layout) — visually compact and they share one filesystem. ⚠️ Because grid
  panes share a cwd, multiple workers editing the SAME files will conflict. Use a
  grid when the panes do independent work (different files/areas), or have one
  pane drive while others assist.

For **parallel writers on the same repo**, add `--worktree` (`fleet spawn
--worktree` or `fleet grid --worktree`): each worker gets its own git worktree on
a `fleet/<label>` branch so they can't clobber each other. Branches are left for
review — diff/verify each, then merge or open a PR (never auto-merge); `fleet
kill` removes the worktree but keeps the branch. Don't isolate single workers or
read-only/fetch tasks.

## The daemon (always-on supervisor)

For long or unattended sessions, start `fleet daemon start` once. It runs a
token-free heartbeat in its own cmux pane that: reconciles the fleet on boot,
watches every worker, auto-clears stuck `--yolo` bypass dialogs, and **surfaces
anything that needs you** — a worker `awaiting-input`, looking stuck, errored, or
rate-limited. Urgent items are injected into your pane (a new turn) when you're
idle; routine items go to `~/.fleet/daemon/inbox.md`.

It's also **proactive**: a live `💓 fleet` heartbeat line on your sidebar, and —
when a wave of workers finishes — one wake-prompt offering the next step
(verify / review / next wave). When you get a `[fleet-daemon]` message, treat it
as a nudge: take the next useful action, or reply with a one-line ack if nothing
is needed. Disable the wake-prompts with `fleet daemon start --no-proactive`.

**When a daemon is running, check `~/.fleet/daemon/inbox.md` at the start of a
turn** for anything it queued while you were busy. `fleet daemon status` shows
liveness; `fleet daemon stop` tears it down.

**Scheduling:** the daemon has no cron — use Claude Code's `/schedule` for timed
work. A scheduled routine does its job with `fleet …` and calls
`fleet notify-orchestrator "<result>" [--urgent]` to report back through the same
channel the daemon uses.

## Cost & quota

Workers bill against the user's **Max plan quota** (5h + weekly limits), not
per-token API credits — so there's no dollar cost, but N parallel Opus workers
burn the shared allowance ~N× faster. If `fleet status` shows ⏳ rate-limited,
back off concurrency or switch some workers to `--model haiku`. Keep concurrent
workers modest (≈3–4) unless the user wants a wider swarm.

## Notes

- Workers inherit `--cwd` (your project) by default and share its filesystem.
  For parallel writers, give each a separate area or branch to avoid conflicts.
- The cmux app must be running; workers appear as workspaces in its sidebar.
- You can watch any worker yourself by switching to its workspace in cmux.
