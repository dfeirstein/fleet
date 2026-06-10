# Continual Learning Bench / Parth Asawa — lessons for fleet — 2026-06-10

## TL;DR

- **CL-Bench 1.0** (released 2026-05-04) is the first realistic benchmark for *online* improvement: six domains of sequential, stateful task series (incl. the SQL-question task from the thread) scored with a **gain metric** that separates learning-from-experience from raw model capability.
- **The differentiator between models is not whether they write memory, but how far they take it.** Asawa's progression: **fail → investigate → verify → distill → consult**. Sonnet 4.6 exits at stage 1 (piles of failure notes and open guesses, rarely consulted). Opus 4.7 reaches stage 3 (schema reference with uncertainty flagged, but only 7–33% verification coverage). Fable 5 completes the loop — up to **73% verification coverage** and distillation into general rules.
- **Key surprise from the paper:** naive in-context learning can *outperform* dedicated memory systems. Bad memory is worse than no memory. Memory quality, not memory presence, is the asset.
- **Design advice from the thread:** don't steer the model prompt-by-prompt — build loops that let it self-correct against environment feedback (/goal, Outcomes) and manage its own context (memory).
- Fleet already implements most of the progression structurally; the gap is **measuring verification coverage of project memory** and forcing distillation past the "failure notes" stage.

## The author

**Parth Asawa** (@pgasawa) — CS PhD student at UC Berkeley (EECS), advised by **Matei Zaharia** and **Joey Gonzalez**; Sky Computing Lab ecosystem; Laude Open Research Resident. Research program: continual learning with sample efficiency, spanning data → learning → evaluation:

- **Advisor Models** (ICML 2026, arXiv:2510.02453) — small open-weight models that generate per-instance natural-language advice to steer black-box frontier LLMs (+27.4% on tax reasoning for GPT-5.2; −24.6% steps for Gemini 3 Pro on SWE tasks).
- **SIEVE** (arXiv:2604.02339) — parametric learning from natural language with as few as 3 examples, via decomposed-context synthetic data + context distillation.
- **LOTUS / Semantic Operators** (arXiv:2407.11418) — declarative LLM data processing with accuracy guarantees.
- **Continual Learning Bench** (github.com/pgasawa/continual-learning-bench, continual-learning-bench.com) and **SkillLearnBench** (arXiv:2604.20087, 20 skill-dependent tasks).

The fail→investigate→verify→distill→consult progression is **not formalized in any paper** — it lives in his X threads as a design heuristic. The thread Doug shared is currently its primary documentation.

## The benchmark

- Six domains: software engineering (sequential issues on real repos), database querying (NL questions over SQLite, with schema changes/obfuscation/migrations to block shortcuts), disease-outbreak forecasting, Texas Hold'em vs deterministic policies, demand forecasting, RF signal processing.
- Sequential schedule; each question can be a **separate agent session with a shared mounted filesystem** (the CMA-with-memory setup from the thread).
- **Gain metric** = improvement attributable to accumulated experience. Tasks are expert-validated to contain learnable latent structure.
- Published finding: naive in-context learning can beat dedicated memory systems; Sonnet 4.6 led aggregate reward/gain among some tested configurations. (No verified public leaderboard row for Fable 5 vs Opus 4.7 vs Sonnet 4.6 beyond the thread's own numbers.)

## The Anthropic features referenced (verified via /claude-api)

- **CMA memory stores** — workspace-scoped stores FUSE-mounted at `/mnt/memory/<store>/`; agent uses ordinary file tools; every mutation creates an immutable version (audit/rollback/redact); optimistic-concurrency preconditions.
- **Outcomes** (`user.define_outcome`) — rubric-graded iterate→grade→revise loop; the **grader runs in a separate context window** from the agent (judge ≠ generator, platform-native).
- **/goal** (Claude Code) — completion condition evaluated each turn by a separate small model (Haiku); loop continues until the condition passes.
- **Fable 5 guidance** — full task spec up front, high effort, loops for self-correction rather than per-step steering; it under-reaches for memory/subagents unless told *when* to use them (prescriptive trigger conditions give measurable lift).

## Mapping the progression onto fleet (what exists vs what's missing)

| Stage | Fleet today | Gap |
|---|---|---|
| **Fail** (document) | Outcomes log (`fleet outcomes`), wave digests on disk | OK |
| **Investigate** | `fleet reflect` scaffolds proposals from recurring failures | Triggered manually/by daemon nudge, not per-failure |
| **Verify** | Proof-of-work gate, `fleet verify` (judge ≠ generator, fail closed), `audit-docs`, `currency` provenance | **Verification applies to *work*, not to *memory*.** Nothing measures what fraction of CLAUDE.md/.claude-docs claims are checked facts vs open guesses |
| **Distill** | Daemon nudges Captain to distill wave learnings into CLAUDE.md; `fleet capture` for skills | No standard that a distilled line must be a *general rule backed by a verified fact* — "maybe prc instead of prc_usd?"-style notes can land in memory |
| **Consult** | Workers auto-load CLAUDE.md; `.claude-docs` index; `fleet recall`; `active` skills | OK structurally; consult-rate not measured |

## Recommended actions for fleet

1. **Add verification coverage to `fleet audit-docs`** (highest leverage, small diff). Flag memory lines containing uncertainty markers ("maybe", "possibly", "verify?", "TODO: confirm", trailing "?") as *unverified claims*; report a coverage score (verified facts / total claims). This is exactly the metric that separated Fable 5 (73%) from Opus 4.7 (7–33%) on the bench. Fail-closed posture: an unverifiable claim is flagged, never silently passed. Mirrors the existing currency provenance rule (source + date) — extend the same discipline from version pins to gotchas.
2. **Encode the five-stage progression in the distill/scribe prompts** (`fleet bootstrap` scribe + daemon distill nudge): every gotcha written to CLAUDE.md must state *how it was verified* (or be marked unverified and queued for verification); failure notes that can't be generalized into a rule get dropped, not hoarded. Prevents the Sonnet failure mode — memory as a junk drawer of guesses.
3. **Prefer Fable 5 for scribe/distill/memory workers.** The bench shows the distill+consult stages are model-dependent; Opus-tier exits early. Spawning scribes with `--model fable` (where available) is a one-flag change.
4. **Treat the "naive ICL beats bad memory" finding as validation of decay discipline.** `fleet skill-audit` pruning, "rebuild CLAUDE.md minimally when bloated", and quarantine states are not housekeeping — they're what keeps memory from becoming net-negative.
5. **(Idea, not commitment) A gain metric for fleet projects.** The outcomes log already records delegation results over time; a `fleet outcomes --gain`-style view (repeat-failure rate per project, trending) would tell us whether a project's memory is actually paying off — fleet's analog of CL-Bench's headline metric.
6. **Advisor-model pattern ≈ brief injection.** Fleet's per-project taste/standards injection into briefs is a hand-rolled advisor. If a project accumulates verified rules, the Captain prepending the top-k relevant rules to a worker brief is the cheap version of Asawa's learned advisor — worth keeping deliberate.

## Sources

1. Thread: https://x.com/pgasawa/status/2051361012838957144 (CL-Bench 1.0 announcement + model comparison)
2. https://github.com/pgasawa/continual-learning-bench
3. https://continual-learning-bench.com/news/cl-bench-1-0/
4. https://sky.cs.berkeley.edu/project/continual-learning-bench/
5. Paper summary: https://hyper.ai/en/papers/2606.05661
6. Author: https://pgasawa.github.io · https://scholar.google.com/citations?user=8un398sAAAAJ
7. Advisor Models: https://arxiv.org/abs/2510.02453 (ICML 2026) · SIEVE: https://arxiv.org/abs/2604.02339 · LOTUS: https://arxiv.org/abs/2407.11418 · SkillLearnBench: https://arxiv.org/abs/2604.20087
8. CMA: https://platform.claude.com/docs/en/managed-agents/overview · Outcomes: …/define-outcomes · Memory tool: …/agents-and-tools/tool-use/memory-tool · /goal: https://code.claude.com/docs/en/goal
