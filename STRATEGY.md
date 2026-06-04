# Fleet Strategy — from worker dispatcher to a loop-and-workflow engine

A synthesis of two talks into where fleet goes next.

## The two inputs

**Boris Cherny (Acquired).** The engineer's job is moving up the abstraction
ladder: write code → prompt one agent → run *5–10 agents in parallel* → **"I
don't prompt Claude anymore. I have loops that prompt Claude and figure out what
to do. My job is to write loops."** Plus two side ideas: **pre-compute** (cache
recurring work as cheap scripts instead of paying for inference every time) and
**teaching models taste/values** (what makes a *good* result, not just a working
one).

**Mark Kashef (Dynamic Workflows).** The most powerful loops are **workflows** —
Claude *builds an orchestration harness on the fly* (a JS script of isolated
agents) to beat the three failure modes of a single context window:
1. **Agentic laziness** — a big task gets quietly half-done (7 of 15).
2. **Self-preference** — an agent grading its own work is biased and always
   passes itself.
3. **Goal drift** — long, tool-heavy, compaction-prone runs forget the goal.

…using six patterns — **triage, fan-out→synthesize, adversarial-verify,
generate-and-filter, tournament, loop-until-done** — built on **clean context
per agent**, **judge ≠ generator**, **barrier synthesis**, **explicit stop
conditions**, and saved as **reusable skills** (`SKILL.md` + `*.workflow.js` +
`rubric.md`). And a warning: don't workflow trivial tasks — "you're just lighting
money on fire to feel fancy."

## The thesis

**Fleet evolves from a reactive worker-dispatcher into a loop-and-workflow
engine.** The orchestrator stops being a thing you hand single tasks to and
becomes a thing that *pursues objectives*: it picks the right level of
orchestration, generates workflows when the task warrants, runs them on the right
substrate, **gates every result on independent evaluation**, and **promotes
proven solutions into cheap reusable scripts** — all visible and steerable in
cmux.

## Two substrates, one orchestrator

The orchestrator chooses *where* work runs, not just how many workers:

- **Fleet workers** — visible cmux-pane Claude Code sessions. *Watchable,
  steerable, long-running, bound to a project workspace.* Best for **building and
  iterating** on something you want to see.
- **Workflows** — headless subagents in a generated harness. *Clean context,
  parallel, eval-gated, ephemeral.* Best for **producing a verified artifact**
  where you only want the result (verify, triage, rank, research-synthesize,
  loop-until-green).

The hybrid is the sweet spot: run a workflow for rigor, then **surface its
artifact in cmux** for the human.

## Five operating principles (the doctrine)

1. **Tier & substrate selection.** Escalate only as far as the task needs:
   *direct → `fleet spawn` → `fleet grid` → workflow → objective loop.* Use a
   workflow only when the task hits one of the three failure modes; never for
   trivial work.
2. **Independent evaluation is a gate, not an afterthought.** Judge ≠ generator.
   Every "done" passes an eval — a separate verifier, an adversarial skeptic, a
   rubric, or the project's own tests/lint/visual-check — before it's reported.
3. **Loops over one-shots.** Express goals as *stop conditions* ("until the test
   is green"), not counts ("try 10 times"). Re-inject the objective each
   iteration so it can't drift; the daemon's escalation is the guardrail.
4. **Pre-compute and reuse.** When a delegation recurs, capture the proven
   worker/workflow solution into a reusable skill+script. Next time it's a cheap
   deterministic run, not a fresh token burn.
5. **Clean context and taste.** Brief each worker with only its slice; ask for
   structured returns with source paths; inject the project's standards/taste so
   results are *good*, not merely functional.

## Capability roadmap

| Phase | Capability | From | Type |
|---|---|---|---|
| **A** | Workflow-awareness in the doctrine (Yoshi already *has* workflows — teach her *when* + *how*) | Kashef | doctrine |
| **B** | **Eval gates** — auto-run a verifier on worker completion (judge≠generator); pass→done, fail→re-dispatch with the failure, persistent→escalate | both | code |
| **C** | **`fleet capture`** — promote a worker/workflow into a reusable skill (`SKILL.md` + script + rubric) | both | code |
| **D** | **Objective loops** — `fleet objective "<goal>" --done "<check>"`: a standing loop the daemon drives (assess→dispatch→eval→iterate) | Boris | code |
| **E** | **Event-driven daemon + richer cmux visibility** — consume `cmux events` instead of polling; surface loop/objective/eval state in the sidebar | (cmux) | optimization |

## Cost & guardrails

Workflows and loops cost far more than single agents (quota on Max, not dollars,
but finite). Reserve them for the three failure modes. Keep concurrency modest;
the daemon already catches stuck/rate-limited workers; objective loops carry a
max-iteration / budget stop. Default to the cheapest tier that solves the task.

## cmux is the control plane

Everything the orchestrator does should be visible *in cmux*: workflow progress,
eval verdicts, objective/loop state as sidebar badges, and final artifacts opened
in browser surfaces. Move the daemon from 12s polling to the cmux **event
stream** for real-time, lower-overhead supervision.
