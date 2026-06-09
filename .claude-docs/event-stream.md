# Event-driven Captain + proof-of-work gate

How fleet learns worker state from cmux's event stream (`src/events.ts`) and how
the proof gate (`src/proof.ts`) decides "done". Built against cmux `0.64.12 (92)`
(see versions.md). Both features **hard-gate on `cmux capabilities`
(`methods.includes("events.stream")`) and fall back to the poll loop when absent** —
never assume the stream exists.

## The event reactor (`src/events.ts`)
Subscribes via `cmux events --cursor-file <~/.fleet/events.seq> --reconnect` (NDJSON)
behind the `src/cmux.ts` seam, and classifies frames into worker-state signals
(`frameToSignal`, pure + unit-tested). Daemon + `watch` consume it; **`fleet status`
stays poll-based** (one-shot separate process, can't share the daemon's in-memory map —
it also serves as the gap-recovery reconcile).

### Gotchas that shaped the design (all real, all bit us)
- **Push-*triggered-pull*, not pure push.** `notification.*` / `feed.*` event payloads
  are **redacted** on the stream — a frame only says "something changed on workspace X".
  The rich content (subtitle / question text) must still be pulled via
  `notification.list` / `feed.list` RPC. Don't design as if frames carry content.
- **Feed/question items key on `workstream_id` (= claude `session_id`), NOT
  `workspace_id`.** Fleet tracks workers by `workspaceId`, so the reactor builds a
  **`session_id → workspace_id` map from `agent.hook.*` frames** (which carry both),
  with a `cwd` fallback. A *cold* map (item arrives before any agent.hook for that
  worker) must degrade gracefully — no attribution, no crash — and self-heal once an
  agent.hook teaches it (`events.ts` ~302-309).
- **Ignore `category:"sidebar"` frames.** They are our own dashboard writes echoing
  back; reacting to them self-triggers an infinite loop (`events.ts:131`).
- **Done-signal = `notification "Completed in <dir>"` + feed `kind:"stop"`.**
  `agent.hook.Stop` is **not reliably observed** on the stream — never make it the sole
  done signal; treat it as a bonus accelerator only.
- **Gap recovery:** an ack with `resume.gap:true` (cursor older than the ~4096-event
  retained log) triggers **exactly one** reconcile, then resume live — guard against a
  reconcile storm on every clean ack.
- **`blocked-on-you`** is the event-sourced status (feed `status:"pending"` of kind
  question/permission/plan). The older screen-scrape `awaiting-input` is kept as the
  poll-path fallback and renders into the *same* lane.

## The proof-of-work gate (`src/proof.ts`, `src/commands/done.ts`)
`fleet done --proof <kind:ref>` attaches proof; `gateProof` decides the verdict. The
verifier is the separate `src/commands/verify.ts` path — **judge ≠ generator**, and the
gate **fails closed**.

- **`note:` is metadata-only and can NEVER satisfy the gate alone** — a worker's free
  text is self-certification, the exact thing the gate exists to prevent. note-only (or
  no proof) → `done-without-proof` (flagged, NOT `complete`). *(This was a shipped bug
  caught in review — see the git history for `fix(proof): note: alone never satisfies`.)*
- A `complete` verdict requires ≥1 **checkable** proof: a runnable `test:`/`command:`/
  `lint:`/`curl:` that exits 0, or a static `file:` that is present / non-empty /
  readable. Any checkable failure → `proof-failed`. A `note:` may *accompany* a checkable
  proof as a label, never stand alone.
- `digest`'s done-detection routes idle workers through this gate before recording
  `complete` to the outcome log — "idle" alone is no longer "done".

### Known non-blocking follow-ups (from review, not yet fixed)
- Runnable proof validates only exit code, not relevance — `test:true` / `command:exit 0`
  passes (`proof.ts` ~96-99, `verify.ts` ~50-58).
- `verify.ts` `execSync` has **no timeout** — `--proof test:'sleep 99999'` hangs
  `fleet done`/`digest` (daemon is insulated). Add a bounded timeout → treat as FAIL.
- `digest` re-runs runnable proofs each wave → duplicate `complete` rows; consider dedup.
