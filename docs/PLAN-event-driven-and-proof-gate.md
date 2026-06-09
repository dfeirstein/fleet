# PLAN — (1) Event-driven Captain + (3) Proof-of-work gate

**Status:** PLAN ONLY — no implementation. Gate this before spawning a build worker.
**Author:** worker (cmux-orchestrator). **Date:** 2026-06-09.
**Tested against:** `cmux 0.64.12 (92) [ac60b2cd7]` (`/Applications/cmux.app/Contents/Resources/bin/cmux`).
**Repo baseline:** `npm run typecheck` green at HEAD `7ea9a44` (shared-daemon merged mid-research).

---

## 0. Open decisions (rule on these first)

These change what gets built. Ordered by blast radius.

1. **Test runner.** CLAUDE.md says *"no test runner — verify by typecheck + CLI."* The task asks for "unit tests." The two new modules (event-frame classifier, proof-gate rules) are pure, fixture-driven logic that deserve tests. **Recommend:** add Node's built-in `node:test` (zero new deps, Node 22 has it) for *those two modules only*; everything else stays typecheck + CLI + live E2E. **Alt:** assertion scripts run via `tsx`, no `node:test`. — *Needs ruling; affects Phase 1/3 verification.*
2. **`blocked-on-you` vs existing `awaiting-input`.** Task requires a first-class "blocked on you" lane. We already have `awaiting-input` (screen-scraped y/n dialogs). **Recommend:** add ONE new status `blocked-on-you` as the event-sourced lane (permission / question / plan / "waiting for your input"); keep `awaiting-input` as the screen-heuristic fallback that renders into the *same* lane. **Alt:** rename/merge into one. — *Affects the `AgentStatus` union touched in 5+ files.*
3. **Proof-attachment surface.** How a worker/Captain attaches proof: a new `fleet done --proof <kind:ref>` command (explicit, simple) vs a cmux Stop **hook** that refuses turn-end without proof (automatic, heavier). **Recommend:** ship the command now; leave the hook as a later phase. — *Affects Feature 3 scope.*
4. **`fleet status` stays poll-based.** The event layer benefits *long-lived* consumers (daemon, `watch`). `fleet status` is a one-shot in a *separate* process and cannot share the daemon's in-memory cache, so it keeps polling (it also doubles as the gap-recovery reconcile). **Confirm** this scoping — it means "replace polling" is true for daemon+watch, not for the one-shot CLI.
5. **Confirmed done-signal.** `agent.hook.Stop` was **not** directly observed on the stream in my capture windows (no worker finished a turn during them). The *confirmed* done signals are `notification.list` → `"Completed in <dir>"` and feed items `kind:"stop"` (231 present). **Recommend:** build done-detection on those two; treat `agent.hook.Stop` as a bonus accelerator to confirm during build. — *De-risks Feature 1.*

---

## 1. Capability verification (done for real — provenance below)

All probes run 2026-06-09 against cmux `0.64.12 (92)`.

### `cmux capabilities`
Returns `{ access_mode, methods: [...] }`. Relevant methods present (feature-gate on these):
`events.stream`, `feed.list`, `feed.push`, `feed.permission.reply`, `feed.question.reply`,
`feed.exit_plan.reply`, `feed.jump`, `notification.list`, `notification.create*`, `notification.dismiss`.
→ **Gate Feature 1 on `methods.includes("events.stream")`.**

### `cmux events` — frame shapes (real captures)
`cmux events [--after <seq>] [--cursor-file <p>] [--name e] [--category c] [--reconnect] [--limit n] [--no-ack] [--no-heartbeat]` → NDJSON.

**Ack frame** (first line unless `--no-ack`):
```json
{"type":"ack","protocol":"cmux-events","version":1,"boot_id":"…","subscription_id":"…",
 "replay_count":4096,"heartbeat_interval_seconds":15,
 "resume":{"after_seq":0,"gap":true,"gap_reason":"requested sequence is older than the retained in-memory event log",
           "latest_seq":120321,"next_seq":120322,"oldest_seq":116226,"requested_after_seq":0},
 "filters":{"categories":[],"names":[]}}
```
→ **Gap detection is given:** `resume.gap === true` ⇒ we missed events (cursor older than the ~4096-event retained log) ⇒ do ONE full reconcile, then resume live.

**Event frame** (envelope is identical across categories):
```json
{"type":"event","version":1,"protocol":"cmux-events","boot_id":"…","id":"<boot>-<seq>","seq":116226,
 "category":"agent","name":"agent.hook.PreToolUse","occurred_at":"2026-06-09T02:58:09.774Z",
 "source":"claude","workspace_id":"9F3C…","surface_id":null,"pane_id":null,"window_id":null,
 "payload":{…}}
```

**Observed `name`s by `category`:**
| category | names observed | payload highlights |
|---|---|---|
| `agent` | `agent.hook.PreToolUse`, `agent.hook.Notification` (Stop/PostToolUse via same bridge, not directly observed) | `hook_event_name`, `phase`("received"/"completed"), `tool_name`, `session_id`(`claude-<uuid>`), `cwd`, `workspace_id`, `_source:"claude"`; `tool_input` **redacted** |
| `feed` | `feed.item.received`, `feed.item.completed` | mirrors the agent hook payload for tool events |
| `notification` | `notification.created`, `notification.requested`, `notification.removed`, `notification.read`, `notification.clear_requested` | **`payload.args` is `"<redacted>"`** — content NOT in the stream |
| `workspace` | `workspace.selected` | focus changes |
| `sidebar` | `sidebar.metadata.updated/cleared`, `sidebar.progress.updated` | **our own dashboard writes echoing back** |

### `cmux rpc feed.list` — the blocked-on-you source
Items carry: `id, created_at, updated_at, kind, source, status, cwd, workstream_id`; questions also carry
`question_prompt, question_options[], questions[], question_multi_select`.
- **kinds:** `question`, `sessionStart`, `stop`, `toolResult`, `toolUse`, `userPrompt`.
- **statuses:** `telemetry` (bulk), `pending`, `expired`.
- **`status:"pending"` (kind `question`/permission/plan) = BLOCKED-ON-YOU.** Reply via `feed.question.reply` / `feed.permission.reply` / `feed.exit_plan.reply`.

### `cmux rpc notification.list` — the done + waiting source
Full objects: `workspace_id, surface_id, title("Claude Code"), subtitle("Completed in <dir>"|"Waiting"), body, created_at, is_read`. Already consumed by `src/notifications.ts`.

### `cmux hooks`
`hooks setup|uninstall|<agent> <install|uninstall|event>|feed`. Claude Code hooks are **auto-injected by the cmux Claude wrapper** (no manual setup) — that's why `agent.hook.*` frames already flow for our workers. Per-agent install exists for codex/gemini/etc.

### ⚠ Two de-risking findings that shape the design
- **Notification/feed event payloads are redacted in the stream.** A frame says *"something changed on workspace X"*; the rich content (subtitle/body/question text) must still be pulled via `notification.list` / `feed.list` RPC. So the model is **push-triggered pull**, not pure push. (This is exactly what the daemon does today — only the trigger granularity improves.)
- **Feed items key on `workstream_id` (= claude `session_id`), NOT `workspace_id`.** Fleet tracks workers by `workspaceId`. `agent.hook.*` frames carry BOTH `session_id` and `workspace_id`, so the event layer must build a **`session_id → workspace_id` map from agent.hook frames** (fallback: match on `cwd`) to attribute a feed/question item to a fleet worker.
- **`category:"sidebar"` frames are our own dashboard writes.** The reactor MUST ignore them or it self-triggers in a loop.

---

## 2. Current-state map (call-sites this plan rewires)

**Polling / state inference**
- `src/commands/watch.ts:54–103` — `watch()` poll loop: `snapshot()` every 4s/10s (`:60`), `sleepSeconds` (`:101`), exit-on-idle debounce (`:79–93`).
- `src/commands/status.ts:31–59` — `snapshot()`: per-agent `probeStatus` (`:43`), `turnEnded` notification override (`:45`), `workspaceExists` death check (`:36`).
- `src/status.ts:22–46` — `classifyScreen()` / `probeStatus()`: the screen-scrape heuristic (rate-limit/error/awaiting/working/idle).
- `src/daemon/loop.ts:67–142` — `beat()`: `snapshot()` (`:68`), per-agent `readScreen` (`:85`), stuck detection via screen-hash (`:102–105`), bypass auto-clear (`:91`).
- `src/daemon/loop.ts:226–253` — `startEventStream()`: **today the event stream is only a bell** — `cmux events --category notification` whose lines matching `notification.(created|requested)` call `doBeat()` (a full re-poll). **No `--cursor-file`, no gap handling, no per-worker routing.** ← primary Feature 1 seam.
- `src/dashboard.ts:47–94` — `updateSidebar()`: "done" ≈ `status !== "running"` (`:82`).
- `src/notifications.ts:19–58` — `listNotifications()` via `notification.list` (`:20`); `turnEnded()` turn-end test (`:53`).

**Done inference / verification (Feature 3 targets)**
- `src/commands/verify.ts:48–81` — the existing independent eval gate (judge≠generator). Feature 3 reuses this as the verifier.
- `src/commands/digest.ts:85–96` — terminal-status (`idle|dead|error`) ⇒ `appendOutcome({event:"complete"})`. **This is "idle == done" recorded to the trajectory store.** ← Feature 3 gates this.
- `src/daemon/loop.ts:128–138` — wave-complete detection (`!anyRunning && prevAnyRunning`) ⇒ `waveCompleteMessage`. ← Feature 3 routes this through the gate.
- `src/dashboard.ts:82` — progress "done" = not running.
- `src/outcomes.ts:17–41` — `OutcomeEvent`/`OutcomeRecord`. ← Feature 3 extends with proof fields.

---

## 3. Feature 1 — Event-driven Captain

### Module layout
- **`src/cmux.ts` (the seam):** add the long-lived subprocess spawn + capability gate here, since CLAUDE.md mandates *all* cmux access funnel through `cmux.ts`.
  - `eventsSupported(): boolean` — `cmux capabilities` → `methods.includes("events.stream")` (cached).
  - `streamEvents(opts:{categories?:string[]; cursorFile?:string; onAck:(a)=>void; onFrame:(f)=>void; onExit:()=>void}): { stop():void }` — spawns `cmux events --reconnect --no-heartbeat [--cursor-file …] [--category …]`, line-parses NDJSON, dispatches ack vs event. Reconnect handled by cmux's `--reconnect`; `onExit` lets the caller restart on hard drop.
- **`src/events.ts` (new — the reactor, top-level peer of `notifications.ts`):**
  - Types: `EventFrame`, `AckFrame`, `WorkerLiveState = { workspaceId; status; lastFrameSeq; blocked?: {kind:"question"|"permission"|"plan"|"waiting"; promptHint?:string}; lastChange:number }`.
  - `class FleetEventReactor` — holds `Map<workspaceId, WorkerLiveState>` + a `Map<sessionId, workspaceId>` learned from `agent.hook.*` frames.
    - `onFrame(f)`: ignore `category:"sidebar"`; classify (below); on a frame whose detail is redacted (notification/feed), lazily pull `notification.list`/`feed.list` to enrich; update state; invoke a registered `onTransition(workspaceId, prev, next)` callback.
    - `onAck(a)`: if `a.resume.gap` → emit `onGap()` (consumer does a full reconcile).
  - `frameToSignal(frame, enrich)` — pure, **unit-tested** against the captured fixtures: maps frame → `{status, blocked?}`.

### Frame → worker-state mapping
| signal | → state |
|---|---|
| `agent.hook.Notification` ("waiting for your input"), or `feed.list` item `status:"pending"` (question/permission/plan) | **`blocked-on-you`** (with `blocked.kind`) |
| `notification.list` subtitle `"Completed in …"`, or feed `kind:"stop"` | `idle` (turn ended → done candidate, → Feature 3 gate) |
| `agent.hook.PreToolUse/PostToolUse`, feed `kind:"toolUse"/"toolResult"` | `running` |
| `workspace` gone (`workspaceExists` false on reconcile) | `dead` |
| rate-limit / error | **stay on screen heuristic** (`classifyScreen`) — no clean event exists; refreshed on the slow tick |

### Cursor persistence, reconnect, gap
- Durable cursor for the daemon: **`~/.fleet/events.seq`** (session-agnostic, matches the shared daemon), passed as `--cursor-file`. cmux updates it after each frame; on restart the daemon resumes exactly where it left off.
- Ephemeral consumers (`watch`) subscribe live (no persisted cursor) and reconcile once on start.
- Gap (`resume.gap===true`): one `snapshot()` + `notification.list` full reconcile to resync, then resume streaming. This is the built-in **fail-safe to poll**.

### How consumers change
- **daemon `loop.ts`:** replace `startEventStream()` (the bell, `:226–253`) with a `FleetEventReactor`. The reactor maintains the live cache; `doBeat()` becomes *event-driven per worker* — a frame for worker X re-evaluates only X (classify + `routeMessage`), instead of full-fleet `snapshot()` on every notification. The periodic `setInterval` tick stays as the **slow path** (stuck/zombie detection = absence of events, rate-limit/error refresh, sidebar pulse, gap safety net). `blocked-on-you` is escalated by `policy.ts:evaluate()` (add the case alongside `awaiting-input`).
- **`watch.ts`:** replace the `snapshot()`/sleep loop with a reactor subscription that prints transitions as frames arrive; keep a low-frequency reconcile and the `--until-idle` exit, now fired when the reactor reports no `running`/`unknown`/`blocked-on-you` worker (same 2-poll debounce).
- **`status.ts` `snapshot()`:** unchanged in shape — it's the one-shot reconcile and the gap-recovery path (see Open Decision 4). It gains the `blocked-on-you` mapping (read pending feed items in addition to the screen probe).
- **`digest`/`dashboard`:** consume the new `blocked-on-you` status (icon/color); otherwise unchanged by F1.

### `AgentStatus` + presentation (touched files)
Add `"blocked-on-you"` to the union in `src/registry.ts:14`, and the icon/color maps in `src/status.ts`, `src/commands/status.ts:8`, `src/commands/watch.ts:19`, `src/dashboard.ts:8/18`. (Per Open Decision 2.)

### Capability-gated fallback
If `eventsSupported()` is false (older cmux): daemon + watch fall back to **exactly today's poll path** (snapshot loop). Log the degradation once. No behavior regression.

### Migration: delete vs keep
- **Replace:** `loop.ts:226–253` bell → reactor; `watch.ts:54–103` poll loop → subscription (snapshot kept as periodic reconcile).
- **Keep:** `status.ts` screen classify (fallback + rate-limit/error + gap recovery), `notifications.ts` (the detail/enrich source), `snapshot()` (reconcile).
- **Add:** `src/events.ts`, `cmux.ts` `streamEvents`/`eventsSupported`, `blocked-on-you`, `~/.fleet/events.seq`.

---

## 4. Feature 3 — Proof-of-work gate on "done"

### Proof artifact schema
`src/proof.ts` (new):
```ts
type ProofKind = "diff" | "test" | "lint" | "curl" | "visual" | "file" | "command";
interface ProofArtifact {
  kind: ProofKind;
  ref: string;        // path (diff/file/visual) OR command (test/lint/curl/command)
  summary?: string;
  attachedAt: string;
}
```
A worker attaches one or more. Stored on the registry agent record (`Agent.proofs?: ProofArtifact[]` in `registry.ts`) so the gate and `fleet status` can read it; the *verdict* is written to the outcome log.

### Attachment surface (Open Decision 3 — recommend the command)
- `fleet done <agent> --proof <kind:ref> [--proof …] [--summary "…"]` — attaches proof to the worker's registry record (a *claim*, untrusted). Repeatable. Worker or Captain invokes it.
- Later phase: a cmux `Stop` hook that blocks turn-end without a proof claim.

### Verifier path (judge ≠ generator, fail closed)
A separate `gateProof(agent): { verdict:"complete"|"done-without-proof"|"proof-failed"; detail }` in `src/proof.ts`:
1. **No proof attached** → `done-without-proof` (flagged, never complete).
2. **Runnable proof** (`test`/`lint`/`curl`/`command`) → **re-run independently via the existing `verify()`** (`commands/verify.ts`, runs in the worker's worktree/cwd — *not* the worker self-reporting). Non-pass / inconclusive → `proof-failed`.
3. **Static proof** (`diff`/`file`/`visual`) → artifact must **exist + be non-empty + readable**. Missing/unreadable/empty → `proof-failed`. (Can't re-run a screenshot; existence+nonempty is the fail-closed bar — Open Decision 6.)
4. Only **(proof present) AND (independent check passes)** → `complete`.

All inconclusive/error states resolve to FAIL (never pass) — honoring CLAUDE.md's fail-closed rule.

### Wiring into Feature 1's done-detection
- **daemon reactor:** when a worker transitions to `idle` (turn ended), call `gateProof(agent)` before treating it as complete. `complete` → record + (optionally) wave-complete. `done-without-proof`/`proof-failed` → mark the worker a distinct state and **escalate once** to the Captain via `routeMessage` (`policy.ts` gains the case).
- **`digest.ts:85–96`:** gate the `appendOutcome({event:"complete"})` — emit `complete` only when `gateProof` passes; otherwise emit the record with `proof:"missing"|"failed"` so the trajectory store never logs an unproven completion as done.
- **`outcomes.ts`:** extend `OutcomeRecord` with `proof?: "verified"|"missing"|"failed"` + `proofRefs?: string[]`.

### "Done-without-proof" diagnostic surface
- `fleet status` adds a flag/lane: `⚠ done (no proof)` for workers idle without a passing gate.
- daemon escalates once (cooldown via `policy.ts`).
- outcome log records the verdict (auditable).
- optional auto-entry into `fleet state risk`.

---

## 5. Sequencing

Feature 3 consumes Feature 1's done-detection ⇒ **F1 before F3** (serial across the boundary). Within F1, the daemon-rewire and watch-rewire touch different files and can be **parallel**.

| Phase | Scope | Files | Depends on | Parallel? | Worktree? |
|---|---|---|---|---|---|
| **0** | Seam + scaffolding: `eventsSupported`, `streamEvents`, `~/.fleet/events.seq`, add `blocked-on-you` to union + icon/color maps | `cmux.ts`, `registry.ts`, `status.ts`, `commands/status.ts`, `watch.ts`, `dashboard.ts` | — | serial | shared |
| **1** | Event reactor (F1 core): `src/events.ts`, `frameToSignal`, session↔workspace map, gap recovery | `events.ts` (+ `notifications.ts` enrich) | 0 | serial | shared |
| **2a** | Daemon uses reactor; `blocked-on-you` escalation; fallback path | `daemon/loop.ts`, `daemon/policy.ts` | 1 | ∥ with 2b | yes (isolates loop.ts) |
| **2b** | `watch` uses subscription; fallback path | `commands/watch.ts` | 1 | ∥ with 2a | yes |
| **3** | Proof schema + `fleet done` + gate rules | `src/proof.ts`, `registry.ts`, `outcomes.ts`, `cli.ts` | 2 merged | serial | branch off merged F1 |
| **4** | Wire gate into done-detection + diagnostic surface | `digest.ts`, `daemon/loop.ts`, `daemon/policy.ts`, `commands/status.ts`, `dashboard.ts` | 3 | serial | same as 3 |

**Worktree guidance:** 2a/2b in separate worktrees (true parallel, low conflict — different files, shared read-only `events.ts` API). F1↔F3 are **not** parallel. Phases 0/1/3/4 are single-stream.

---

## 6. Verification plan (verification-first; no test runner today — see Open Decision 1)

- **Phase 0:** `npm run typecheck` green. Manual: a 10-line `tsx` smoke that calls `streamEvents` and prints 5 frames; `eventsSupported()` returns true on this cmux.
- **Phase 1:** `frameToSignal` **unit tests** against the captured fixtures (`agent.hook.Notification`→blocked, feed `pending`→blocked, notification "Completed"→idle, `PreToolUse`→running, `category:sidebar`→ignored). Gap-recovery test: feed an ack with `resume.gap:true` → reconcile fires once. (`node:test` if Decision 1 = yes, else `tsx` assert script.)
- **Phase 2:** **Live E2E** — `fleet spawn` a throwaway worker, drive it to a question (blocked-on-you) and to turn-end (idle); assert the daemon/watch react in ~1s **without** the slow tick (drop heartbeat to a long interval to prove it's event-driven). **Fallback test:** stub `eventsSupported()`→false (or point `CMUX_BIN` at a binary lacking `events`) and confirm the poll path still tracks state.
- **Phase 3:** **Unit tests** for `gateProof` fail-closed matrix: no-proof→`done-without-proof`; runnable-proof passing→`complete`; runnable failing→`proof-failed`; static-proof missing/empty→`proof-failed`; static present→`complete`. CLI: `fleet done … --proof` attaches and `fleet status` shows it.
- **Phase 4:** **Live E2E** — (a) worker idles with no proof → `⚠ done (no proof)` + one escalation, NOT logged complete; (b) worker idles with a passing `--proof test:'npm test'` → `complete` logged; (c) worker idles with `--proof file:/nonexistent` → `proof-failed`, fail-closed. Confirm `digest` never writes `complete` for (a)/(c).
- **Always:** `npm run typecheck`; `fleet audit-docs` if project memory touched; `.js` import extensions + `import type`; any new cmux call goes through `cmux.ts`.

---

## 7. Risks & open decisions

- **Beta surface / version pin.** `cmux events` + `feed.*` reply methods are current on `0.64.12 (92)` but not documented-as-stable. Mitigation: hard feature-gate on `cmux capabilities`; pin the tested version in `.claude-docs/versions.md` via `fleet currency`; fallback path is the existing poll loop.
- **`agent.hook.Stop` unconfirmed** on the stream (Open Decision 5) — build done-detection on the confirmed `notification "Completed"` + feed `kind:"stop"`.
- **Redacted event payloads** force a push-triggered *pull* (enrich via RPC). Acceptable; matches today's model. Don't design as if frame payloads carry content.
- **`session_id ↔ workspace_id` attribution** for feed/question items is indirect (learned from agent.hook frames / `cwd`). If the map is cold (no agent.hook seen yet for a worker), fall back to `cwd` match or the next reconcile.
- **Self-trigger loop:** must ignore `category:"sidebar"` (our own dashboard echoes).
- **Decisions to rule on:** §0 items 1 (test runner), 2 (`blocked-on-you` shape), 3 (command vs hook), 4 (`status` stays poll), 6 (static-proof bar).
