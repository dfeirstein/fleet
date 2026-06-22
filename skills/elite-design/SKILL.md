---
name: elite-design
description: >-
  Elite UX/UI & web design craft floor — invoke when building or refining ANY
  website, landing page, UI component, dashboard, or app screen, to push design
  above generic AI defaults. Codified rules (type/spacing/color/motion with exact
  numbers) + an anti-AI-slop checklist + best-in-class references. A craft floor
  that pairs with the brand brief, never overrides it.
---

# Elite Design

A durable, cross-repo **craft floor + anti-AI-slop gate** for any worker doing
design work. It encodes the design DNA of three elite designers (Tim Gabe, Kole
Jain, Sam Crawford, mined from 16 videos) into rules you can apply by math, plus
a slop-linter you run before calling a design done. The goal: produce ELITE
UX/UI instead of the generic, mean-reverted output LLMs default to.

## Philosophy
- **Math over eyeballing.** Every dimension, color step, and timing value is
  *derived* — type scales, the 8-pt (4/8) grid, OKLCH/HSB ramps, WCAG luminance.
  "It looks about right" is the amateur tell all three designers reject.
- **Type + spacing carry the design.** Hierarchy is built from ONE sans family's
  weights/sizes/opacities — not color, icons, or decoration. If a section is weak
  in black-and-white, type-only form, it is weak; fix it there first. Type is
  ~80–90% of the visual layout.
- **One accent, reserved for action.** A single saturated color exists only for
  the primary CTA and critical emphasis. The canvas is near-monochrome neutral;
  brand color never floods backgrounds, headers, or large sections.
- **Subtraction is the craft.** Extreme whitespace, one CTA per section, killed
  nav, deleted copy. Adding badges/colors/elements to "prove value" LOWERS
  perceived quality (cognitive fluency); removing them raises it.

### Critical framing — this is a FLOOR + GATE, never a DIRECTION-SETTER
This skill sets the quality bar and bans the generic tells. It does **NOT** set
direction. **DIRECTION — brand, palette, voice, art direction — always comes from
the project's brand brief, and the brand brief WINS any conflict with a rule
here.**

The active danger: applying every rule below as a flat mandate creates a **NEW
mean** where everything looks like minimalist Linear/Vercel SaaS (oklch palettes,
tinted neutrals, "dominant neutral + one sharp accent"). That is just a more
expensive monoculture. Use this as a floor and let the brand brief push direction.

The three designers genuinely **DIVERGE**, and those divergences are **CONTEXT
FLAGS to choose between by goal — do NOT flatten them into one house style.**
Present each as an either/or gated by intent:
- **Conversion vs brand-aura** — one clear CTA + transparent pricing + repel the
  wrong client (Crawford/Kole, paid-traffic funnel) **vs** de-emphasized CTAs +
  cryptic pure-black editorial layouts that sacrifice sign-up rate to build an
  Apple-like brand (Gabe/Stryds, flagship brand).
- **Motion restraint vs engineered spectacle** — stripping motion as the 2026
  premium move (Crawford) **vs** text-as-mask windowing / color-wipe / 3D Z-axis
  scroll-jacking, but ONLY when engineered + damped (Gabe/flagship).
- **Image-led vs UI-led palette** — eyedrop the accent out of the hero photo, let
  the image dictate color (Gabe) **vs** color is human-chosen math and the hero
  is a stylized real-product UI shot (Kole).
- **Strict grid vs editorial grid-breaks** — strict 12-col for product/dashboard
  **vs** intentional absolute-positioned off-axis breaks for editorial landing.
- **Whitespace-as-luxury vs density-as-craft** — max whitespace for premium/
  marketing **vs** controlled data-density for product UI (cap dashboard font
  ~24px, ≤6 sizes).

Pick the side that serves the goal. The references in `references/` carry these
splits per context.

## When this fires
Any task that builds or refines a **website, landing page, marketing page, UI
component, dashboard, app screen, or design system** — generating HTML/CSS/React,
reviewing a rendered design, or uplevelling an existing page above AI defaults.
If you are placing type, choosing color, spacing elements, or wiring motion, this
floor applies. (For a one-line CSS/copy tweak, just make the edit.)

## How to use it
1. **Read the by-context reference for your task** — `references/landing.md`,
   `references/saas-dashboard.md`, `references/components.md`, or
   `references/premium-brand.md`. Each is an on-demand load of ~10 rules with
   numbers so you pull only what's relevant.
2. **Apply the floor** — use the master checklist below + the per-context rules.
   Derive every value by math; don't eyeball.
3. **Let the brand brief set direction.** Where a rule here conflicts with the
   project's brand brief (palette, voice, art direction, divergence side), the
   **brand brief wins**. This floor is the quality bar, not the creative call.
4. **Run the slop-linter before calling design done** — `references/slop-linter.md`
   is a PASS/FAIL checklist a taste-judge runs against the RENDERED design. It is
   this skill's own proof artifact. Don't claim done until it passes.

## Process — the expensive-AI design pipeline
The operating sequence that makes "expensive-looking" the default, not a lucky accident.
Five ordered moves layered ON TOP of the floor — they sequence the checklist, they don't
replace it; the brand brief still sets direction, this pipeline only governs *how* you
execute it.

1. **Design persona, not a generic prompt** — commit the type scale (numbers), color system
   (hex), and VIBE KEYWORDS naming a real movement ("Swiss / editorial / high-contrast");
   ban vague words ("clean", "professional"). → steps **2–12**.
2. **Bold image mood board, not a final site** — generate "impossible" frames with an image
   model (Gemini / GPT) — overlapping type, broken grid, 3D, editorial — to escape box-builder
   defaults; DIRECTION/mood only, never a literal layout; curate favorites. → folds into step **1**.
3. **Grid rebuild (trace-and-snap) — the secret sauce** — drop the favorite frame in as a faint
   ~30% underlay, rebuild over it, then CORRECT every measurement to grid math (8-pt spacing,
   type-scale sizes: 16 not 13, 20 not 19). Keep the AI's positioning, apply a designer's rigor —
   this snap pass removes the "cheap AI" signal. → steps **4 / 6 / 7** + `references/layout-composition.md`.
4. **Signature component injection — the "expensive" tell** — hand-craft ONE high-effort
   micro-interaction a drag-and-drop builder can't (3D tilt-to-cursor bento card, magnetic/
   expanding cursor, scroll-reveal mask); damped, on-brand, reduced-motion-safe. → steps **17 / 18**.
5. **Taste gate — adversarial, by a DIFFERENT model.** The builder does NOT grade its own
   design (a generator grades itself kindly). After render, a SEPARATE critic — ideally a
   DIFFERENT model lineage — scores the RENDERED output against `references/slop-linter.md`
   + the captured taste rules and reports EVERY issue, even low-confidence. It gates
   quality, never direction — the brand brief still wins. Use vision for *look* (e.g. a
   Gemini image-analysis pass on the screenshot) and a code/interaction/a11y pass (e.g.
   Codex/GPT) for the parts vision can't see. Fixes loop back to the builder and re-render
   until it passes; only THEN does it reach the human, the terminal judge. Principle:
   judge ≠ generator means a different PARTY and ideally a different MODEL — a same-model
   critic shares the builder's blind spots and gives false confidence. The human still
   catches novel slop the models miss; every such catch becomes a NEW rule in
   `references/slop-linter.md` (the list grows; the human-in-the-loop shrinks but never
   hits zero).

**In the Fleet:** the Captain runs Phase 2 (generation) + curates favorites; a worker runs
Phases 3–4, and a SEPARATE critic (a different model) runs the gate — never the builder
grading itself.

## Master checklist (22 codified steps)
The faithful, numbers-intact craft sequence. Apply top-to-bottom; the per-context
references narrow it to ~10 rules for your task.

1. **RESEARCH FIRST** — never open a blank canvas or a template. Pull 3–6
   best-in-class references (Lapa.ninja, Typewolf for landing; Mobbin for product
   UI), sort each as Stylistic (color/type/shape) vs Structural (page sequence),
   and plan to recombine — steal structure, never a whole page. Then generate a
   bold, even "impossible" image-model mood board (Gemini / GPT — overlapping type,
   broken grid, 3D, editorial) as DIRECTION not a final layout, and curate the
   favorites to trace in Phase 3.
2. **STRATEGY BEFORE PIXELS** — define the ONE feeling and the single primary
   action; name the specific audience avatar (copy bold enough to repel the wrong
   client). Wireframe in gray boxes on a 12-col grid to answer what the eye lands
   on 1st/2nd/3rd.
3. **PICK ONE SANS FAMILY** — identify the reference font (WhatTheFont) and source
   a 1:1 free match (Inter, DM Sans, Geist, Plus Jakarta Sans, Montserrat,
   Poppins). Build all hierarchy from its weights/sizes/opacities. Cap a site at
   ~6 sizes.
4. **SET THE TYPE SCALE BY MATH** — base 18–20px × ~1.25 (Major Third); round every
   value to a whole/8-pt pixel (22.5→24). Body 18–20px for long-form (never
   12/14px). Reference: H1 64–102px, subtext 20px, button 16px.
5. **TIGHTEN LARGE TYPE** — headings >70px get letter-spacing −2% to −4% and
   line-height 104–120%; leading TIGHTENS as size grows; body stays 0% tracking /
   ~1.5 leading.
6. **LOCK SPACING TO THE 8-PT (4/8) GRID** — 4,8,12,16,24,32,48,64; switch to
   exponential steps above ~80px (200→264→360→488). No 10/11/15/17/23/25px.
   Section vertical padding ~py-24/py-32 (120px+); grid gutters gap-8–gap-16.
   **Trace-and-snap:** place the chosen mood frame as a faint ~30% underlay, rebuild the
   composition over it, then snap EVERY value to this grid + the type scale (16 not 13,
   20 not 19) — the move that converts AI creativity into designer rigor.
7. **SIZE COMPONENTS ON THE GRID** — buttons LG 64px / MD 48px / SM 40px tall with
   horizontal padding = 2× vertical; icons in fixed steps (24/64/96) sized to
   adjacent text's line-height, not font-size.
8. **BUILD COLOR LAST, IN LAYERS** — (1) 4 tinted-neutral surfaces + 1–2 borders,
   (2) ONE functional accent as a full 50–950 / 10-step ramp, (3) semantic
   red/green/yellow/blue, (4) theming. Inject 2–3% brand hue into all grays; never
   pure #FFF / #000.
9. **RESERVE THE ACCENT FOR ACTION** — saturated brand color only on the primary
   CTA + critical emphasis; secondary surfaces = a 5–10% tint of the accent or
   near-white gray (#F8F9FA). Only the ACTIVE nav item gets accent; the rest stay
   gray-500.
10. **RANK BUTTONS BY DARKNESS** — primary = darkest (dark/black + white text),
    secondary = 90–95% white, ghost = transparent (bg on hover only). Destructive
    is ALWAYS red regardless of brand.
11. **SET TEXT HIERARCHY BY LIGHTNESS** — headings ~gray-900 (#1C1C1C), body 15–20%
    white (#2E2E30), subtext 30–40% (#727272); cascade gray-900→600→400. Two-tier
    contrast: near-black headline + mid-gray copy.
12. **VERIFY EVERY PAIR AGAINST WCAG** — 4.5:1 min for text (7:1 for premium body),
    large headers ~3:1. If brand-on-white fails, darken by luminance or flip to
    dark text. Never eyeball contrast.
13. **HERO = EXACTLY 4 PIECES** — one dominant headline (1–3 words luxury / 5–8
    words SaaS, text-6xl–7xl), a subheadline, one full-bleed image/video/
    interactive-DOM, one CTA. Nothing else competes above the fold. Make the real
    product the hero.
14. **ONE PRIMARY CTA PER SECTION** — pre-set the next step ('Book a Demo', 'Get
    Free Strategy Call →'); demote secondaries to ghost/text; repeat the primary
    down-scroll routing to the IDENTICAL destination.
15. **ONE MONOCHROMATIC ICON SET (Phosphor/Lucide)** — no OS emoji, no mismatched
    free vector icons. No graphics beat bad graphics — default to typography over
    a cheap icon.
16. **STRESS-TEST WITH WORST-CASE REAL CONTENT** — longest names, blown-out images,
    empty/zero states, truncation. Guarantee icon contrast over photos with a dark
    blur/circle behind. Design mobile-first as a content filter (assume >60%
    mobile); body text 16–18px min; wrapper overflow-x:hidden.
17. **SHIP THE FULL STATE SET** — default/hover/pressed/disabled/loading/focus/error
    on every element. Hover = +1 lightness step, active = −1. No dead clicks; every
    interaction gets a visual response; confirmations get a real micro-interaction
    (animated 'Copied!' chip, green check ~#4ADE80).
18. **CONSTRAIN MOTION TO TWO TIERS + UX PURPOSE** — slow ~800ms for the single
    page-load reveal, fast uniform ~300ms for every interaction. Reveal by
    clip/mask (overflow:hidden) not a flat opacity fade; pair object entries with a
    10°→0° rotation. Ban scroll-jacking/heavy-parallax/spinning unless tied to
    genuine 3D storytelling with damped physics. **Plant ONE signature
    micro-interaction** a drag-and-drop builder can't — a bento card tilting in 3D
    toward the cursor, a magnetic/expanding custom cursor, a scroll-reveal mask — as the
    primary "expensive/custom" tell; keep it damped, on-brand, and prefers-reduced-motion-safe.
19. **CUT COPY 50%, THEN 50% AGAIN** — punchy headlines, short sentences, bolded
    keywords; delete any sentence whose removal doesn't make the page worse. Show
    pricing as a real number/minimum; oversize price vs '/month'.
20. **DARK MODE: ELEVATE WITH LIGHT, NOT SHADOW** — elevated surfaces go LIGHTER
    (Brightness +4–6, Saturation −10–20), 4–6% lightness steps (double light mode),
    dim text but brighten borders, desaturate accents so nothing vibrates. Never
    invert light mode.
21. **NUKE DEAD SECTIONS FROM ORBIT** — never patch an illogical AI-generated block
    (redundant KPIs, utility-free 'Current Plan: Free' card); delete it and rebuild
    from human logic.
22. **INSTRUMENT BEFORE LAUNCH, THEN ITERATE** — load <3s on 4G, GA4/heatmaps live
    before launch, hunt drop-off, A/B test. Hand the client CMS keys, never a
    per-edit retainer.

## References (load on demand)
- `references/landing.md` — landing / marketing pages (hero, sequence, CTA,
  conversion vs brand-aura split, allowed engineered moves).
- `references/saas-dashboard.md` — product UI / dashboards (90/8/2, OKLCH charts,
  KPI cards, dark-mode elevation, progressive disclosure).
- `references/components.md` — buttons, inputs, cards, pricing, icons (full state
  sets, darkness ranking, nested radii, semantic colors).
- `references/premium-brand.md` — luxury / flagship (cognitive fluency, Halo +
  Peak-End, extreme whitespace, brand-aura mode).
- `references/slop-linter.md` — the anti-AI-slop PASS/FAIL checklist (all 25 mean
  tells). **Run this against the rendered design before done.**
- `references/library.md` — best-in-class sites/apps to study, by exemplar + context.
- `references/sources.md` — provenance: the 3 designers + 16 source videos (mined
  2026-06-15). Makes this skill auditable + updatable.

### Visual references (VIEW before composing)
`references/visuals/` holds rendered **diagrams** + real captioned **video-frame** examples — the
picture companion to `references/layout-composition.md`. When you compose a layout, **OPEN the
relevant image**, don't just read the prose: type scale, grid line-work, and eye-flow read faster
as a picture than as a rule. Diagrams (`references/visuals/`):
- `type-scale.png` — Major-Third scale, rendered
- `eye-flow-ladder.png` — six eye-flow levels
- `visual-weight-flow.png` — hierarchy as gravity
- `lift-audit.png` — L.I.F.T. audit questions
- `grid-systems.png` — four grids, whitespace
- `proportion.png` — thirds, golden, baseline
- `friction-good-vs-slop.png` — good friction vs slop

Real frames (`references/visuals/frames/`):
- `frame-basic-direction.png` — explicit pointers, level 1
- `frame-layered-paths.png` — main + micro routes
- `frame-flow-disruption.png` — one 45° interrupter
- `frame-temporal-flow.png` — metered scroll pacing
- `frame-break-grid.png` — type escaping grid
- `frame-friction.png` — one focal point
