# Design — Fleet Captain: Context Engine & Self-Evolution

_Status: active design · 2026-06-08 · grounded in `research/2026-06-08-captain-context-and-self-evolution.md`
(Nous Hermes Agent, Martian `lossless-claw`/LCM, Tobi Lütke's QMD, + Karpathy/SOTA)._

## The two problems

1. **Context residue.** The Captain is a *long-lived, project-agnostic* session, but its
   window fills with **project-specific residue** (worker transcripts, file dumps, verify
   logs). Nothing mechanically prevents it — doctrine relies on exhortation. The result:
   the manager slowly turns into a coding agent and degrades as the window fills.
2. **No self-evolution.** The Captain doesn't get better from experience. There is no record
   of what was delegated and whether it worked, so nothing to learn from; `fleet capture` is a
   one-shot stub with no eval gate and no decay.

## Principles

- **Trim ≥ add.** The window degrades with size; *removal* is as important as addition.
  Manage context bidirectionally, not by monotonic accretion.
- **Two kinds of content, two treatments.**
  - *Management state* (objectives, roster, decisions) → **memory blocks; prune state
    directly.** Structured, capped, no summarization drift.
  - *Worker residue* (transcripts, file dumps) → **summarize-lossless to a digest, raw on
    disk, recall on demand.**
- **Lookup, not resident.** Push detail to a durable markdown store; bring it back via a
  *delegated/external* search that returns only the answer — the search itself never pollutes
  the Captain's window.
- **Pointer over re-summary.** Prefer dropping resolved content to a one-line pointer-to-disk
  over re-summarizing (re-summarization drifts; verified caveat).
- **Self-evolution is additive, gated, reversible.** Capture skills (safe) → evidence-gated
  doctrine deltas (next) → **never** free-form rewriting of live instructions (the verified
  anti-pattern — Gödel Agent reports instability).
- **Judge ≠ generator, everywhere.** The proposer is never the sole judge — for worker output,
  captured skills, and doctrine deltas alike. Fleet already has `fleet verify` for this.
- **Project-agnostic scope.** Doctrine/skills/CLI patterns MAY self-evolve; **project facts
  never enter Captain doctrine** — they flow to per-project `CLAUDE.md`/`.claude-docs`.
- **Empirical thresholds.** Compaction/eviction/nudge thresholds are configurable and tuned
  against the Captain's own logs — never a hard-coded token number. (The "50K degrades" figure
  was fabricated; do not encode it.)

## Reference architectures (what we take / reject)

| Reference | Take | Reject |
|---|---|---|
| **Hermes Agent** (Nous, MIT, v0.16.0) | `SOUL.md` identity split (durable, always-resident) vs facts/per-project files; `skill_manage` self-evolution (draft skill → on error rewrite); session FTS search; ~50%-occupancy compaction that protects head/tail | Exact nudge thresholds ("5+ calls", "~15 tasks") — third-party, unverified |
| **lossless-claw / LCM** (Martian) | persist-all + summarize into a 2–3 level hierarchy + **delegated `lcm_expand` recall** (search runs in a sub-agent, only the answer returns); configurable `contextThreshold`, protected fresh tail | SQLite/FTS5 + Node-22 hard dependency — reproduce with files + ripgrep instead |
| **QMD** (Tobi Lütke, `tobi/qmd`) | local hybrid semantic search (BM25+vector+LLM rerank) over **markdown**, exposed over **MCP** — Fleet's memory is already markdown; opt-in recall power tier | ~2GB local models + `node-llama-cpp` + sqlite as a *required* dep — keep it optional |

**Convergence signal:** three independent serious builders landed on the same shape — keep the
live window lean, push detail to a durable store, recall semantically via a delegated/external
search that returns only answers.

## Architecture

### A. Context engine

```
Captain window  =  doctrine (system prompt, stable)
                +  memory blocks (capped, structured): active_objective, fleet_roster,
                                                        open_decisions, risks
                +  fresh tail (recent turns)
                                       │  on wave close / threshold
                                       ▼
Durable store (markdown on disk)  ~/.fleet/<session>.outcomes.jsonl   ← trajectory log (Move 1)
                                  .claude-docs/<project>/waves/<id>.md ← raw worker output (Move 2)
                                  .claude-docs/<project>/profile.md    ← per-project profile
                                       │  on demand
                                       ▼
Recall: `fleet recall "<q>"` → grep core (zero-dep)  ||  QMD `query` over MCP (opt-in)
        runs in a sub-agent; returns only the answer, never the search.
```

- **Wave-digest firewall** (Move 2): the daemon's wave-complete hook writes each worker's full
  output to a wave file and surfaces only a 1–2K-token structured digest (objective, outcome,
  artifacts as `file:line`, lessons, verify verdict) to the Captain. Raw never enters the window.
- **Compaction** (later): at a *configurable* occupancy, preserve memory blocks + open decisions
  verbatim, drop resolved-objective chatter and tool-result detail to disk pointers.

### B. Self-evolution loop

```
delegation → outcome log (Move 1)  →  gated capture (Move 3)  →  skill decay  →  doctrine deltas
  {objective, verdict, cost, lessons}   held-out re-test/canary    utility GC      staged gate + auditor
```

- **Outcome log** (Move 1, this change): append-only `{ts, event, agentId, objective, cwd,
  model, verdict, lessons}` — the trajectory store *everything else gates on*.
- **Gated capture** (Move 3): upgrade `fleet capture` from a stub. Tier the gate (see Q1).
- **Skill decay**: a `skill-currency` audit (mirrors `fleet audit-docs`) scores each captured
  skill's realized reuse-success from the outcome log; quarantine/retire net-negative or stale
  skills. Lossless store makes retirement reversible.
- **Doctrine deltas** (later, high effort): a periodic reflection proposes ONE delta to a
  versioned `doctrine-deltas` file (never edits `orchestrator-doctrine.md` in place); a staged
  gate runs it against held-out past objectives and adopts only if a fleet metric improves; a
  separate **Auditor** session evaluates whether adopted deltas/skills actually helped.

## Open-question resolutions

**Q1 — held-out eval for one-of-a-kind tasks → tiered gating.**
- *Deterministic / parameterizable* captures (build recipe, currency resolver, generator):
  re-runnable → gate with a **synthetic held-out instance + no-skill baseline** (Voyager/MUSE).
- *Judgment / orchestration* plays: capture **provisional** → promote on **verified real reuse**
  (next matching task runs the play; independent verifier judges that real run; 2 clean reuses →
  active, a failure → quarantine, never-reused → decay). Recall (Q2) is what makes reuse findable;
  the lossless store makes decay reversible.

**Q2 — searchable history vs zero-dep → grep core + optional QMD.**
- *Core (zero-dep, always on):* outcome log + wave files + profiles, searched by `rg`/grep.
- *Power tier (opt-in):* if QMD is installed, `fleet recall` prefers its `query` MCP tool
  (semantic, reranked) and falls back to grep. No custom search engine; defer SQLite/FTS5.

## Move sequence

| # | Move | Effort | Status |
|---|---|---|---|
| **1** | **Append-only delegation-outcome log** (`~/.fleet/<session>.outcomes.jsonl`) — prerequisite for everything | low | **in progress** |
| 2 | Wave-complete **digest firewall** (raw → wave file; digest → Captain) | medium | planned |
| 3 | `fleet capture` → **gated pipeline** (held-out / canary) + record to log | medium | planned |
| 4 | Captain **reasoning-budget + delegate-now** doctrine (mechanical anti-drift) | low | planned |
| 5 | `fleet recall` (grep core + opt-in QMD) + per-project profile | medium/high | planned |
| 6 | **memory blocks** + configurable compaction (pointer-not-resummarize) | medium | planned |
| 7 | **skill decay** audit + **doctrine-delta** staged gate + Auditor | high | later |

## Guardrails

- Self-evolution touches **project-agnostic artifacts only**; enforced by a scoped-edit
  constraint + audit check.
- Doctrine deltas go through a **staged gate + PR review** — never autonomous in-place rewrite.
- All thresholds **configurable + empirical**; no hard-coded token numbers.
- Logging/telemetry must **never break a command** (best-effort, swallow errors).
