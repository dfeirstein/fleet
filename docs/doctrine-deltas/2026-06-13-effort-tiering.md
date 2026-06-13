# Doctrine-delta proposal — 2026-06-13 · Tier worker compute by EFFORT, not model

> Fill-in of a `fleet reflect` scaffold. This changes NO doctrine. Adopt only via
> PR review (judge ≠ generator). See ./README.md.

## Signal (the triggering event, not the outcome log)
Anthropic **turned Fable 5 off** (2026-06-13). The doctrine + `bootstrap.ts`
`SCRIBE_MODEL` encoded a **two-tier model split** — a smarter scribe/distill/memory
tier (Fable 5) over an Opus execution tier (memory `feedback-fleet-scribe-model`,
CL-Bench rationale). With Fable gone that split is impossible: every worker and the
Captain now run one model, Opus 4.8. The orphaned `SCRIBE_MODEL="fable"` default was
already spawning scribes on a dead model (Fable isn't even in `versions.md`).
Sourced research: `~/.claude/research/opus-4-8-mastery-2026-06-13.md`,
`~/.claude/research/skill-model-audit-2026-06-13.md`.

## Problem
The doctrine's only worker-tiering lever was **model choice**. That lever no longer
exists — picking a model can't trade cost for quality anymore. Without a replacement,
the Captain either over-spends (every leaf/scribe/memory worker runs at full effort)
or under-thinks execution work, and the "scribe runs on a smarter model" rule is dead
text that misroutes.

## The one delta
Replace "tier workers by **model**" with "tier workers by **`effort`**" wherever the
doctrine/skill speaks of worker model selection:
- scribe / distill / memory / leaf workers → **`effort: low`**
- ordinary execution → **`effort: xhigh`** (the 4.8 coding/agentic sweet spot)
- Captain → **`high`/`xhigh`**
- use **Task Budgets** (beta `task-budgets-2026-03-13`, min 20K) for self-moderating spend.
Concretely: `bootstrap.ts` `SCRIBE_MODEL "fable"→"opus"` (done, branch
`fleet/fable-to-opus`); update `orchestrator-doctrine.md` / the `fleet` skill's
model-tier language to effort-tier language; default scribe/distill/memory spawns to
low effort rather than a special model.

> Related, lower-priority briefing-discipline items from the same research (track
> separately, NOT bundled into this delta — keep one narrow change per commit): 4.8
> rewards a **full spec in one brief** (multi-turn dribble hurts it); it **under-reaches
> for tools** (add explicit "when to use" triggers in spawn briefs + tool descriptions);
> it **narrates/asks more than 4.7** (drop "summarize every N tool calls" scaffolding;
> add a silence default + "minor decisions: pick and note, don't ask"). See
> `reference-opus-4-8-harness` memory.

## Scope check — project-agnostic?
**Yes.** This is about how a Captain allocates compute across workers, not an AO-Atelier
/ Jeevz / Certifyd fact. The Fable-off event and effort levels are platform-wide. The
one project-specific residue (the `SCRIBE_MODEL` const) lives in this repo's code and is
already handled by the migration branch.

## Evaluation
- Test objectives: any wave that spawns scribe + execution workers together (e.g.
  `fleet bootstrap` then a build wave). Expect **tokens-per-objective to drop** (leaf/
  scribe work at low effort) with **no regression in `fleet audit-docs` verification
  coverage** or execution wave-success rate.
- Guardrail: re-validate scribe/distill quality on Opus 4.8 at low effort before trusting
  it — the CL-Bench 73% coverage number was Fable-specific and does not transfer.
- Smoke set: `npm run typecheck` + `npm test` green on the migration branch (gate).

## Decision
**Adopt via PR.** Mechanical code change verified on `fleet/fable-to-opus`; the
doctrine/skill wording change is the reviewable delta.
