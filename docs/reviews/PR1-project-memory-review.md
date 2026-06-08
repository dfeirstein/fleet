# PR #1 Review — `feat/project-memory`

**Reviewer:** independent staff-engineer (read-only)
**Scope:** currency engine, audit-docs gate, bootstrap scribe, captain `--resume` session-safety, plus `cli.ts` / `policy.ts` wiring.
**Build:** `npm run typecheck` → **exit 0** (compiles clean). No lint/test scripts exist in `package.json`.

**Verdict: CHANGES-REQUESTED** — one blocker (resume session race) + two majors (poisoned currency cache, audit-docs false-pass).

---

## Top 3 must-fix
1. **[BLOCKER]** `orchestrate.ts` `--resume` does not confirm the old Captain process exited before launching `claude --continue` on the same session JSONL — corruption race (§4.1).
2. **[MAJOR]** `currency.ts` caches *failed* registry lookups with `fetchedAt: today()`, poisoning the cache for the full TTL and masking drift (§1.1).
3. **[MAJOR]** `audit-docs.ts` returns `pass: true` when the scorer is missing/crashes (`score === undefined ⇒ pass`); CI goes green having scored nothing (§2.1).

---

## 1) Currency engine (`src/commands/currency.ts`, `src/project-memory.ts`)

### 1.1 [MAJOR] Failed registry lookups are cached as "fresh" → poisons cache, masks drift
`src/commands/currency.ts:191-203` (the `resolve` closure). On a fetch failure `latestNpm/latestPypi` return `undefined`, but the entry is still written with `fetchedAt: today()`:
```ts
const latest = kind === "npm" ? await latestNpm(name) : await latestPypi(name);
refetched++;
entries.push({ name, kind, pinned, latest, ..., fetchedAt: today(),
  note: latest ? undefined : "unresolved (registry lookup failed)" });
```
**Risk:** A transient npm/PyPI outage stamps the failure as fresh. On the next run `isFresh()` (`currency.ts:46`) returns true for **7 days**, so the failed fact is never retried. Worse, downstream:
- `audit-docs` `staleCurrency()` treats `fetchedAt: today()` as NOT stale → the unresolved fact is never flagged, gate still passes.
- `refetched++` counts the failed attempt, overstating "resolved live this run".

This is precisely the "silent catch that masks drift" failure mode. **Fix:** on failure, do not stamp freshness — leave `fetchedAt: ""` (or a short retry window), and don't increment `refetched` unless `latest` resolved. Optionally preserve the prior good `latest` instead of overwriting with `undefined`.

### 1.2 [MAJOR] "Drift" is a raw string compare, not a semver comparison
`currency.ts:130` (`renderVersionsMd`) and `currency.ts:228` (returned `drift`):
```ts
const drift = e.pinned && e.latest && cleanRange(e.pinned) !== e.latest ? "⬆ update" : ...
```
There is **no semver parsing/comparison anywhere** (no semver dep in `package.json`). Consequences:
- Format-only differences flag as updates: pinned `1.2` vs latest `1.2.0` → "⬆ update" (false positive).
- Range residue: `cleanRange` only strips leading `^~>=< ` (`currency.ts:53`), so `>=1.2.3 <2` → `1.2.3 <2`, always "differs".
- **Direction is unknown:** a pin *ahead* of a yanked `latest` dist-tag is labeled "⬆ update", pointing the wrong way.

The file/function comments ("drift diff", and the review's semver/prerelease expectation) oversell what's implemented — it's a coarse "differs" boolean. **Fix:** add a real comparator (semver dep, or a normalized numeric-tuple compare) and only flag when `latest` is strictly greater than the cleaned pin; treat unparseable as "?". At minimum, soften the label to "differs" to avoid misdirection.

### 1.3 [NIT] npm provenance URL ≠ the endpoint actually queried
`currency.ts:198`: the fetch hits `registry.npmjs.org/<name>/latest`, but the stored `source` is `https://www.npmjs.com/package/<name>` (the human page). Provenance should cite the fact's actual source. Human-navigable is defensible, but it's not the queried endpoint. Low impact.

### 1.4 [MINOR] `readManifests` file reads aren't guarded like `package.json` is
`currency.ts:106-117`: the `requirements.txt` and `pyproject.toml` `readFileSync` calls are **not** wrapped in try/catch (unlike the `package.json` block at `:93-103`). An existing-but-unreadable manifest (permissions) throws and crashes the whole `currency` run. **Fix:** wrap both in try/catch and skip on error, matching the npm path.

### 1.5 [MINOR/DOC] Model "currency" is a static in-code map, not live-resolved
`currency.ts:38-42` `MODEL_REGISTRY` is hardcoded; on TTL expiry it just re-stamps `today()` with identical values — there is no live fetch for models. The module header ("facts come from … authoritative live sources") and `CURRENCY_CLAUSE` framing overstate this for model IDs. Honest, but the comment should say model IDs are a curated map refreshed in source, not fetched.

### Positives
- `fetchJson` has a bounded 8s timeout via `AbortController` with `clearTimeout` in `finally` (`currency.ts:57-67`) — no hung requests. ✓
- Cache miss / corrupt cache degrade gracefully: corrupt `currency.json` → `prior = undefined` → full refetch (`currency.ts:170-178`). ✓
- `isFresh` guards invalid dates with `Number.isFinite` (`currency.ts:46-48`). ✓
- `currency.json` is written **with provenance** (per-entry `source` + `fetchedAt`, plus `generatedAt`/`ttlDays`). ✓
- Bounded concurrency (8) on registry fetches. ✓

---

## 2) Audit-docs eval gate (`src/commands/audit-docs.ts`)

### 2.1 [MAJOR] False-pass when the scorer is missing or crashes
`audit-docs.ts:104`:
```ts
const pass = hasClaudeMd && (score === undefined || score >= minScore) && stale.length === 0;
```
`score` is `undefined` whenever (a) the scorer isn't installed (`scorerPath()` → undefined, `:90`), (b) `execFileSync` throws (`:97`), or (c) `parseScore` can't find the `SCORE:` line. In all three, `score === undefined` makes that clause **true**, so a 1-byte `CLAUDE.md` with no scorer present **passes the gate and exits 0**. Since `cli.ts:255` keys CI/daemon on `res.pass`, the gate goes green having verified only "a CLAUDE.md file exists." **Fix:** treat "expected-but-unavailable/failed scorer" as non-pass (or a distinct `inconclusive` that CI maps to fail). Only let `score === undefined` pass when no scorer is *expected* — and even then, prefer failing closed for a CI gate.

### 2.2 [MINOR] Corrupt/missing currency cache silently satisfies the currency clause
`audit-docs.ts:58-60`: a JSON parse error returns `{ stale: [], checked: false }`, so `stale.length === 0` contributes to PASS. A *corrupt* cache should arguably flag as stale/fail rather than pass silently. Missing cache (`checked:false`) passing is acceptable (nothing tracked yet), but the corrupt case masks a real problem. The `currencyChecked` flag is surfaced in `cli.ts`, which softens this — minor.

### 2.3 Positives
- Missing `CLAUDE.md` correctly **fails** (`hasClaudeMd` false → `pass` false). ✓
- Judge ≠ generator: scorer is a separate `claude-md-architect` script, not the scribe. ✓
- `cli.ts:255` sets `process.exitCode = 1` on FAIL — CI/daemon can rely on the exit code. ✓
- Stale-TTL flagging logic is correct for well-formed caches (`age >= ttl`, invalid-date → stale). ✓

---

## 3) Bootstrap scribe + paste-collapse fix (`src/commands/bootstrap.ts`)

### 3.1 [MINOR] Brief files are never cleaned up
`bootstrap.ts:78-82`: each run writes `~/.fleet/briefs/scribe-<base36 ts>.md` and never deletes it. Unbounded growth (small files, and useful for debugging, so low severity). **Fix or accept:** either prune old briefs on spawn, or document that `~/.fleet/briefs` is a debug trail. Note: eager cleanup would be *wrong* here — the worker reads the file asynchronously after spawn, so deleting it immediately would break the scribe. Leaving it is the safer default.

### 3.2 The paste-collapse fix is sound ✓
The core mechanism is correct and well-reasoned (`bootstrap.ts:74-93`):
- Long brief (embeds full `CURRENCY_CLAUSE`) written to a **file**; worker gets a **short pointer task** ("Read `<briefPath>` and execute it exactly…") that submits cleanly past the TUI bracketed-paste collapse. ✓
- Worker is explicitly told to read the file and the absolute path is homedir-based (readable by a same-user local worker regardless of its `cwd`). ✓
- `mkdirSync(..., { recursive: true })` before write; base36 timestamp filename — collision risk negligible. ✓
- Skip logic is reasonable: `present` (≥400 bytes) && !force → skip with guidance; `missing`/`thin` → spawn (`:84-90`). ✓
- Lifecycle: returns the `Agent` so the Captain can watch/steer; scribe is briefed to commit-not-push and stop. ✓

(One forward-looking caveat, not blocking: the absolute homedir brief path assumes the worker shares the orchestrator's filesystem/user. True for local fleet; would break for a containerized/remote worker.)

---

## 4) Captain `--resume` session-safety (`src/commands/orchestrate.ts`) — HIGHEST RISK

### 4.1 [BLOCKER] Resume does not confirm the old process exited before launching `claude --continue`
`orchestrate.ts:58-66`:
```ts
if (opts.resume && prev?.workspaceId) {
  try { closeWorkspace(prev.workspaceId); }
  catch { /* already gone — fine */ }
}
const ws = newWorkspace({ name: `⚓ ${name}`, cwd: homedir(), command, focus: true });
```
where `command = "FLEET_SESSION=… claude --continue --append-system-prompt-file …"` and **both** the old and new Captain run in `cwd: homedir()`. `claude --continue` resumes the most-recent conversation **for that cwd** — i.e. the *same* session JSONL the old Captain holds.

`closeWorkspace` (`cmux.ts:331-333`) is `cmux close-workspace …` via `execFileSync`. That blocks only until the **cmux command** returns — which is when the workspace is torn down / signal issued, **not** when the PTY child (`claude`) has flushed its history file and exited. There is:
- **No existence poll** (`workspaceExists` exists at `cmux.ts:140-147` but is unused here).
- **No settle delay** (the file shows the team knows the pattern — `waitForTerminal`, `submitToClaude` settle delays — but resume uses neither).
- **No process-exit check.**

**Risk:** the new `claude --continue` opens the shared session JSONL while the old `claude` is still flushing it → exactly the two-processes-one-session-file corruption this flow is meant to prevent. The header comment ("the prior workspace should be closed after") and the inline comment ("must be the only process on that session") state the invariant, but the code does not enforce it.

**Compounding [BLOCKER-adjacent]:** the bare `catch {}` swallows *every* close failure, not just "already gone." If `close-workspace` errors for a real reason (cmux daemon hiccup, wrong id), the code proceeds to launch the second `claude --continue` while the first is **still alive** — the worst case, reached silently.

**Fix:**
```ts
if (opts.resume && prev?.workspaceId) {
  closeWorkspace(prev.workspaceId);            // do NOT blanket-swallow
  const deadline = Date.now() + 10_000;
  while (workspaceExists(prev.workspaceId) && Date.now() < deadline) sleepMs(250);
  if (workspaceExists(prev.workspaceId))
    throw new Error("previous Captain workspace did not close; aborting resume to avoid session corruption");
  sleepMs(750);                                // settle: let the PTY child flush + exit
}
```
Notes: `workspaceExists` going false proves the *workspace* is gone, not that the `claude` process flushed — so keep the settle delay, and ideally verify the child PID is gone (e.g. `pgrep -f` on the session) for a hard guarantee. Distinguish already-gone (poll says not-exists) from a genuine close failure rather than catching both.

### 4.2 [MINOR] Stale record with missing `workspaceId` skips close entirely
`orchestrate.ts:62` guards on `prev?.workspaceId`. If the registry record exists but lacks/has a stale `workspaceId` while a process is somehow still live, no close happens and `claude --continue` launches anyway. Edge case; the §4.1 poll-for-exit fix makes it safer regardless.

### 4.3 Positives
- Ordering intent is right: close is sequenced **before** `newWorkspace` (`:58` before `:68`). The defect is the missing *confirmation*, not the order. ✓
- System prompt is composed to a file and passed via `--append-system-prompt-file` (no giant paste). ✓
- Daemon rebind (`daemonStop()` then `daemonStart()`, `:96-103`) is wrapped and non-fatal. ✓

---

## 5) Wiring spot-checks

### `src/cli.ts`
- `bootstrap`/`currency`/`audit-docs` dispatch correctly; `currency` is `await`ed (async), others sync. ✓
- `audit-docs` sets `process.exitCode = 1` on FAIL (`:255`), consistent with `objective --verify` (`:281`) and the bypass path (`:204`). ✓
- `--min` parsed via `Number(str(flags.min))` — note: a non-numeric `--min foo` yields `NaN`, and `score >= NaN` is always false, so audit would FAIL closed (acceptable, but a `Number.isFinite` guard with fallback to 60 would be cleaner). [NIT]

### `src/daemon/policy.ts`
- `evaluate()` cooldown/edge logic is correct: healthy state clears `lastAlert` so future alerts fire; per-agent+condition cooldown honored. ✓
- `waveCompleteMessage` [MINOR]: `auditHint` is only emitted when exactly one project dir is touched (`:38`). With ≥2 projects the nudge says `fleet audit-docs` with no `--cwd`, which would run against the orchestrator's homedir (wrong target). Consider listing each project's `--cwd` or naming them. Low impact (it's a prompt hint, Captain can correct).

---

## Severity ledger
| # | Sev | Location | Issue |
|---|-----|----------|-------|
| 4.1 | **BLOCKER** | `orchestrate.ts:58-68` | resume launches `claude --continue` without confirming old process exited → session-file corruption race; close errors swallowed then proceeds |
| 1.1 | MAJOR | `currency.ts:191-203` | failed lookups cached as fresh → poisons cache 7d, masks drift, miscounts refetched |
| 2.1 | MAJOR | `audit-docs.ts:104` | `score === undefined ⇒ pass` → false-pass when scorer missing/crashes |
| 1.2 | MAJOR | `currency.ts:130,228` | "drift" is raw string compare, not semver — false positives + wrong direction |
| 2.2 | MINOR | `audit-docs.ts:58-60` | corrupt currency cache silently passes |
| 1.4 | MINOR | `currency.ts:106-117` | py manifest reads unguarded → crash on unreadable file |
| 3.1 | MINOR | `bootstrap.ts:78-82` | brief files never cleaned (unbounded `~/.fleet/briefs`) |
| 4.2 | MINOR | `orchestrate.ts:62` | stale record missing `workspaceId` skips close |
| 5/policy | MINOR | `policy.ts:38` | wave nudge drops `--cwd` hint for multi-project waves |
| 1.3 | NIT | `currency.ts:198` | npm provenance URL ≠ queried endpoint |
| 1.5 | NIT | `currency.ts:38-42` | model "currency" is static map; comments oversell "live" |
| 5/cli | NIT | `cli.ts:242` | `--min` non-numeric → NaN (fails closed, but ungraceful) |

**Bottom line: CHANGES-REQUESTED.** The architecture is sound and it typechecks, but the `--resume` flow can corrupt the Captain's own session history (the exact thing it's written to prevent), and two gates fail open (currency caches failures as fresh; audit-docs passes when it scored nothing). Fix the top 3, soften the semver claim, and this is a solid merge.
