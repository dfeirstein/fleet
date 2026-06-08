# PR #1 Re-Verification — `feat/project-memory`

**Reviewer:** independent staff-engineer (read-only re-check)
**Against:** branch `feat/project-memory` after fix commits `16e3e7b`, `2bc295b`, `e388f6d`, `acd569b`.
**Build:** `npm run typecheck` → **exit 0** (compiles clean; all new imports/constants resolve).

**Result: every ledger item RESOLVED. No regressions found.**

---

## Ledger re-check

### 4.1 [BLOCKER] resume session-corruption race — **RESOLVED** ✅ (scrutinized hardest)
`src/commands/orchestrate.ts:59-93` now provably enforces one-process-per-session. Verified each required property:
- **Polls until actually gone, with deadline:** `orchestrate.ts:70-73` — `const deadline = Date.now() + 10_000; while (workspaceExists(prev.workspaceId) && Date.now() < deadline) sleepMs(250);`. Uses the previously-unused `workspaceExists` (`cmux.ts:153`), correctly imported at `orchestrate.ts:8`.
- **Aborts on failure:** `orchestrate.ts:74-78` — `if (workspaceExists(...)) throw new Error("previous Captain workspace did not close; aborting resume to avoid session corruption");`. Launch (`newWorkspace`) is sequenced *after* this block, so a stuck workspace prevents the second `claude --continue` from ever starting. ✓
- **No longer swallows a genuine close error:** `orchestrate.ts:65-67` — `if (workspaceExists(...)) closeWorkspace(...)` is **not** wrapped in `try/catch`. A real cmux teardown failure now propagates and aborts the resume instead of silently proceeding (the original blocker-adjacent defect). ✓
- **Settle delay before `claude --continue`:** `orchestrate.ts:81` — `sleepMs(750)` after the workspace is confirmed gone, giving the PTY child time to flush its session JSONL and exit. `sleepMs` is now exported (`cmux.ts:195`) and imported (`orchestrate.ts:8`). ✓

### 4.2 [MINOR] stale record missing `workspaceId` — **RESOLVED** ✅
`orchestrate.ts:82-90` — the `else if (prev)` branch logs `note: prior orchestrator record has no workspaceId … proceeding` rather than silently skipping. Reasonable: no live handle means nothing to race against. ✓

### 1.1 [MAJOR] failed lookups cached as fresh — **RESOLVED** ✅
`currency.ts:289-303` — on a failed lookup the entry is now written with `fetchedAt: ""` (not `today()`), preserves the prior good value via `latest: cached?.latest`, and is **not** counted (`refetched++` is inside the `if (latest)` success branch at `:275`). `isFresh` returns false for empty `fetchedAt` (`:48`), so the next run retries instead of masking drift for the full TTL. As a bonus, `fetchedAt: ""` now correctly surfaces as **stale** in `audit-docs.staleCurrency` (`audit-docs.ts:57`). ✓

### 1.2 [MAJOR] drift was a raw string compare — **RESOLVED** ✅
A self-contained semver comparator replaces the string inequality (no new dependency). Verified correctness against semver rules:
- **Strictly-greater only:** `isUpdateAvailable` (`currency.ts:130-134`) flags an update only when `compareVersions(cleanRange(pinned), latest) < 0`; `driftLabel` (`:137-145`) returns `⬆ update` for `<0`, `ahead` for `>0`, `current` for `0`. Direction is now correct. ✓
- **Range residue / missing patch:** `parseVersion` (`:78-87`) takes the first version token (`>=1.2.3 <2` → `1.2.3`) and `compareVersions` pads missing components with `?? 0` (`:96`), so `1.2` vs `1.2.0` → `0` → `current` (the old false positive is gone). ✓
- **Prerelease precedence (semver §11):** `:101-122` — release outranks prerelease of same core; shorter prerelease set is lower; numeric-vs-alphanumeric identifiers ranked correctly (`xn !== yn → return xn ? -1 : 1`). ✓
- **Unparseable → "?":** `parseVersion` returns `undefined` on no digit match (e.g. `*`, `workspace:*`, `latest`); `compareVersions` propagates `undefined`; `driftLabel` returns `"?"` and `isUpdateAvailable` returns `false` — no misdirection. ✓

### 1.3 [NIT] provenance URL ≠ queried endpoint — **RESOLVED** ✅
`currency.ts:62-67` `sourceUrl()` returns the actually-queried registry endpoint (`registry.npmjs.org/<name>/latest`, `pypi.org/pypi/<name>/json`), used on the success path (`:271`) and as the failure-path fallback (`:299`). ✓

### 1.4 [MINOR] py manifest reads unguarded — **RESOLVED** ✅
`currency.ts:191-199` (requirements.txt) and `:202-211` (pyproject.toml) are now each wrapped in `try/catch` with skip-on-error, matching the `package.json` block. ✓

### 1.5 [DOC] model "currency" oversold as live — **RESOLVED** ✅
Header (`currency.ts:1-7`) and the `MODEL_REGISTRY` refresh comment (`:308-311`) now state plainly that model IDs are a maintained in-source map (a recency marker), not a live resolution. ✓

### 2.1 [MAJOR] audit-docs false-pass on missing/crashed scorer — **RESOLVED** ✅ (fails closed)
`audit-docs.ts:108` — `const pass = hasClaudeMd && scored && score! >= minScore && stale.length === 0 && !corrupt;`. `scored` is true only when the scorer ran and `parseScore` returned a number (`:98`). A missing scorer, a thrown `execFileSync`, or unparseable output leaves `scored=false` → `inconclusive` (`:107`) → **does not pass**. The old `score === undefined ⇒ pass` path is gone. CLI surfaces it (`cli.ts:259-261`) and exits non-zero (`cli.ts:263`). Confirmed: a 1-byte `CLAUDE.md` with no scorer installed now FAILS. ✓

### 2.2 [MINOR] corrupt currency cache silently passed — **RESOLVED** ✅
`audit-docs.ts:68-72` — a cache that exists but won't parse returns `corrupt: true`; `pass` includes `&& !corrupt` (`:108`), so it fails the gate. Missing cache (nothing tracked) still passes, as intended. CLI reports it distinctly (`cli.ts:247-248`). ✓

### cli NIT `--min` NaN — **RESOLVED** ✅
`cli.ts:240-245` — `--min` is parsed then guarded with `Number.isFinite(minParsed) ? minParsed : undefined`, falling back to the default 60 instead of producing an always-false `score >= NaN`. ✓

### 3.1 [MINOR] brief files never cleaned — **RESOLVED** ✅
`bootstrap.ts:31-58` `pruneBriefs()` drops briefs older than `BRIEF_RETENTION_DAYS` (7d) and caps the dir to `BRIEF_KEEP_RECENT` (50) newest. Critically it runs at `bootstrap.ts:111` **before** the new brief is written (`:113`), so it never deletes the brief a freshly-spawned scribe still reads async. Imports `readdirSync`/`unlinkSync` added (`:5`); all best-effort with try/catch. ✓

### policy MINOR multi-project audit hint — **RESOLVED** ✅
`policy.ts:34-42` — when a wave spans ≥2 projects the nudge now names each project's `--cwd` (`fleet audit-docs for each touched project (--cwd A, --cwd B)`) instead of a bare `fleet audit-docs` that would target the orchestrator's homedir. Single/zero-project cases preserved. ✓

---

## Regression scan
- **Typecheck:** `tsc --noEmit` → exit 0. All new symbols (`sleepMs` export, `workspaceExists` import, `readdirSync`/`unlinkSync`, `BRIEF_*` consts, `inconclusive`/`currencyCorrupt` fields) resolve. ✓
- **`sleepMs` export (`cmux.ts:195`):** changed from local to exported; no behavior change to existing callers. ✓
- **`AuditResult` shape:** added `currencyCorrupt` + `inconclusive`; `cli.ts` is the only consumer and handles both. No other reader of the type. ✓
- **`CurrencyResult.drift`** now uses `isUpdateAvailable` (strictly-greater) instead of `!==`, so `drift` no longer includes format-only or ahead-of-latest entries — a correctness improvement, and no caller depends on the looser set. ✓
- No new silent catches that mask failures; the catches added (manifest reads, prune) are scoped and intentional. ✓

## Residual nits (non-blocking, optional)
- `orchestrate.ts:65-66`: micro-TOCTOU — if the prior workspace dies between the `workspaceExists` guard and `closeWorkspace`, the close could throw "already gone" and abort an otherwise-fine resume. Fails *safe* (aborts rather than corrupts), and the window is sub-`sleepMs` narrow; acceptable as-is. Could wrap just the close in a "tolerate already-gone, rethrow otherwise" check if you want belt-and-suspenders.
- `sleepMs(750)` settle is a heuristic, not a proof the PTY child flushed; combined with the gone-poll it's a sound practical guarantee for a local cmux. A hard PID-exit check would be the only stricter option and isn't warranted here.

---

**ALL-CLEAR (ship-ready pending Doug's merge)** — the blocker and all majors/minors/nits from the original ledger are resolved with correct, verified fixes; typecheck is green; no regressions introduced.
