# Doctrine deltas — the self-evolution gate

The Captain may improve its own **project-agnostic** doctrine over time, but
**only through additive, gated, reversible proposals — never autonomous in-place
rewriting** of `skills/fleet/orchestrator-doctrine.md` (free-form self-rewrite is
the verified anti-pattern: it destabilizes and accumulates error).

## How it works

1. `fleet reflect` reads the delegation-outcome log and scaffolds a **proposal
   file** in this folder, seeded with the failure/pattern signal. It changes no
   doctrine.
2. A human (or the Captain in a reviewed turn) fills the proposal: the problem,
   the **one** narrow delta, a scope check, and how it'd be evaluated.
3. The delta is adopted **only via PR review** — an independent reviewer (judge ≠
   generator) confirms it helps against held-out past objectives and doesn't
   regress. Every adopted delta is a discrete commit, so any regression is a
   one-line revert.

## Hard rules

- **Project-agnostic only.** Doctrine/skill/CLI patterns may evolve; project
  facts never enter doctrine (they go to per-project `CLAUDE.md` / `.claude-docs`).
- **One narrow delta per proposal.** Edit one surface, score one metric.
- **Never auto-apply.** Proposals are inert files until a human merges the PR.

## Deferred (deliberately, for safety)

The fully-autonomous loop — a standing staged gate that scores deltas against a
held-out objective suite and a separate always-on **Auditor** session — is **not
built**. It needs (a) an agreed fleet metric, (b) a re-runnable held-out suite,
and (c) window telemetry, none of which exist yet. Until then, self-evolution is
**human-in-the-loop**: `fleet reflect` proposes, a person disposes.
