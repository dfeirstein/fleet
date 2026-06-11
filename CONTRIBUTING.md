# Contributing to fleet

Fleet is a multi-agent orchestrator on top of [cmux](https://github.com/manaflow-ai/cmux).
This file is the contributor process — and this file went through that process itself
(a PR, opened for review, merged once a maintainer looked it over).

## Dev setup

```bash
git clone https://github.com/dfeirstein/fleet.git
cd fleet
npm ci                 # install devDeps only — fleet has ZERO runtime deps
npm run typecheck      # tsc --noEmit — the one automated gate, keep it green
npm test               # node --import tsx --test — pure-logic modules only
./bin/fleet doctor     # smoke test: install / cmux reachable / PATH / skill
```

There is **no build step.** TypeScript runs directly via `tsx` (pure ESM,
`"type": "module"`). Don't add a bundler, a `dist/`, or a `build` script — if you
think you need one, open an issue first. Node 20+ (CI runs Node 24).

The only test runner is `node:test`, and it covers the pure-logic modules
(`frameToSignal`, `gateProof`, the outcomes/verification classifiers). Everything
else verifies by typecheck + the CLI + live E2E against a running cmux. See
`.claude-docs/verification.md`.

## House rules (read once)

- **Relative imports end in `.js`**; type-only imports use `import type`
  (ESM + `verbatimModuleSyntax`).
- **All cmux access funnels through `src/cmux.ts`** — never a fresh `execFileSync`.
  It's the seam where every addressing/TUI-submit gotcha is solved once.
- `noUncheckedIndexedAccess` is on — array/record indexing is `T | undefined`.
- **Never write a version, model ID, or API shape from memory.** Resolve it live
  (`fleet currency`) and record provenance. See the Currency section of `CLAUDE.md`.
- Read `CLAUDE.md` and the `.claude-docs/` it indexes before a non-trivial change —
  the hard-won gotchas live there.

## Pull requests

This is distilled from how PR #31 was actually handled — it's the bar.

- **Surgical scope.** Every changed line traces to the issue. Don't "improve"
  adjacent code, don't bundle an unrelated fix, don't add speculative features.
  A reviewer should be able to map the whole diff back to one stated goal.
- **CHANGELOG entry under Unreleased.** Every PR adds one terse bullet under
  `## Unreleased` in `CHANGELOG.md` (the PR number is filled in at merge). See
  the file's header for the Unreleased → date-heading convention.
- **Verification evidence in the PR body — commands + results, not claims.** Paste
  the actual `npm run typecheck` / `npm test` output (e.g. `251/251 pass`), and for
  behavior changes, the before/after you observed. "Tests pass" without the run is
  not evidence.
- **Open for review = don't merge.** Open the PR for a maintainer to look over;
  don't self-merge. The judge is not the generator — the person who wrote the change
  doesn't clear it. Wait for a maintainer review.
- **Re-request review after addressing changes.** When you push fixes for review
  comments, re-request review rather than assuming the reviewer will notice — and
  reply to each thread so the reviewer can see what moved.
- **Keep the branch off `main`.** Work on a topic branch; never commit to `main`.

## Issues

The operational-review format of #30 is the gold standard. A good report:

- **Orders findings by operational risk** (critical → major → minor), not by where
  you happened to find them.
- **Names the root cause**, not just the symptom — and says how you verified it.
- **Cites `file:line`** for every claim a maintainer would otherwise have to hunt for.
- **Sketches the fix shape** — enough that a maintainer can judge scope and blast
  radius without re-deriving it.

For a single concrete defect, the bug report template is enough. For a sweep across
the orchestrator's behavior, use the operational-review template.

### Security issues

**Do not open a public issue for a security problem.** Email the maintainer privately
(Doug — see the commit history / GitHub profile for contact) so a fix can land before
the details are public.

## Before you open the PR

1. `npm run typecheck` passes.
2. `npm test` passes (count the suite — a merge should equal the sum of both sides).
3. Your CHANGELOG bullet is under **Unreleased**.
4. Relative imports end in `.js`; any new cmux call goes through `src/cmux.ts`.
5. If you touched project memory, `fleet audit-docs` passes and `fleet currency`
   shows no unexpected drift.
