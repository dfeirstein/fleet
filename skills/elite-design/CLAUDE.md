# elite-design

## What this is
- A **Claude Code skill**, not an app: a cross-repo **craft floor + anti-AI-slop gate** for design work.
- It pushes website / landing / UI / dashboard output above the generic, mean-reverted AI default.
- **Stack**: Markdown content + hand-written HTML/CSS *visual sources*, screenshotted to committed PNGs.
- **No `package.json`, no build step, no in-repo deps** — the renderer resolves Playwright from `$HOME/node_modules`.
- Renderer toolchain: Node **v22.22.2**, Playwright **1.58.2** (see Currency).
- The `scripts/*.py` used to generate this file belong to the `claude-md-architect` skill, **not** this repo.
- `detect_stack.py` reports `language: null` here — that is correct, this is a docs/skill repo.
- **Project map** (real paths):
  - `SKILL.md` → entry point: philosophy, the 22-step master checklist, when-it-fires.
  - `references/landing.md` → on-demand context: landing / marketing pages.
  - `references/saas-dashboard.md` → on-demand context: product UI / dashboards (90/8/2).
  - `references/components.md` → on-demand context: buttons / inputs / cards / full state sets.
  - `references/premium-brand.md` → on-demand context: luxury / flagship / brand-aura.
  - `references/layout-composition.md` → eye-flow ladder, L.I.F.T., grid + proportion.
  - `references/slop-linter.md` → PASS/FAIL anti-slop checklist — the proof artifact.
  - `references/library.md`, `references/sources.md` → best-in-class examples; provenance.
  - `references/visuals/src/*.html` + `_diagram.css` → diagram sources → `references/visuals/*.png`.
  - `references/visuals/src/render.cjs` → Playwright renderer for diagrams (screenshots `.frame`).
  - `references/visuals/frames/src/render.cjs` → renderer for captioned video frames (screenshots `.card`).

## Why it's built this way
- **Floor + gate, never a direction-setter.** It sets the quality bar and bans the generic tells.
- **The brand brief sets direction and WINS any conflict** — palette, voice, art direction.
- Applying every rule flat creates a new minimalist Linear/Vercel monoculture — the documented anti-goal.
- **Math over eyeballing.** Every dimension/color/timing is *derived*: type scale, 8-pt grid, OKLCH, WCAG.
- Don't soften the numbers in a reference — the exact values ARE the value of the skill.
- **The three designers diverge on purpose** — e.g. conversion vs brand-aura, motion restraint vs spectacle.
- Those divergences are *context flags chosen by goal* — never flatten them into one house style.
- **The slop-linter is the proof.** A design isn't done until it PASSes against the **rendered** output.
- **Visuals are generated, not drawn** — they share one theme + one accent via `_diagram.css` for coherence.
- Edit the HTML source then re-render; never hand-edit a `.png`.

## How to work here
- Editing a reference is plain Markdown: keep each ~70–100 lines, numbers intact, bullets scannable.
- Match the existing voice — terse, imperative, number-first; don't dilute the codified values.
- To change a diagram/frame, edit its `references/visuals/src/*.html` (+ `_diagram.css`), then re-render.
- **Run renderers from the repo root** — their `file://` paths are relative:
```bash
# diagrams → references/visuals/*.png  (screenshots the .frame element)
NODE_PATH=$HOME/node_modules node references/visuals/src/render.cjs
# captioned video frames → references/visuals/frames/frame-*.png  (screenshots .card)
NODE_PATH=$HOME/node_modules node references/visuals/frames/src/render.cjs
```

## Verification
There is **no test runner and no build** — verification is render + lint + self-score:
- [ ] Edited a diagram/frame → re-ran the matching `render.cjs` and eyeballed the PNG.
- [ ] Did design work → ran `references/slop-linter.md` PASS/FAIL against the rendered design.
- [ ] Edited this file → self-scored with the bundled auditor and held the floor, e.g.:
```bash
python3 <claude-md-architect>/scripts/audit_claude_md.py CLAUDE.md   # expect grade A
```

## Behavioral Rules
- **Think first**: state assumptions; ask when unclear; surface tradeoffs and simpler alternatives.
- **Simplicity**: the minimum code that solves the task — no speculative features, abstractions, or configurability.
- **Surgical edits**: every changed line traces to the request; match existing style; don't refactor adjacent code.
- **Goal-driven**: define success up front; loop until verified (write the check, then make it pass).

## Currency (do not trust the training cutoff)
- Pinned **2026-06-21** from installed sources, not memory.
- Node **v22.22.2** — resolved via `node --version`.
- Playwright **1.58.2** — resolved via `$HOME/node_modules/playwright/package.json`.
- Designer provenance mined **2026-06-15** — recorded in `references/sources.md`.
- **Maintained**: re-resolve any version / model ID / API shape from an authoritative live source before writing it.
- Refresh this block when the renderer's Node or Playwright version moves.

## Gotchas
- **This dir is a symlink** → `~/.claude/skills/elite-design` points at `cmux-orchestrator/skills/elite-design`.
- Edits therefore land in the **fleet git repo** — commit them there, not in `~/.claude`.
- **Playwright is not a repo dep** — render scripts need `NODE_PATH=$HOME/node_modules` to find it.
- Without that env, `require('playwright')` throws `MODULE_NOT_FOUND`.
- **`render.cjs` screenshots a fixed wrapper** — `.frame` for diagrams, `.card` for frames.
- Renaming that wrapper class silently empties the PNG — the script still "succeeds".
- **PNGs are committed artifacts** — regenerate them whenever you edit the matching `src/*.html`.
- A stale PNG drifts out of sync with the prose it illustrates, e.g. `type-scale.png` vs `type-scale.html`.
- **Never let a rule here override the brand brief** — don't force neutral+one-accent onto a colorful brand.

## References (load on demand)
- `SKILL.md` → the 22-step master checklist + philosophy; start here.
- Per-context rules: [landing](references/landing.md) · [saas-dashboard](references/saas-dashboard.md) · [components](references/components.md) · [premium-brand](references/premium-brand.md) · [layout-composition](references/layout-composition.md).
- Gate + sources: [slop-linter](references/slop-linter.md) · [library](references/library.md) · [sources](references/sources.md).
- External research inputs cited by the skill: https://www.lapa.ninja · https://www.typewolf.com · https://mobbin.com
