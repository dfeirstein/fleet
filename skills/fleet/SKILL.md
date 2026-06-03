---
name: fleet
description: Orchestrate multiple Claude Code worker agents in parallel using the `fleet` CLI on top of cmux. Use when the user asks to "spawn agents", "run agents in parallel", "fan out", "orchestrate", "use a team of agents", "split into a grid of agents", "have N agents build X", or otherwise wants the current Claude session to act as an orchestrator that launches and steers other Claude Code workers. Workers run under the user's Max plan (no API key). Works from any project directory; each project gets its own isolated fleet.
---

# fleet — multi-agent orchestrator on cmux

You (this Claude Code session) are the **orchestrator**. You launch and steer
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
    --yolo                Ungated worker (--dangerously-skip-permissions)
    --no-autostart        Launch Claude but don't send the task prompt yet
fleet read <agent> [--lines N] [--scrollback]   Capture a worker's screen
fleet send <agent> <text...>                    Steer a worker (types text + Enter)
fleet status                                    Live fleet dashboard
fleet kill <agent | --all>                      Stop a worker + clean up
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
5. **Collect** results when workers go idle, summarize for the user, then
   `fleet kill` the finished workers (or `fleet kill --all` at the end).

Between waves, poll `fleet status` rather than blocking. A worker is done when
its status reads `idle` and `fleet read` shows the final answer at the prompt.

## Permissions: gated vs --yolo

- **Default (gated):** workers prompt for approval on writes/bash. Safe, but
  each worker pauses until approved — you or the user must `fleet send` "yes" or
  approve in the pane. Good while building trust.
- **`--yolo`:** adds `--dangerously-skip-permissions` — the worker acts
  autonomously with no approval gate. **Only spawn `--yolo` when the user has
  clearly asked for autonomous/unattended workers.** State that you're doing it.

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
