# hot-zone-guard — a `PreToolUse` hard block for catastrophic actions

> **A request is not a rule.** An instruction in `CLAUDE.md` or the orchestrator
> doctrine is a *request an agent can ignore* — a confused, drifted, or
> prompt-injected agent reads right past it. Only a `PreToolUse` hook that
> programmatically **blocks** the tool call is an actual *rule*. This is the
> defense-in-depth layer under the doctrine's soft "route hot zones to the human":
> the soft route catches the cooperative case; this hook catches the failure case.
>
> See the doctrine section **"Some 'done' a green test can't certify — hot zones &
> taste"** in `skills/fleet/orchestrator-doctrine.md` (the *"A request is not a
> rule"* paragraph).

## What it blocks (the NEVER-without-a-hard-block tier only)

Conservative by design — it matches only **unambiguous** catastrophic patterns:

| Pattern | Why |
| --- | --- |
| `git push --force` / `-f` / `--force-with-lease` to **main** (`origin main`, `:main`, `HEAD:main`) | irreversible history rewrite on the shared branch |
| `rm -rf` (any flag order) of **`~` / `$HOME` / `/`** | catastrophic, irreversible data loss |
| SQL **`DROP DATABASE`**, **`DROP TABLE`**, **`TRUNCATE`** | irreversible data destruction |
| `git reset --hard origin/<branch>` | discards local commits irreversibly |
| writes to obvious **secret files** — `.env` (+ `.env.local`/`.env.production`, but **not** `.env.example`/`.sample`/`.template`), `*.pem`, `id_rsa`, `*credentials*` (via `Write`/`Edit` or a shell redirect `> .env`) | leak / clobber credentials |

Everything else is **allowed**. `git push origin feature`, `git push --force` to a
non-main branch, `rm -rf ./build`, `rm -rf node_modules`, `rm -rf ~/project/dist`,
a normal `SELECT`/`UPDATE`, `git reset --hard HEAD~1`, and writing `.env.example`
all sail through. A false-positive that blocks normal dev is worse than a missed
edge — so each rule is narrow and pattern-anchored. **This is a STARTER you tune,
not a complete policy.**

## It is OPT-IN — install it deliberately

This hook is **not** auto-wired into your settings. Modifying the global
`~/.claude/settings.json` is itself a config hot zone (it affects *every* session),
so installation is a deliberate, manual act:

1. Open `settings.snippet.json` in this directory.
2. Copy its `hooks` block into a `settings.json` **you control** — prefer a
   **project** `.claude/settings.json` (scoped to one repo). Use `~/.claude/settings.json`
   only if you accept it firing on every session everywhere.
3. Replace `ABSOLUTE_PATH_TO_REPO` with this checkout's real path.
4. If you already have a `PreToolUse` array, merge — append this matcher object,
   don't overwrite.

The hook command is `npx tsx <repo>/hooks/hot-zone-guard/guard.ts` — it reads the
`PreToolUse` payload from stdin and, on a catastrophic match, emits a `deny`
decision (`hookSpecificOutput.permissionDecision: "deny"`) so Claude Code refuses
the call. A clean call produces no output (allow). It **fails open** on unparseable
input (exit 0) so a bad payload can never wedge a session — this is a convenience
guard layered *under* the human, not fleet's authoritative fail-closed gate.

## Extend the patterns

All matching lives in one pure function — `evaluate()` in `matcher.ts` (payload in,
`{ block: boolean; reason? }` out). To add a rule: write a narrow predicate
(anchor it so it can't fire on normal dev), wire it into `scanCommand()` (shell) or
the `Write`/`Edit` branch (files), and **add both a BLOCK and an ALLOW test** to
`matcher.test.ts` proving it catches the bad case AND leaves the adjacent good case
alone. Keep new rules conservative; prefer a missed edge over a false block.

## Test it

```bash
# from the repo root — pure-core matcher tests (31 cases: BLOCK + ALLOW)
node --import tsx --test hooks/hot-zone-guard/matcher.test.ts

# end-to-end via the CLI (should print a deny JSON + a stderr block reason)
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | npx tsx hooks/hot-zone-guard/guard.ts

# a normal command prints nothing (allow)
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin feature"}}' \
  | npx tsx hooks/hot-zone-guard/guard.ts
```
