# Verification — how to check work in this repo

There is **no test runner** in this project. Verification is typecheck + running
the CLI + the project's own eval-gate commands. Don't claim done without one of
these.

## The one automated gate: typecheck

```bash
npm run typecheck        # tsc --noEmit — must be green before every commit
```

If you add or change types, run this. It is the bar for CI-equivalence here.

## Run the CLI directly (no build)

```bash
./bin/fleet help         # surface of every command
./bin/fleet doctor       # diagnose the install (cmux reachable? PATH? skill? daemon?)
./bin/fleet status       # snapshot the current session's fleet
```

`fleet doctor` is the fastest smoke test that the binary, cmux wiring, and skill
install are intact. Most state-changing commands (`spawn`, `grid`, `kill`) require
a running cmux app, so verify those by actually launching a worker and reading its
screen back — not by unit test.

## The project's own eval gates (judge ≠ generator)

Fleet ships verification *as features*. Use them — and note they **fail closed**
(an inconclusive result is a FAIL, never a silent pass):

- `fleet verify <agent> [--check <cmd>]` — independent eval gate on a worker's
  artifact. Exits non-zero on fail.
- `fleet audit-docs [--cwd P] [--min N]` — scores `CLAUDE.md` and flags any
  currency fact past its 7-day TTL. Exits non-zero on fail. Run this after editing
  project memory.
- `fleet currency [--cwd P]` — refreshes `.claude-docs/versions.md` +
  `currency.json` from the npm/PyPI registries; prints a drift diff. See
  [project-memory.md](project-memory.md).

## Before submitting

1. `npm run typecheck` passes.
2. Relative imports end in `.js`; type-only imports use `import type`
   (see [typescript-esm.md](typescript-esm.md)).
3. New cmux access went through `src/cmux.ts`, not a fresh `execFileSync`.
4. If you touched project memory, `fleet audit-docs` passes and `fleet currency`
   shows no unexpected drift.
5. No new `tsc` warnings.

## Eval-gate philosophy (why there's no "just trust it")

A generator must never grade its own work — it's biased and passes itself. So a
worker's "done" is gated by a *separate* verifier (an adversarial skeptic, a
rubric, or these commands), and a fix is re-checked by the **reviewer, not the
fixer**. This is the doctrine the whole orchestrator is built on; the verification
commands above are its concrete teeth. See `skills/fleet/orchestrator-doctrine.md`.
