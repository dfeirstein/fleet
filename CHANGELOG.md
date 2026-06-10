# Changelog

All notable changes to fleet. Format follows [Keep a Changelog](https://keepachangelog.com); fleet is unversioned (no build step) so entries are grouped by date with PR references. Every PR adds its entry under **Unreleased**; the entry moves under a date heading when merged.

## Unreleased

- **Restart-proof fleets via cmux's durable session map**: typed reader for `~/.cmuxterm/claude-hook-sessions.json` (`src/cmux-sessions.ts`, untrusted-input validation), reactor session↔workspace map warmed at startup (cold-map fix), `fleet resume --apply` reconciles the registry against the durable file after a cmux restart (prints/respawns exact `claude --resume` invocations; prunes only untraceable workers, with a note), durable `agentLifecycle` as the weakest `fleet status` input (probe-running always wins), `fleet doctor` durable-map check.

## 2026-06-09

### Added
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
