# Context guard — daemon-driven 50%/66% compaction across the fleet

The daemon watches every session's context-window occupancy and orchestrates
compaction at safe breakpoints, so a worker or the Captain never silently
degrades past a full window. Reads telemetry the statusline emits; acts through
the existing `submitToClaude` seam. Module map: `src/daemon/ctx.ts` (sidecar
reader), `evaluateContextOccupancy` in `src/daemon/policy.ts` (pure policy),
`beat()` in `src/daemon/loop.ts` (wiring), config in `src/daemon/config.ts`.

## Policy
- **Caution (default 50%)**: a session should compact at its next natural
  breakpoint. For a WORKER that breakpoint is idle (between turns) — the daemon
  sends `/compact` straight to its pane. For the CAPTAIN it's a nudge (persist
  `fleet state`, run `/compact`, then `fleet state` to reload).
- **Hard ceiling (default 66%)**: compaction must always happen before this. A
  worker still running mid-turn at the ceiling → urgent Captain nudge (it can't
  be interrupted safely); the Captain at the ceiling → urgent version of its
  nudge (or, opt-in, an auto-`/compact` after one save-state beat).
- Thresholds are **starting hypotheses**, not universal truths — per
  `research/2026-06-08-captain-context-and-self-evolution.md` (the "200K window
  degrades near 50K" number is fabricated), they are **configurable** and meant
  to be tuned against the Captain's own occupancy logs.

## Telemetry contract (consumed; written by the statusline)
Every Claude session writes `~/.fleet/ctx/<session_id>.json` on each statusline
refresh (~300ms debounce while active):
```json
{ "schema": 1, "session_id": "...", "ts": 1760000000, "pct": 42,
  "used_tokens": 84000, "window_tokens": 200000, "model": "fable-5",
  "cwd": "/path", "cost_usd": 1.23, "fleet_session": "cliff or empty",
  "fleet_agent_id": "agent id or empty", "compactions": 0,
  "hist": [[1760000000, 42]] }
```
- **`ts` is epoch SECONDS.** `pct` is 0–100 occupancy.
- **Worker → sidecar**: match by `fleet_agent_id` (workers inherit `FLEET_AGENT_ID`).
- **Captain → sidecar**: match by `fleet_session` == the Captain's session with
  an EMPTY `fleet_agent_id`. (The brief lists a cwd fallback; the orchestrator
  record stores no cwd, so we match on session only — see `captainSidecar`.)

## Fail-closed rules (gates fail closed — CLAUDE.md)
- **Staleness**: `ts` older than 10 minutes (`CTX_STALE_SEC`) → occupancy
  UNKNOWN. The guard takes NO compaction action on unknown data and never
  reports unknown as healthy. A missing `~/.fleet/ctx` dir, corrupt JSON, or an
  off-schema record (missing/non-numeric `ts`/`pct`, `pct` out of 0–100) all
  collapse to UNKNOWN — never a crash, never an action.
- **Compaction detection**: a `pct` DROP of more than 15 points vs the last
  observation means the session compacted — the per-agent episode (cooldown,
  "already compacted", "escalated") resets so a later climb re-arms cleanly.
- **No infinite `/compact`**: after the daemon sends `/compact` it waits out a
  cooldown (default 10 min). If occupancy still hasn't dropped, it escalates ONE
  non-urgent nudge to the Captain rather than re-sending forever.

## Config knobs (tune via `~/.fleet/daemon/shared-config.json`)
Same mechanism as every other daemon tunable (`DAEMON_DEFAULTS` +
`loadSharedSettings`): edit the JSON file; the loop and `fleet spawn` pick it up.

| key | default | meaning |
| --- | --- | --- |
| `contextCautionPct` | `50` | compact at the next breakpoint once occupancy ≥ this |
| `contextHardPct` | `66` | hard ceiling — always compact before this |
| `contextAutoCompactWorkers` | `true` | drive `/compact` to an idle worker (else nudge-only) |
| `contextAutoCompactCaptain` | `false` | drive `/compact` to an idle Captain (else nudge-only) |
| `contextCompactCooldownSec` | `600` | wait before escalating a `/compact` that didn't take |
| `contextBackstopPct` | `60` | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` exported on a worker's launch line |

`contextBackstopPct` is a belt-and-suspenders backstop: it sets Claude Code's
OWN auto-compaction override in the worker's process env at launch (the var only
takes effect when set at launch — shell profiles don't reliably cover cmux
panes, so `buildWorkerLaunchCommand` carries it). It sits between caution and the
hard ceiling, so if the daemon ever misses a beat the worker still compacts.

## Reaction time (beat cadence)
The guard runs every `beat()`, which fires on the heartbeat tick (default 12s)
AND event-driven (~1s after cmux activity), debounced to `MIN_BEAT_MS` (1.5s).
So an idle worker crossing 50% is auto-`/compact`ed within ~1–12s. The 10-minute
staleness window is far longer than the beat, so a briefly-paused statusline
never reads as stale mid-work.

## Visibility
`fleet status` shows `ctx 42%` per agent when a fresh sidecar exists, `ctx ?`
when one exists but is stale, and nothing when there's no sidecar at all.

## Worker brief clause
Every dispatched worker brief (spawn + grid) ends with a context-discipline
clause (`contextDisciplineClause()` in `src/commands/spawn.ts`): self-compact at
~50%, always before 66%, and expect the daemon may issue `/compact` while idle.
