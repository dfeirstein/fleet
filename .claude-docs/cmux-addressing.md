# cmux addressing & TUI submission — the hard-won rules

All of this lives in `src/cmux.ts`. These are the gotchas that cost the most time;
violating them produces silent failures ("Surface is not a terminal", prompts that
pile up unsubmitted, reads of the wrong pane). Touch this file with care.

## Address workers by `--workspace <uuid> --surface <uuid>` TOGETHER

A worker's `Target` is `{ workspace, surface }`. **Always pass both**, and prefer
**UUIDs** over `workspace:N` / `surface:N` refs.

- `--workspace` **alone** resolves to the focused pane's *selected* surface. The
  moment a workspace also holds a browser surface, that selected surface may be
  the browser → `"Surface is not a terminal"`.
- `--surface` **alone** is unreliable in this cmux build.
- `workspace:N` / `surface:N` refs **renumber** as workspaces churn → use the
  UUIDs (`--id-format both` returns both; the registry stores UUIDs).

`addr(t)` in `cmux.ts` is the single helper that builds the `--workspace … [--surface …]`
argument pair. Route every read/send/close through it.

## Submitting a prompt into a Claude Code TUI is a race

cmux `send` arrives as a **bracketed paste**. An `Enter` sent too soon lands
*inside* the paste (becomes a newline in the input box) instead of submitting, so
messages silently pile up in the input. `submitToClaude()` handles this:

1. Type the text.
2. Sleep ~450ms to let the bracketed paste settle.
3. Press Enter.
4. **Verify** the input actually cleared: read the bottom of the screen; if a
   distinctive chunk of the message is still sitting there, the prompt wasn't
   submitted — press Enter again (up to 6 tries).

Checking that the input *cleared* is the only reliable success signal. Don't
"simplify" this to a single type-then-Enter — it will flake.

## Long prompts: write to a file, hand a short pointer task

A long, multi-paragraph prompt hits **paste-collapse** and stalls unsubmitted.
The doctrine's rule (and what `fleet bootstrap` does): write the full brief to a
markdown file (e.g. `~/.fleet/briefs/<name>.md` or a file in the worker's project)
and give the worker a SHORT task: *"Read &lt;path&gt; and execute it exactly."*

## The PTY boots lazily

`new-workspace` returns **before** the background workspace's terminal is live.
Always `waitForTerminal()` (polls `read-screen` until non-empty) before sending
anything. The PTY can report "live" a beat before the shell prompt or launched
command has rendered — hence the non-empty-content check, not just a "no error"
check. The same applies to a **split pane** (`new-split`): its PTY also boots
lazily, so `spawn` splits with `--focus true` (bringing the new pane up) and
`waitForTerminal()` on the new surface before launching anything in it.

## Same-project workers group into one workspace (split panes, cap 4)

`spawn` keeps workers for the **same project** (git repo root of `--cwd`, else the
dir itself) in **one** cmux workspace, added as split panes, up to
`MAX_PANES_PER_WORKSPACE` (4) live panes; the next worker for that project spills
into a fresh workspace. Split direction alternates right-then-down like `grid.ts`.
Grouped workers register with `ownsWorkspace: false` against the **shared**
`workspaceId` and their **own** new `surfaceId` — so `kill` closes just that pane
while siblings survive, and closes the whole workspace only for the last one.
`--standalone` forces a fresh workspace and skips grouping. A `new-split` pane is
a **bare shell** (no `--command`), so the launch line is typed in (with a `cd`
into the worker's cwd) rather than passed to cmux.

## Launch programs via `--command`, don't type them in

`newWorkspace({ command })` lets cmux boot the PTY and run the program itself.
This is far more reliable than opening a bare shell and typing a command into a
not-yet-ready terminal.

## Execution is synchronous, one cmux call at a time

The codebase runs synchronously — `sleepMs()` blocks via the `sleep` syscall
(`execFileSync("sleep", …)`) rather than async timers, because we issue one cmux
call at a time. Keep this model when extending `cmux.ts`.
