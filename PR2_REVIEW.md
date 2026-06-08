# PR #2 Review — `feat/context-engine` (Captain Context Engine & Self-Evolution)

**Reviewer:** independent staff-engineer pass (read-only). **Scope:** 9 commits, Moves 1–7 + docs.
**Build:** `npm run typecheck` (`tsc --noEmit`) → **PASS** (clean).
**Verdict:** ✅ **PASS-WITH-NITS** — the two invariants that matter most (best-effort logging never breaks a command; self-evolution is genuinely human-gated) both **hold**. No blockers. A handful of minor robustness/semantic fixes below.

---

## Critical-invariant findings (the things this PR could have gotten dangerously wrong)

### ✅ Self-evolution is genuinely HUMAN-GATED — confirmed (the single most important check)
- `src/commands/reflect.ts:26-27,63` — `reflect` only ever `writeFileSync`s to `docs/doctrine-deltas/<stamp>-proposal.md`. The path is hard-derived from `import.meta.url` + an ISO-stamp filename; there is **no code path** by which it can write to `orchestrator-doctrine.md`, `SKILL.md`, or any live instruction. It reads the outcome log and emits an inert proposal. ✔
- `src/commands/skill-audit.ts:84-85` — the *only* auto-write in the self-evolution surface. It is gated three ways: (a) requires explicit `--apply`, (b) only touches **captured** skills (`fm.status && fm.capturedAt` guard at `:46-47` of the loop — curated skills like `fleet` have no `status` and are skipped), (c) only flips `provisional → quarantined` — the **trust-removing** direction. It **never promotes to `active`** and **never edits doctrine**. Promotion to `active` happens only through `capture --verify` running an independent check (`capture.ts` → `verify()`), i.e. judge ≠ generator. ✔
- **No autonomous invocation.** `grep` confirms `skillAudit`/`reflect` are called *only* from their `cli.ts` cases (`src/cli.ts:289,303`). The daemon (`policy.ts` change is a **text nudge only** — `src/daemon/policy.ts:34-41`), no Stop/PostToolUse hook, and `digest` never call them. Self-evolution cannot fire without a human typing the command. ✔

**Conclusion:** the design's "additive, gated, reversible; never free-form rewrite of live instructions" invariant is faithfully implemented. *One nuance worth recording* (minor, below): `skill-audit --apply` technically writes to a skill *file*, so the doctrine's prose "scaffold only" is, in code, "scaffold doctrine + flip a captured-skill lifecycle flag in the safe direction." That's within the additive/reversible spirit, but call it out in the PR description so a future reader doesn't assume *zero* skill writes.

### ✅ Best-effort logging never breaks a command — confirmed
- `src/outcomes.ts:53-63` `appendOutcome` wraps **everything** (timestamp, `mkdirSync`, `appendFileSync`) in a single `try/catch {}`. A full/locked/corrupt/permission-denied log is swallowed. ✔
- All four call sites are best-effort by construction and placed so a throw couldn't matter anyway: `spawn.ts:201` (after the agent is built, before `return`), `verify.ts:71` (after `result` computed, before `return result`), `kill.ts:54` (before `remove`), `digest.ts:82` (inside the per-worker loop). None can fail their underlying command. ✔
- `readOutcomes` (`outcomes.ts:65-78`) tolerates a torn final JSON line (`try/catch` per line). ✔
  - **Nit:** the top-level `readFileSync` at `:72` is **not** guarded — an `existsSync`-races-`read` or EACCES would throw. This only affects the *read* commands (`fleet outcomes/reflect/profile`), never a delegation command, so the invariant holds; still, wrap it to fail soft.

---

## Move-by-move assessment

### Move 1 — Outcome log (`src/outcomes.ts`, spawn/verify/kill wiring)
Solid. Append-only JSONL, durable, separate from the mutable registry, best-effort everywhere (see above). Schema is forward-looking (`lessons`, `wavePath` reserved). **No issues** beyond the unguarded read at `outcomes.ts:72` (nit).

### Move 2 — Digest firewall (`src/commands/digest.ts`)
Good shape: raw → `.claude-docs/<project>/waves/<id>/<label>.md`, only a 12-line tail + path returned to the Captain. Disk write and `readScreen` are individually `try/catch`-guarded so a failed capture still returns a digest (`:50-67`). **Minor / nit issues:**
- **[minor] "complete" logged for still-running workers + duplicate on re-run.** `digest()` filters only `a.status !== "dead"` (`:47`) and appends `event: "complete"` (`:83`) for every live worker each call. Calling `fleet digest` mid-wave (or twice) logs "complete" for workers that aren't, and appends duplicate records. *Real risk:* skews any future metric that trusts "complete"; today reflect/profile only count `spawn`/`verify`, so impact is low. *Fix:* record the worker's real `status` is already done — consider gating the "complete" append to terminal statuses, or de-dupe by `(agentId, waveId)`.
- **[nit] Label used unsanitized as a filename.** `join(dir, `${a.label}.md`)` (`:63`). A label containing `/` or `..` would write outside the wave dir. Labels are fleet-assigned today, so low risk; sanitize defensively.

### Move 3 — Gated capture (`src/commands/capture.ts`)
Well done and the strongest move. Three states (`provisional/active/quarantined`), gate runs the check **in the worker's dir via the independent `verify()`** (judge ≠ generator), refuses to overwrite an existing skill, `JSON.stringify`-quotes the task into YAML so colons/newlines can't break frontmatter. CLI surfaces status and sets `process.exitCode = 1` on quarantine (`cli.ts` capture case). **No issues.** (Usage gotcha, not a bug: `--verify npm test` unquoted captures only `npm`; quote multi-word checks — true of the whole flag parser.)

### Move 4 — Reasoning-budget / delegate-now doctrine (`orchestrator-doctrine.md`, `SKILL.md`)
Docs-only, consistent with the prime-directive framing, mechanical ("~1–2 turns then spawn"). **No issues.**

### Move 5 — Recall + profile (`src/commands/recall.ts`, `profile.ts`)
Core is right: roots = `~/.fleet` + `<cwd>/.claude-docs`, filtered by `existsSync`; `rg` else `grep`; output is line hits, capped (`limit`, `--max-count 3`, `maxBuffer` 8 MB). `profile.ts` cwd-match uses `o.cwd === cwd || o.cwd.startsWith(cwd + "/")` — correctly avoids the `/foo`-matches-`/foobar` false positive. **Findings:**
- **[minor] Recall fixed-string safety — `-F` is present and correct, but no `--` argument separator.** `recall.ts:67-68` builds `["-F", …, query, ...roots]`. `-F` blocks regex interpretation (✔ no ReDoS, no crash on special chars/newlines — query is one `execFileSync` arg, no shell). *Gap:* a `query` beginning with `-` (e.g. `-foo`) is parsed by `rg`/`grep` as an **option**, not a pattern → command errors → caught → silently returns *empty* (wrong result, not a crash). The dangerous `rg --pre=<cmd>` argument-injection vector is **not reachable from the CLI** (the `parseArgs` at `cli.ts:39-50` eats any `--`-prefixed token before it can become a positional), which is why this stays *minor* rather than major. *Fix:* insert `"--"` immediately before `query` in both arg arrays — closes the leading-dash correctness hole and hardens `recall()` as a library function for callers that bypass `parseArgs`.
- **[minor] QMD opt-in is correct, but its scope differs from grep's.** Opt-in is genuine: `opts.qmd` defaults falsy and is only set by `--qmd` (`recall.ts:46`); off by default, best-effort with grep fallback. *Subtlety:* `qmd query` searches QMD's **globally registered collections**, whereas the grep core is scoped to the *current* `cwd`'s `.claude-docs` (+ the shared `~/.fleet`). So `fleet recall --qmd` from project A can surface project B's data **if** the user registered B as a QMD collection. It's documented in the doc-comment (`:30-37`) and requires deliberate `qmd collection add`, so it's not a silent leak — but the asymmetry should be stated in user-facing help, or QMD results filtered to the project root, so a Captain doesn't assume project-scoped results.
- **[nit] QMD hit-filter is heuristic.** `recall.ts:58` keeps lines matching `/[\/.]\w+/ && /:\d|\.md|\.jsonl/`. Reasonable for dropping a "no results" sentinel, but it can drop real hits whose format differs or admit noise. Acceptable for an opt-in tier; note as best-effort.

### Move 6 — Memory blocks / state (`src/commands/state.ts`)
Clean. Capped objective/decisions/risks (`MAX_OBJECTIVE/MAX_ITEMS/MAX_ITEM`), `slice(-MAX_ITEMS)` ring, roster derived **live** from the registry (never stale), corrupt-state file → fresh start (`:38-40`). `save()` isn't try/caught, but `state` is an explicit command (no underlying command to protect), so throwing loudly is acceptable. **No issues.** (Auto-occupancy compaction is explicitly deferred — correctly scoped.)

### Move 7 — Skill decay + doctrine-delta scaffold (`src/commands/skill-audit.ts`, `reflect.ts`, `docs/doctrine-deltas/README.md`)
Human-gating confirmed above. Decay logic is sound: report-only by default, `--apply` quarantines only stale (`>= STALE_DAYS=14`) **unused** (`reuseCount === 0`) provisional skills; reversible (trajectory remains in the log). The README codifies "never auto-apply / project-agnostic only / one delta per proposal." **Findings:**
- **[nit] Dead import:** `statSync` imported at `skill-audit.ts:10` but never used (age comes from `fm.capturedAt`). `tsc` passes only because `noUnusedLocals` isn't enabled — remove it.
- **[nit/observation] `--apply` writes a skill file** (status flip). Within design intent (safe direction, gated, reversible) but worth one line in the PR body so "scaffold-only" isn't read as "zero skill writes."

---

## Top 3 must-fix (all minor — none block merge)
1. **`recall`: add a `"--"` argument separator before `query`** (`recall.ts:67-68`). Fixes silent wrong-result on leading-dash queries and hardens the library entry point. (`-F` already correctly prevents regex/ReDoS — keep it.)
2. **`digest`: stop logging `event:"complete"` for non-terminal/duplicate workers** (`digest.ts:47,83`) — gate to terminal status or de-dupe by `(agentId, waveId)` so the trajectory log stays trustworthy for future metrics.
3. **Document QMD's cross-collection scope** (or filter QMD hits to the project root) so `--qmd` recall isn't mistaken for project-scoped, and **guard `readOutcomes`' `readFileSync`** (`outcomes.ts:72`) to fail soft.

**Bottom line:** the human-gating and best-effort-logging invariants — the two that protect the Captain's own runtime — are correctly implemented and verified. Ship after the three minor fixes (or with them tracked as immediate follow-ups). **PASS-WITH-NITS.**
