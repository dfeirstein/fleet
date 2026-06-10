# Changelog

All notable changes to fleet. Format follows [Keep a Changelog](https://keepachangelog.com); fleet is unversioned (no build step) so entries are grouped by date with PR references. Every PR adds its entry under **Unreleased**; the entry moves under a date heading when merged.

## Unreleased

### Fixed
- **`npm run typecheck` reproducible from a clean install**: `@types/node` is now a declared devDep (`^25.9.2`) — tsconfig's `"types": ["node"]` previously resolved only where the package happened to be installed ad-hoc, so a fresh `npm ci` failed typecheck with TS2688. (#PR)
- **Silent existence probes** (no more leaked `not_found` from `fleet daemon status`/`stop`): `cmux()`/`cmuxJson()` take an opt-in `quietStderr` that pipes the child's stderr (capturing it into the thrown `CmuxError`) instead of inheriting the terminal; `workspaceExists`/`surfaceExists` (via `listSurfaces`/`listGridCells`) set it, since a gone workspace/surface is an expected answer they swallow. Real cmux errors everywhere else keep stderr inherited and visible. (#PR)

### Added
- **Outcomes gain view + per-failure investigate nudge** (CL-Bench rec #5 + the "investigate is not per-failure" gap): new pure module `src/outcomes-gain.ts` (`node:test` coverage) aggregates the cross-session outcome log per project into time-bucketed (UTC-day) failure rates, a repeat-failure signal (exact normalized-text match on `label │ check`, stated as non-semantic), and a fail-closed trend verdict (`<2` graded buckets → `insufficient-data`); corrupt log lines are counted (`malformed`), never silently dropped. Wired as `fleet outcomes --gain [--cwd P] [--json]` (default `fleet outcomes` unchanged). The daemon's failure (error) escalation now tells the Captain to investigate and log the root cause before re-dispatching, not just retry. (#27)

## 2026-06-10

### Added
- **Memory verification coverage** (audit-docs + distill prompts): new pure classifier `src/verification-coverage.ts` (tunable `UNVERIFIED_MARKERS`, `node:test` coverage) scores what fraction of CLAUDE.md gotchas + `.claude-docs` body claims are checked facts vs. uncertainty-flagged guesses; `fleet audit-docs` reports `verification coverage: N/M (P%)` and lists unverified `file:line` refs as warnings that lower memory quality but never hard-fail by themselves (an unreadable memory file still fails closed). Scribe brief + daemon distill nudge now require each gotcha to state how it was verified (or be marked `unverified:` and queued) and reference the fail → investigate → verify → distill → consult progression. Bootstrap-spawned scribes now default to Fable 5 (the verify/distill stages where CL-Bench shows Opus-tier underperforms; rec #3) — ordinary-worker default and `--model` override unchanged. (#26)

### Docs
- **README refresh + real screenshots**: Commands table and `src/` map brought current with the actual surface (adds `done`/`review`/`prompts`/`reply`/`digest` rows, `events.ts`/`proof.ts`/`project-memory.ts`, and the proof-of-work gate + project-memory subsystem notes); embeds live hero/`fleet status`/`fleet doctor` screenshots in `docs/screenshots/`. (#25)

### Fixed
- **`fleet resume` keep+resume alias** (#24, closes issue #23): alive agents' sessions (resolved via the durable map) now count as claims in `planReconcile`, so a dead agent whose cwd-lane probe matches a sibling's LIVE session demotes to skip-with-warning instead of `--apply` respawning an already-running session (fail closed; unresolvable kept agents contribute no claim; contradicted workspace/surface attributions claim nothing — a mis-attributed record can't falsely demote a genuine resume).

## 2026-06-09

### Added
- **Restart-proof fleets via cmux's durable session map** (#20): typed reader for `~/.cmuxterm/claude-hook-sessions.json` (`src/cmux-sessions.ts`, untrusted-input validation), reactor session↔workspace map warmed at startup (cold-map fix), `fleet resume --apply` reconciles the registry against the durable file after a cmux restart (prints/respawns exact `claude --resume` invocations; prunes only untraceable workers, with a note; duplicate-session claims demote to skip — fail closed), durable `agentLifecycle` as the weakest `fleet status` input (probe-running always wins), `fleet doctor` durable-map check.
- **Mission-control surfaces + atomic grid** (#19): worker workspaces auto-group under a fleet-owned "fleet: \<session\>" sidebar group with daemon-synced state colors/descriptions (on-change-only, configurable, capability-gated; kill prunes membership); `fleet grid` spawns the whole pane grid in ONE `new-workspace --layout` call (legacy split-loop fallback); `fleet setup --dock` pins `fleet watch` + `cmux feed tui` into `.cmux/dock.json` (JSONC-safe merge); new `fleet log` milestone breadcrumbs.
- **RPC steering** (#18): `fleet prompts` lists pending Feed prompts (kind, text/options, 120s reply window) and `fleet reply` answers them via the `feed.*.reply` RPCs (the Feed-button code path — no TUI keystrokes; refuses ambiguous/multi-pending without `--prompt`, fails clearly past the window → `fleet send`); daemon blocked-nudges carry the prompt summary + ready-to-run reply command (surfacing only, never auto-answers); `fleet status` blocked rows show the pending prompt kind.
- **One-RPC fleet snapshot + resource guardrails** (#17): `fleet status` pre-fetches the fleet via one `extension.sidebar.snapshot` call (existence checks drop to snapshot misses; classification semantics untouched — every live worker keeps its screen read) and rows show dev-server ports + PR URLs; daemon samples `cmux top`/`surface-health` and NUDGES the Captain (never auto-kills) on sustained CPU (>90% × 5 beats), RSS (>4GB) or health failures — thresholds in daemon shared-config; `fleet doctor` reports the three capabilities + sweeps worker surface health. All capability-gated: older cmux behaves byte-identically.
- **The browser rail** (#15): `fleet verify --visual <url>` — browser-backed verification gate (load + console-clean + expected-text, screenshot/console-dump artifacts, fail-closed `visual` proof auto-attach); `fleet spawn --with-browser` live preview pane + `fleet read --browser-screenshot`; `fleet browser-state save|load` authenticated smoke sessions (0600/0700, refuses paths inside git repos — including not-yet-created dirs); `fleet review <agent>` visual diff panel + rendered wave report.
- **Done-signal fast path + capture-backed digest** (#16): a passing `fleet done` emits a cmux `done-<agentId>` signal consumed as authoritative idle (probe-running still wins; invalidated on re-dispatch); worker output captured to `~/.fleet/<session>/capture/` (2MB tail, atomic, mtime-recency-guarded, removed on kill) and preferred by digest over screen scraping; wave dirs self-gitignore; SKILL.md gains the worker browser self-verify recipe.
- **Proof-of-work flow actually engaged** (#14): `fleet spawn`/`fleet grid` export `FLEET_SESSION` + `FLEET_AGENT_ID` and append a concrete proof instruction to every brief; `fleet verify --check` auto-attaches passing checks as proofs; new sticky `undispatched` status when a spawn fails to deliver its brief; skills teach the proof-gated flow.

### Fixed
- **False-idle detection cascade** (#13): turn-end notifications keyed by surface (not workspace), probe-running outranks notifications, `lastDispatchAt` stamped pre-submit, stable-idle dwell (≥2 beats/≥10s + 15s dispatch hold) for watch exit and daemon wave-complete, digest never finalizes a running worker (and un-pins contradicted finalizations), `rate-limited` counts as active, structural spinner heuristic.
- **Registry lost-update races** (#11): per-session lock file (O_EXCL + PID liveness + 5s staleness) around all registry mutations; degrade-to-unlocked with a loud warning rather than hanging.
- **`fleet audit-docs` fails closed** (#14): scorer missing/crash and unreadable currency cache now FAIL with reasons (missing cache is an explicitly-stated soft pass).
- **Kill data-loss + dispatch safety** (#12): `fleet kill` preserves a worktree whose WIP commit failed (`hasChanges` fails closed on git errors) and warns when your cwd is inside it; `notify-orchestrator` refuses to guess between multiple live Captains; `submitToClaude`'s retry-Enter probe is scoped to the input box so it can't press a permission dialog's default.

### Notes
- Bug-review provenance: `docs/FLEET-BUG-REVIEW-2026-06-09.md` (all five session-observed bugs root-caused). Capability research: `research/CMUX-CAPABILITY-IDEAS-2026-06-09.md`.
- Known environment gap: local cmux 0.64.12 vs upstream 0.64.14 (Claude hibernation fix relevant to long-lived workers).
