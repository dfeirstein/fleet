# Sources & provenance

This skill's design DNA was mined from **16 YouTube videos by 3 elite designers**.
This file makes the skill auditable and updatable: it records who and what the rules
came from. **Mined 2026-06-15.**

To re-mine or extend: re-watch the videos (e.g. via the `gemini-video-watcher`),
re-run the per-designer → master synthesis, and update the rules + numbers in
`SKILL.md` and the `references/` files, then bump the mined-on date above.

## The 3 designers

### Tim Gabe — landing-page typography + assets, engineered motion
**Core thesis:** elite landing pages are won at the typographic and asset layer,
not the grid. Type is ~80–90% of the visual layout; high-quality assets drive much
of the rest. Restraint differentiates (near-monochrome canvas, single saturated
CTA). Everything is derived mathematically. Never start from a blank canvas —
collect references and recombine the best sections ("Frankenstein" wireframing).
*Image-led palette, strict-grid-plus-editorial-breaks, pro-spectacle-when-engineered,
20px body. (5 videos)*

### Kole Jain — product UI systems, color architecture, micro-interactions
**Core thesis:** UI is not art — it's a functional story guiding the user to one
action, so the SYSTEM (spacing, type, color architecture, states) matters more than
the surface. Elite product UI is deliberately neutral-heavy and disproportionate
(~90/8/2), never 60-30-10. You earn a "designed" feel through math (nested radii,
OKLCH ramps, 8px grid, WCAG luminance) and micro-interactions — never novel layouts,
emoji, or AI-picked color. *UI-led palette, strict grid for product, density-as-craft,
micro-interactions-yes / flair-no. (6 videos)*

### Sam Crawford — premium psychology, cognitive fluency, conversion
**Core thesis:** premium is engineered psychology — deliver a single emotional
payload (calm/confidence/trust) inside the 50ms–2s Halo-Effect window and never break
it. High-end feeling is manufactured by maximizing cognitive fluency: subtraction,
ruthless hierarchy, extreme whitespace, one accent, one CTA, two-tier contrast.
Clarity IS the design. *Conversion-first, transparent pricing, repel the wrong
client, motion-restraint as the 2026 premium move, whitespace-as-luxury, 16px body.
(5 videos)*

## The 16 source videos (by ID)
Watched-counts: Tim Gabe 5, Kole Jain 6, Sam Crawford 5 = 16. Titles are
reconstructed from the mined DNA; the **video ID is the source of truth** — append to
`https://www.youtube.com/watch?v=<ID>` to open.

### Tim Gabe (5)
- `cmSBbnrFGPg` — Landing-page design fundamentals: type scale, the 8-pt grid, and
  the single-CTA / one-accent restraint system.
- `RdHXcv1k_Dg` — Typography-first landing pages: prove every section with type +
  spacing alone before adding color or imagery.
- `NfqdWTfNYKI` — Color & assets for landing pages: sampling the CTA hex from the
  hero image, the Aurora glow, radial contrast plates, WCAG checks.
- `evhZQg2NHfo` — Research & "Frankenstein" wireframing: Lapa.ninja / Typewolf /
  WhatTheFont, recombining best-in-class sections.
- `cocnZubvfFE` — Web animation / motion: reveal-by-mask, the two-tier 800ms/300ms
  timing system, 10°→0° object entries, text-as-mask, engineered scroll-jacking.

### Kole Jain (6)
- `HE4rLEQpiXY` — UI design systems: spacing on the 4/8 grid, nested radii, capping
  font sizes, one sans family.
- `EcbgbKtOELY` — Color architecture in 4 layers: tinted neutrals, the 50–950 accent
  ramp, semantic colors, theming.
- `PDcQJOPby1k` — OKLCH/HSB color math: building ramps by Saturation/Brightness/hue
  shift; perceptually equal chart palettes (lock L/C, step hue 25–30).
- `66oOi9OLMCw` — Dark mode done right: elevate with light not shadow, 4–6% lightness
  steps, brighten borders, desaturate accents (never invert light mode).
- `EOcY3hPMQkk` — Interaction states & micro-interactions: full state sets, no dead
  clicks, the animated 'Copied!' green-check chip, confirmation craft.
- `c1TvOcKdBVE` — Vibe-code teardown / fixing AI-generated UI: nuke dead sections,
  KPI cards with sparklines, pricing logic, stress-testing real content.

### Sam Crawford (5)
- `f2mGqlLLqok` — Premium web design psychology: the Halo Effect, cognitive fluency,
  subtraction, the 50ms–2s verdict window.
- `PKYNTm2m8eA` — Hero & CTA architecture: the exactly-4-pieces hero, one primary
  CTA, CTAs that pre-set the next step.
- `7p-ZPK3GfI8` — Whitespace, type scale & contrast: extreme whitespace as dominance,
  inverse line-height scale, two-tier contrast, WCAG 7:1/4.5:1.
- `DuowDNn3TNc` — Conversion, copy & pricing: cut copy ~75%, repel the wrong client,
  show pricing/minimums, transparent pricing over 'Book a Call'.
- `wCiM8jYE5yg` — Mobile-first, motion restraint & launch: mobile as a content filter,
  stripping motion as the premium move, GA4/heatmaps, CMS handover.

## Master synthesis
The per-designer extractions were fused into `master`: `sharedElitePrinciples`,
`theMean` (25 generic tells → `references/slop-linter.md`), `codifiedChecklist`
(22 steps → `SKILL.md`), `divergences` (the context-flag either/or splits, preserved
across the by-context references), `byContext` (landing / saasDashboard / components /
premiumBrand → the four `references/*.md` files), and `referenceLibrary`
(→ `references/library.md`).
