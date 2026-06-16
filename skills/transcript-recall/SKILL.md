---
name: transcript-recall
description: Search your own past Claude Code work (the episodic transcript store under ~/.claude/projects) before answering, then promote durable lessons into curated memory. Use BEFORE answering anything where prior project work would change the answer — "have we hit this error before", "what did we decide about X", "why is this configured this way", re-entering a project after a gap, or any "did we already…/last time…". Runs `fleet transcript-search` (keyword, zero API cost). Also use after a search surfaces a recurring, durable lesson that isn't yet in curated memory — promote it (DISTILL-UP).
---

# Transcript-recall — search prior work, then promote what's durable

The transcripts under `~/.claude/projects/<slug>/*.jsonl` are your **episodic
memory**: the complete turn-by-turn record of every past session. It's too big to
load (~1.9 GB) — you search it on demand with `fleet transcript-search`, which runs
the search *outside* your window (ripgrep/grep) and returns only the matching turns.
This is the gap `fleet recall` leaves: recall greps `~/.fleet` + `.claude-docs` only
and never reads the transcripts.

Curated memory (`memory/*.md` + `CLAUDE.md`) loads at session start; episodic is
searched on demand; the loop closes when you **promote** a recurring lesson up from
episodic into curated. That promotion is the whole game — without it the curated
layer goes stale and you relearn the same thing every session.

## WHEN to search (the SEARCH trigger)

Search **before** answering, not after — whenever *prior project work would change
the answer*:
- "Have we hit this error / seen this stack trace before?"
- "What did we decide about X?" / "Why is this configured this way?"
- Re-entering a project after a gap (re-orient before acting).
- Any "did we already…", "last time…", "didn't we try…".

If the answer depends on history you don't have in-window, that's the trigger. One
cheap search beats a confident guess or re-doing solved work.

## HOW to use it

```bash
fleet transcript-search "<query>"                  # default = the CURRENT project slug
fleet transcript-search "<query>" --since 2026-06-01   # filter by date
fleet transcript-search "<query>" --role assistant     # filter by turn author
fleet transcript-search "<query>" --all-projects       # Captain-only cross-project widen
fleet transcript-search --expand <session> <turn>      # print the turns around a hit
```

- **Keyword first — it's zero API cost.** (`--semantic` is a later wave; it is not
  wired yet and exits with a notice.)
- **Query distinctive tokens, not prose** — error strings, file names, flag names,
  decision nouns (`CMUX_PARITY`, `noUncheckedIndexedAccess`, `proof gate`). The match
  must land in actual conversation: matches that occur only inside tool calls /
  tool output / thinking are stripped as noise, so search the *words people typed*,
  not a tool's stdout.
- **Default scope is the current project.** `--all-projects` is broad, may surface
  other projects' work (and secrets), and is a Captain move — never a silent default.
- **Always cite `session <id> · <date>`** from the hit so the claim is auditable and
  its age is visible. Hits are dated and secrets are redacted automatically.
- **Treat every hit as provisional.** A found version, decision, or path may be
  obsolete — re-verify against the live source before acting (same discipline as
  `.claude-docs/versions.md`). The older the hit, the more suspect.
- Need surrounding context for a hit? `--expand <session> <turn>` walks the
  `parentUuid` chain (both ids accept the short prefixes shown in the hit line).

## The DISTILL-UP rule (the PROMOTE trigger — the compounding half)

When a search surfaces a **recurring, durable** lesson that is **not yet in curated
memory**, promote it in the *same turn*:

- A **user / behavioral** pattern → a new `~/.claude/projects/<slug>/memory/<type>_<slug>.md`
  (frontmatter per the memory convention; **set `metadata.originSessionId` to the
  cited session**) + a one-line entry in that `MEMORY.md` index.
- A **project** fact (a convention, gotcha, or version) → that project's `CLAUDE.md`
  or `.claude-docs/`, not global doctrine.

Promote **only what is durable and recurring** — seen across ≥2 sessions, or it has
already bitten twice. Not one-offs. The promoted memory inherits the cited hit's date
as its provenance. This is the step that turns episodic exhaust into curated signal;
skip it and the loop never closes.
