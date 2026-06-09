# Fleet bug-hunt review — 2026-06-09

Read-only review of the fleet orchestrator (`src/`), triggered by five bugs observed in
the live "yoshi-2" session. Per-finding: severity, location, root cause, proposed fix.
Observed bugs first (B1–B5), then the general sweep (S1–S8), then a recommended fix order.

---

## B1 — `fleet watch` exits while workers are working  **[CRITICAL — root cause CONFIRMED]**

**Symptom:** `fleet watch` returned immediately while workers had live spinners and
uncommitted work.

**Root cause (primary): turn-end notifications are attributed per-WORKSPACE, but
workers share a workspace.** Three facts compound:

1. `src/commands/spawn.ts:57,74-93,196` — same-project workers are grouped as split
   panes in **one shared cmux workspace** (cap 4, `MAX_PANES_PER_WORKSPACE`); this is
   the **default** placement. `fleet grid` always shares one workspace.
2. `src/notifications.ts:28-38` — `latestByWorkspace()` keys notifications on
   `workspace_id` only. `surface_id` is present on `CmuxNotification` but ignored,
   so a "Completed in <dir>" from worker A is indistinguishable from one for
   siblings B, C, D in the same workspace.
3. `src/commands/status.ts:52-59` — the classification precedence puts the
   notification **above** the live screen probe:
   ```ts
   else if (turnEnded(notifs.get(wsId), a.lastDispatchAt)) status = "idle";
   else status = probe;   // probe === "running" never gets here
   ```
   A worker whose screen shows an active spinner (`probe === "running"`) is still
   forced to `idle` the moment **any sibling** in its workspace emits a turn-end
   notification newer than this worker's `lastDispatchAt`.

So: the first worker in a shared workspace to finish a turn flips **every** sibling to
`idle` simultaneously. `activeCount()` (`src/commands/watch.ts:62-66`) hits 0, the
event-driven quiet-confirm fires after only **1.5 s** (`watch.ts:167-171`), and watch
exits — "instantly", exactly as observed.

**Root cause (secondary): the `fleet send` dispatch window.**
`src/commands/send.ts:14-17` patches `lastDispatchAt` (and `status: "running"`)
**after** `submitToClaude()` returns. `submitToClaude` sleeps 450 ms and then runs a
verify loop of up to 6×450 ms (`src/cmux.ts:386-406`) — a ~0.5–3.2 s window during
which the registry still holds the **previous** turn's `lastDispatchAt`, so the
previous turn's "Completed" notification still reads as a valid turn-end and the
worker classifies `idle` *while the send is literally being typed into its pane*.
This matches the observed "a `fleet send` instruction still being executed".

**Contributing:** the `TURN_END` regex (`src/notifications.ts:45`,
duplicated `src/events.ts:100`) is very broad — `/complete|done|finish|wait|idle|ready/i`.
Claude Code's Notification hook also fires "waiting for your input" texts for mid-task
permission prompts; if the feed-based block attribution by cwd misses
(`src/commands/status.ts:82-84`), a *blocked* worker classifies `idle`.

**Proposed fix (combine all three):**
- Attribute notifications by **surface**: key `latestByWorkspace` on
  `surface_id` (fall back to `workspace_id` only for single-pane workspaces) and
  match against `agent.surfaceId`.
- **Never let a notification override a `running` probe** — reorder the precedence so
  `probe === "running"` wins over `turnEnded` (the screen is direct evidence; the
  notification is a stale broadcast).
- In `send()`, patch `lastDispatchAt` **before** calling `submitToClaude` (a failed
  submit can be reverted, but premature idle cannot).
- Require **stable idle for N seconds** (e.g. ≥10 s / two beats spanning a real
  interval) before `watch --until-idle` exits — the current 1.5 s confirm
  (`watch.ts:171`) and the 800 ms debounce do not survive even one misattributed frame.

---

## B2 — Daemon "Wave complete" fires prematurely  **[CRITICAL — same root cause CONFIRMED]**

**Confirmed: watch and the daemon share the detector.** Both consume `snapshot()`
(`src/commands/status.ts:36`) — the daemon at `src/daemon/loop.ts:71`. The daemon's
wave logic (`loop.ts:135-146`) is a pure **edge trigger** on `anyRunning` with **no
stable-idle dwell at all**: one beat in which every worker misclassifies idle (B1) is
enough. `waveCompleteMessage` (`src/daemon/policy.ts:28-45`) renders `idle` as `✓` —
hence "each premature notification claimed all workers ✓".

**Why it fired *multiple* times:** `mem.waveAnnounced` re-arms whenever anyRunning
flips true (`loop.ts:139`). The Captain's follow-up `fleet send`s set workers back to
`running`; the next sibling notification (or the next send window, B1-secondary)
flips the fleet to all-idle again → another announcement. Repeats once per
re-dispatch, as observed.

**Proposed fix:** after the B1 detection fix, additionally require K consecutive
all-idle beats (e.g. 2 beats ≥10 s apart) before announcing, and consider gating the
announcement on "no `lastDispatchAt` younger than ~15 s" so mid-dispatch fleets are
never declared complete.

---

## B3 — `⚠ done (no proof)` for every worker, always  **[MAJOR — root cause CONFIRMED: the proof flow is never engaged]**

**Detection is "working as coded"** — `src/commands/status.ts:65` flags any idle
worker with empty `proofs`, and proofs are *always* empty because **nothing in the
system ever causes anyone to attach one**:

1. **Workers are never told.** The spawn brief (`src/commands/spawn.ts:309-314`)
   appends only the worktree-commit note. No mention of `fleet done --proof`.
2. **Captains are never taught.** `grep -rn proof skills/` → **zero hits**. Neither
   `skills/fleet/SKILL.md` nor `orchestrator-doctrine.md` mentions `fleet done` or
   proofs anywhere; SKILL.md:80 explicitly teaches the *opposite*: "A worker is done
   when its status reads `idle`." The only runtime mentions are the CLI help and the
   daemon's after-the-fact nag (`src/daemon/policy.ts:89-93`).
3. **Workers structurally *can't* run it.** `sessionId()` (`src/registry.ts:75-93`):
   a worker pane's `CMUX_WORKSPACE_ID` matches no orchestrator record, and
   `FLEET_SESSION` is not exported into the worker's launch command
   (`spawn.ts:151-162` builds plain `claude …`). Resolution falls through to the
   git-toplevel hash — which for a **worktree** worker is the *worktree* path, not the
   repo, and for a named-session Captain (e.g. `yoshi-2`) never equals the Captain's
   registry. `fleet done` inside a worker therefore reads the wrong (usually empty)
   registry and fails with "no agent matching".

The design intent (docs/PLAN-event-driven-and-proof-gate.md §164: "Worker or Captain
invokes it") shipped the gate but not the engagement path. As-is the flag is
unavoidable noise, plus a recurring daemon nag every cooldown.

**Proposed fix:**
- Bake the proof instruction into the spawn dispatch: append to every brief
  "When finished, run: `FLEET_SESSION=<session> fleet done <agentId> --proof
  <kind:ref>` (e.g. `test:'npm test'`)" — spawn knows the session and agentId; or
  export `FLEET_SESSION`/`FLEET_AGENT_ID` in the worker's launch command so a bare
  `fleet done $FLEET_AGENT_ID --proof …` resolves.
- Teach the flow in SKILL.md + orchestrator-doctrine.md (Captain attaches proof at
  digest-review time when the worker didn't).
- Optionally: have `fleet verify <agent> --check …` (Captain-run, already works)
  auto-attach the passing check as a proof, so the existing Captain verify habit
  greens the gate.

---

## B4 — `fleet digest` captures mid-stream snapshots  **[MAJOR — CONFIRMED, plus a worse follow-on]**

**Confirmed:** digest is a raw screen scrape at call time —
`src/commands/digest.ts:55` `readScreen(target(a), 200, true)`. Called at the
premature wave-complete moment (B1/B2), it captures spinner frames
("Razzmatazzing… 12m 11s") instead of a final report. There is no waiting for, or
extraction of, the final assistant message.

**Worse — the premature digest poisons the turn permanently:**
`digest.ts:79-93` treats the (misclassified, B1) `idle` status as terminal, runs the
proof gate, writes a `verify-fail` outcome to the trajectory store for a worker that
is *mid-task*, and patches `finalizedAt`/`finalProof`. When the worker later actually
finishes **the same turn**, `lastDispatchAt` hasn't advanced, so
`alreadyFinal` (`digest.ts:84`) stays true and the real completion is **never
re-gated** — the stale `missing` verdict is pinned and re-displayed forever, and the
outcome log (consumed by `reflect`/`profile`) carries false failures.

**Also noted:** the `WORKING` heuristic (`src/status.ts:17-18`) hard-codes a spinner
verb list that doesn't include "Razzmatazzing" (Claude Code's verbs are open-ended)
and its elapsed-time alternation `\(\d+s\s*·` doesn't match minute-form timers
("12m 11s") — the regex effectively rests on "esc to interrupt" alone.

**Proposed fix:**
- Gate capture on a *real* turn-end (post-B1 detection): skip — or capture but
  **do not finalize** — any worker whose probe still reads `running`; report it as
  "still working" in the digest output.
- Prefer extracting the worker's final message via the feed/RPC (`feed.list` keyed by
  the learned session map in `src/events.ts`) over screen-scraping; keep the screen
  scrape as fallback.
- Make the spinner heuristic generic (any `✶/✻/…` + gerund + timer, minute forms
  included) instead of a verb whitelist.

---

## B5 — `fleet kill` pulls the worktree out from under the caller  **[MINOR — CONFIRMED, plus a data-loss edge]**

`src/commands/kill.ts:47-51` removes the worktree unconditionally; a shell cd'd into
it gets `getcwd` errors. Cosmetic as reported — but note the adjacent **fail-open**:
`commitAll()` swallows all errors (`src/git.ts:50-57`), then `removeWorktree(…,
--force)` runs regardless — if the WIP commit fails (hook, identity unset, lock), the
forced removal **destroys uncommitted work** the code claims to preserve.

**Proposed fix:** before removal, (a) print a warning when `process.cwd()` (or
`$PWD`) is inside the worktree path; (b) re-check `hasChanges(path)` after
`commitAll` and **skip the `--force` removal** (leave the worktree, report it) if
changes survive.

---

# General sweep

## S1 — Registry read-modify-write races (lost updates)  **[MAJOR]**

`src/registry.ts:172-184` — `upsert`/`patch` are load → mutate → save with **no
inter-process lock** (the atomic tmp+rename prevents *corruption*, not *lost
updates*). Concurrent writers exist **today**: the shared daemon beats on every event
(≥1.5 s apart, `loop.ts:176`), `fleet watch` reconciles on events, and the Captain's
CLI commands all `patch()` the same file. Interleaving A-load/B-load/A-save/B-save
drops fields:
- daemon `snapshot()` status-patch clobbers a concurrent `send()`
  `lastDispatchAt` patch → resurrects the stale turn-end → B1 again;
- a status-patch clobbers `proofs` just attached by `fleet done` → B3 noise even
  after proofs are wired up;
- `digest`'s `finalizedAt` patch and the daemon race similarly.

**Fix:** a simple `~/.fleet/<session>.lock` (O_EXCL with retry, like
`acquireSharedLock`) around load→save; or store per-agent files; or make `snapshot()`
only write fields it owns (`status`,`lastSeen`) via a read-current-then-merge patch.

## S2 — `fleet audit-docs` fails OPEN  **[MAJOR — contradicts documented fail-closed doctrine]**

`src/commands/audit-docs.ts:93`:
```ts
const pass = hasClaudeMd && (score === undefined || score >= minScore) && stale.length === 0;
```
- Scorer **not installed** → `score === undefined` → **PASS** (line 81).
- Scorer **crashes** → caught at line 86-88, score undefined → **PASS**.
- `currency.json` **corrupt/unreadable** → `{stale: [], checked: false}`
  (line 57-59) → **PASS**.

CLAUDE.md and the doctrine both say this gate "fails closed (inconclusive = FAIL)".
**Fix:** inconclusive scorer or unreadable currency cache → `pass = false` with the
reason in the report (keep "no cache at all" as the explicitly-allowed soft case if
desired, but say so in the gate contract).

## S3 — `fleet spawn` silently drops the task brief  **[MAJOR]**

`src/commands/spawn.ts:313` — `if (waitForClaudeReady(t)) submitToClaude(t, task);`
If the TUI doesn't reach ready within 30 s, the task is **never sent and nothing is
logged or returned** — the registry records the worker as `running` with the task
attached, and the spawn `outcome` is appended as if dispatched. The worker idles
forever with no brief; the Captain believes it's working. Fail-open.
**Fix:** on timeout, print a loud warning, set the agent's status to
`awaiting-input` (or a new `undispatched`), and surface it in `fleet status`.

## S4 — `rate-limited` doesn't count as active  **[MINOR]**

`src/commands/watch.ts:62-66` and `src/daemon/loop.ts:138` — a rate-limited worker
mid-task is excluded from `activeCount`/`anyRunning`, so watch exits and
wave-complete can fire while a worker is merely waiting out a limit before resuming.
**Fix:** treat `rate-limited` as active (it is "not safely quiescent" by the
function's own comment).

## S5 — `notify-orchestrator` defaults to the wrong Captain  **[MINOR]**

`src/commands/notify.ts:13` — `loadOrchestrator()` with `FLEET_SESSION` unset resolves
`DEFAULT_SESSION` = `"yoshi"` (`src/orchestrator-record.ts:24`). A `/schedule`
routine or hook that forgets to export `FLEET_SESSION` injects its report into the
*yoshi* Captain's pane even when the work belongs to `yoshi-2`. **Fix:** when
`FLEET_SESSION` is unset and multiple orchestrator records exist, refuse with a
"specify FLEET_SESSION" error instead of silently picking the default.

## S6 — `turnEnded` accepts notifications 1.5 s *older* than dispatch  **[MINOR]**

`src/notifications.ts:56` — the skew guard `created_at < lastDispatchAt - 1500`
means a previous turn's "Completed" created up to 1.5 s before a rapid re-dispatch
counts as the *new* turn's end → instant false idle. Compounds B1's send window.
**Fix:** with `lastDispatchAt` patched before submit (B1 fix), tighten the tolerance
to 0 or key turn-ends on a monotonic notification id rather than wall-clock compare.

## S7 — `submitToClaude` retry-Enter can hit a dialog  **[MINOR]**

`src/cmux.ts:393-405` — the cleared-input probe matches the first 28 chars of the
message in the last 9 screen lines; after a successful submit the echoed transcript
can still contain that text, causing spurious extra Enters (up to 6). If a permission
dialog has appeared by then, an Enter selects its highlighted default. Low
probability, real consequence for `--gated` workers. **Fix:** scope the probe to the
input-box region (between the `╭`/`╰` borders) rather than raw tail lines.

## S8 — Daemon stuck-detector is blinded by spinner timers  **[NOTE]**

`src/daemon/loop.ts:104-108` hashes the whole 40-line screen; a wedged-but-animating
TUI (timer ticking, no progress) changes hash every beat and never trips
`stuckMinutes`. Consider stripping spinner/timer lines before hashing.

---

# Recommended fix order

1. **B1/B2 detection core** (one PR): surface-keyed notification attribution; probe
   `running` wins over `turnEnded`; `send()` patches `lastDispatchAt` before submit;
   stable-idle dwell (≥2 beats / ≥10 s) for both watch exit and wave-complete.
   Everything downstream (digest timing, wave digests, daemon noise) depends on this.
2. **B4 digest gating**: never finalize/gate a worker whose probe reads `running`;
   defer or mark "still working"; un-pin `finalizedAt` when probe contradicts it.
   (Cheap once #1 lands; stops trajectory-store poisoning immediately.)
3. **S1 registry locking** — protects #1's correctness under the daemon's
   event-driven write rate.
4. **B3 proof-flow engagement**: spawn-brief instruction + env (`FLEET_SESSION`,
   agent id), SKILL.md/doctrine teaching, optional verify→proof auto-attach. Turns
   the flag from noise into signal.
5. **S2 audit-docs fail-closed** and **S3 spawn loud-fail** — small, doctrine-critical.
6. **B5 kill guards** + S4/S5/S6/S7 minors.

Items 1–3 are the session-breaking cluster; 4–5 restore the documented fail-closed
posture; 6 is polish.
