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

**One capable worker often beats a multi-agent split.** Every worker is Opus 4.8
— a high enough ceiling that one worker with a complete brief usually finishes
what used to need several. Fan out for *genuine parallelism* (independent files,
areas, candidates), not to compensate for a thin per-worker brief. Splitting a
task that one worker could do in one pass just multiplies coordination cost.

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
fleet objective <goal...> --done <check>        Loop a worker until a stop
    [--verify <check>] [--cwd P]                CONDITION (shell check) passes,
    [--max N] [--model M]                       feeding each failure back in
                                                (--verify → via the eval gate)
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
    [--import --from <browser> [--domain <d>]]  (mode-600 file in ~/.fleet, never in a repo;
    --url <page>                                save REQUIRES --url, a reachable http(s) page)
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
fleet resume [--apply]                          Reconcile registry vs live cmux; after a
                                                cmux restart, prints each restorable
                                                worker's claude --resume (--apply respawns)
fleet log <message...> [--level <l>] [--source <s>]  Drop a Captain milestone into cmux's
                                                sidebar activity log (breadcrumbs next to
                                                the fleet group's state lamps)
fleet setup --dock                              Pin fleet watch + the cmux Feed TUI into
                                                the project's Dock (.cmux/dock.json)
fleet daemon <start|stop|status>                Always-on supervisor (heartbeat)
fleet notify-orchestrator <msg> [--urgent]      Push a message to this orchestrator
fleet prompts [agent]                           List pending Feed prompts (permission/
                                                question/plan) + the 120s reply window
fleet reply <agent> <answer> [--prompt <id>]    Answer a pending prompt via RPC, no TUI
                                                keystrokes (permission: allow|deny|…;
                                                question: option # / label, other text
                                                sent verbatim as the one selection;
                                                plan: approve|reject); past 120s → fleet send
```

Workers are visible in cmux's own chrome: spawn groups their workspaces under a
"fleet: <session>" sidebar group, and the daemon syncs each workspace's color +
description to its state (green running · grey idle+proof✓ · amber blocked/no-proof ·
red error/no-brief · blue rate-limited) — glance at the sidebar before `fleet status`.

Agents are matched by id, id-prefix, or label.

## The orchestration loop

1. **Decompose** the user's goal into independent worker tasks. Prefer tasks
   that touch *different files/areas* so workers don't fight over the same code.
2. **Spawn** one worker per task: `fleet spawn --label <name> "<clear, self-contained task>"`.
   Brief each worker FULLY and ONCE — a complete first spec (goal, success
   criteria, constraints, exact files, what "done" looks like). 4.8 rewards a
   complete first turn and works best running on it; dribbling context across
   `fleet send` corrections costs tokens and quality. It can't see this
   conversation, so leave nothing implicit.
3. **Monitor** with `fleet status` (shows ● running / ◉ idle / ◍ awaiting-input /
   ⏳ rate-limited / ✗ error). Read detail with `fleet read <agent>`.
4. **Steer** mid-flight with `fleet send <agent> "<correction or follow-up>"` —
   for *new* information or a redirect, not to fill gaps a complete brief should
   have covered.
5. **Gate, then collect.** When workers go idle, run them through the proof
   gate (see below) before treating anything as done; then summarize for the
   user and `fleet kill` the finished workers (or `fleet kill --all` at the end).

**Tier workers by EFFORT, not by model.** Every worker is Opus 4.8, so `effort`
(+ Task Budgets) is your stratification lever, not model choice. Set it to the
worker's role:
- **`low`** — mechanical leaf work + scribe **scaffolding**: file reads, greps,
  classification, fan-out leaves, seeding `.claude-docs/`, formatting. The docs
  name subagents as a `low` use case; pair `low` with an explicit checklist if
  the task has sections.
- **`high`** — **distill / verify / memory** work, by default: it's
  quality-sensitive (verification coverage + generalizing durable rules — the
  reason memory work once ran on premium Fable), so don't starve it at `low`.
  Drop toward `low` only if `fleet audit-docs` coverage holds there (the old
  CL-Bench ~73% number was Fable-specific, not a transferable baseline).
- **`medium`** — moderate tasks above leaf work but short of full execution
  (a contained edit, a focused review). When calibrating a role, sweep
  `medium`/`high`/`xhigh` on a real eval — the cost curve isn't monotonic.
- **`xhigh`** — execution: coding, builds, long-horizon agentic work.
- **`high`/`xhigh`** — the Captain itself (planning + delegation is
  intelligence-sensitive and long-horizon).
- Reserve **`max`** for a single genuinely-frontier sub-task you've measured.
- Set `max_tokens ≥ 64K` on any `xhigh`/`max` worker so it doesn't truncate
  mid-thought, and give long agentic loops a **Task Budget** (`task_budget`, min
  20K) so the worker sees a countdown and wraps up gracefully instead of hitting
  a silent ceiling.

**Reasoning budget (your own turns):** spend them deciding *how* to orchestrate,
then hand off — if you've spent ~1–2 turns reading a codebase yourself without
delegating, stop and spawn a worker. Dial your effort to the decision (low for
routing, high only for ambiguous decomposition), not to doing the work.

**Force the capabilities 4.8 under-reaches for** — it favors reasoning over tool
calls and won't fan out, search, or use file-memory unless told. In each brief,
add the explicit trigger the worker needs:
- *Subagents:* "Don't spawn a subagent for work you can finish in one response;
  spawn several in the same turn only to fan out across independent items."
- *Parallel tool calls:* "If you intend to call multiple tools with no
  dependencies between them, make all the calls in parallel."
- *Search:* "For anything where current info would change the answer (versions,
  recent events, prices), search before answering rather than from memory."
- *File memory:* "Check `.claude-docs/` / your memory file before starting; write
  new findings back as you go; checkpoint with git."

**Worker briefs run silent and self-moderate.** 4.8 narrates and asks more than
prior models, which floods your transcript and stalls workers on the Captain. Put
these in every brief:
- *Silence default:* "Default to silence between tool calls. Write text only when
  you find something, change direction, or hit a blocker — one sentence each.
  Don't narrate routine actions. When done: one or two sentences on the outcome."
- *Minor decisions — pick and note, don't ask:* "For minor choices (naming,
  formatting, defaults, equivalent approaches) pick a reasonable option and note
  it; don't ask. For scope changes or destructive actions, still ask first."

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
- **A PASSING `fleet done` is also a deterministic signal**: it stamps the
  registry (status/watch/daemon treat the worker as authoritatively finished
  the moment its screen settles — no more inferring from an ambiguous prompt)
  and emits the cmux signal `done-<agentId>`. A script can block on a specific
  worker's verified completion with `cmux wait-for done-<agentId> --timeout 300`
  (the signal is sticky — it survives until one waiter consumes it). Sticky
  cuts both ways: an unconsumed `done-<agentId>` from a PREVIOUS turn satisfies
  a later `wait-for` instantly, so drain it (`cmux wait-for done-<agentId>
  --timeout 1`) before re-dispatching the same worker — or scope this waiting
  pattern to single-turn workers. Note the signal fires only on an explicit
  `fleet done`: digest's passive proof gate records `complete` but never
  signals, so an external waiter is woken by `fleet done` alone. Workers
  that never call `fleet done` still resolve via the screen/notification
  inference, as always.

## Objective loops — route checkable conditions here, not spawn-and-watch

`fleet spawn` is for **tasks** ("add the endpoint", "refactor X"); `fleet
objective` is for **conditions** — a goal whose success is a checkable shell
predicate ("tests green", "lint clean", "endpoint returns 200", "build passes").
When the goal IS a condition, route to the loop FIRST instead of spawn-and-watch:
it spawns a worker, waits for its turn, runs the check, and on failure
re-dispatches a fresh worker with the failing output fed back in — until the
check exits 0 or the attempt cap is hit. That's the stop-condition pattern
(judge ≠ generator: the check grades, the worker generates) instead of you
eyeballing `fleet status`.

```
fleet objective "<goal...>" --done '<shell check>'   loop until the check exits 0
    --verify '<check>'   run the check through the eval gate (fleet verify) in the
                         worker's cwd/worktree instead of an inline shell check
    --cwd <path>         where the check runs (default: your cwd)
    --max <N>            attempt cap (default 3) — MANDATORY guard, see below
    --model <model>      worker model (default opus)
```

Examples:
```
fleet objective "make the unit tests pass" --done 'npm test'
fleet objective "fix every eslint error in src/" --done 'npm run lint'
fleet objective "get /health returning 200" --done 'curl -fsS localhost:3000/health'
```

The warnings the community paid for, baked in:
- **An impossible check is pure token burn.** The loop can't tell "not done yet"
  from "can never be done" — it just keeps spawning Opus workers. The `--max` cap
  is the only backstop: never raise it casually, and never point the loop at a
  check that can't actually go green.
- **Never loop a trivial task.** The spawn→wait→check harness costs more than the
  task itself; for a one-line fix just do it (or a single `fleet spawn`). Reach
  for a loop only when iteration is the point.
- **Keep the check fast and its output terse.** Each failure is re-fed into the
  next attempt's brief, so a slow check stalls every iteration and a noisy one
  poisons the worker's context — a focused `npm test -- <file>` beats the whole
  suite.

The spawn-side sibling is `fleet spawn --done '<check>' [--max N]`: it attaches
the same stop condition to a worker you're already spawning, but stays
fire-and-forget — the daemon runs the check on the worker's idle and
re-dispatches the **same** worker (continued context) on failure, where
`fleet objective` blocks and re-spawns a **fresh** worker each attempt. Reach for
`--done` when you want one worker to keep its context across retries; reach for
`objective` when a clean-slate attempt each iteration is better (or you want the
call to block until done). Same fast/terse-check and `--max` discipline applies.

## Browser self-verify for UI tasks (paste into worker briefs)

Workers are plain Claude Code sessions with bash, and cmux auto-sets
`CMUX_WORKSPACE_ID` in their terminals — so a worker's `cmux browser open`
creates a browser split in its OWN workspace (isolation by default). Any worker
doing UI work can self-verify it today, no MCP required. Include this recipe in
every UI-task brief:

> Before you report done, self-verify in cmux's browser rail:
> 1. `cmux browser open <url>` — one browser surface for THIS task only; never
>    reuse another task's surface.
> 2. `cmux browser wait --load-state complete --timeout-ms 15000`
> 3. `cmux browser snapshot --interactive` — read the page. Element refs
>    (e1, e2…) go STALE after ANY DOM change: re-snapshot after every
>    click/fill/navigation (or pass `--snapshot-after` on the action).
> 4. Interact as needed: `cmux browser click|fill|type <ref> … --snapshot-after`.
> 5. `cmux browser screenshot --out /tmp/<task>-verify.png`
> 6. `cmux browser console list` and `cmux browser errors list` — confirm no
>    new errors; explain any that appear.
> 7. Put the screenshot PATH in your final report and attach it as proof:
>    `fleet done $FLEET_AGENT_ID --proof file:/tmp/<task>-verify.png`.
> If `snapshot` fails with `js_error` (some pages break rich snapshots), fall
> back down the chain: `cmux browser get url` → `cmux browser get text body`,
> and verify from text + screenshot.

Hard limits of this rail (WKWebView): **no network mocking/interception, no
responsive-viewport emulation, no offline mode, no trace/screencast** — they
error `not_supported` even though help lists them. If the task needs those,
route verification to a Chrome/Playwright MCP browser instead; don't promise
them in a brief.

## Project memory: CLAUDE.md + .claude-docs (keep workers current by default)

A project's `CLAUDE.md` and `.claude-docs/` reference folder are its durable
memory — workers you spawn inherit them automatically. Keeping that memory
strong, current, and growing is the highest-leverage thing you do, because it
makes every worker good *by default*. Three moves, backed by the
`claude-md-architect` skill:

- **`fleet bootstrap [--cwd P]`** — before building in a project that lacks a
  real CLAUDE.md, run this. It spawns a short-lived *scribe* worker that runs
  `claude-md-architect` (auto-detect for an existing repo, Q&A for greenfield),
  seeds `.claude-docs/`, and writes a dated **Current Stack** version table. Its
  scaffolding is `low`-effort work, but its **audit/distill pass is `high`** —
  that pass is the quality-sensitive part (don't starve it).
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

**Answering a worker's PERMISSION prompt (`fleet reply`, or typing into its
pane) carries the user's authority — treat it as a verification step, not a
formality:**

- **Already in scope** — the user's request, the brief you wrote, or a
  pre-agreed approval envelope covers the exact action → `allow`, keep moving.
- **Destructive or critical** (deletes, force-push, deploys, schema/data
  migrations, sending data out) → neither rubber-stamp nor stall: **verify it
  first**. `fleet read` the worker for context; confirm the exact target
  (path, branch, env, origin) is the one the task calls for and the action is
  the correct next step toward the goal. Verified correct and in scope →
  `allow`; wrong target, out of scope, or unverifiable → `deny` plus a
  steering `fleet send`, or surface it to the user (inconclusive = deny).
- **NEVER `always`, `all`, or `bypass`** — standing grants that outlive the
  prompt — unless the user explicitly granted them.
- **Unattended waves:** agree the approval envelope with the user UP FRONT
  ("overnight I may approve dep installs and test-DB resets; all else queues
  to the inbox") so in-scope approvals stay autonomous instead of stalling.

Past the 120s window the prompt falls back to the worker's TUI — answer it
with `fleet send`, same rules.

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
burn the shared allowance ~N× faster. The primary lever to slow that burn is
**effort**: run scribe/distill/memory/leaf workers at `low` and reserve
`xhigh` for execution — high effort up front often *cuts* total turns, so it
isn't simply "more expensive." Give long agentic workers a **Task Budget** so
they self-moderate against a countdown. If `fleet status` shows ⏳ rate-limited,
back off concurrency or drop some workers to `--model haiku`. Keep concurrent
workers modest (≈3–4) unless the user wants a wider swarm.

## Notes

- Workers inherit `--cwd` (your project) by default and share its filesystem.
  For parallel writers, give each a separate area or branch to avoid conflicts.
- The cmux app must be running; workers appear as workspaces in its sidebar.
- You can watch any worker yourself by switching to its workspace in cmux.
