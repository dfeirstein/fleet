# SaaS product UI / dashboards

The ~10 rules that matter most for product UI, dashboards, and app screens, with
numbers. Load this for any SaaS/dashboard/app-screen task. **This is a floor — the
brand brief sets direction and wins any conflict.**

## Core context rules
- **Go disproportionate, NOT 60-30-10:** ~90% tinted-neutral / 8% white / 2%
  accent (Vercel/Linear). 60-30-10 is a landing-page balance; applied to a
  dashboard it produces flat, generic, "balanced" UI. Real product UI is
  intentionally lopsided toward neutrals. Brand color only on the **active tab**
  and primary action; other nav icons stay **gray-500**.
- **Cap dashboard font ~24px max** to preserve data density; max ~6 sizes; ONE
  sans family.
- **Build color in 4 layers** — (1) 4 tinted-neutral background surfaces + 1–2
  borders, (2) ONE functional accent as a full **50–950 / 10-step** ramp, (3)
  semantic red/green/yellow/blue, (4) theming. Tint neutrals **2–3% brand hue**;
  Tailwind: light = **50 bg + 500 accent**, dark = **950 bg + 300 accent**.
- **Charts in OKLCH** (never the brand ramp, never HSL/RGB): lock **Lightness
  ~0.5682** and **Chroma ~0.1136**, increment ONLY **Hue by 25–30** per series —
  the only way to get perceptually equal series brightness (green naturally reads
  far brighter than blue in HSL).
- **Replace raw-number KPI squares** ('Total Clicks: 0') with wide horizontal
  cards carrying sparklines/trend; bar charts → styled donut/fraction readouts;
  country lists → a shaded world map with data points; usage as a donut/fraction,
  not a vague full-width progress bar.
- **Nest corner radii mathematically:** inner = outer − padding (30px outer + 10px
  padding → 20px inner); push iOS corner smoothing to **100%** for squircles.
- **Step responsive grids cleanly 12 → 8 → 4 columns** (desktop/tablet/mobile).
  Pin the **account card to the sidebar bottom** with Settings/Billing in a
  popover — kills AI gradient-initial avatars and declutters nav.
- **Progressive disclosure by default:** start minimal (a search bar), reveal
  dates → filters → results only as intent expands; collapse advanced modal
  options; consolidate links into a menu that animates open (Airbnb search → filter
  → browse is the gold standard).
- **Dark mode: elevate with LIGHT, not shadow** — elevated surfaces go LIGHTER
  (Brightness +4–6, Saturation −10–20 per layer), **4–6% lightness steps** (double
  the 1–3% of light mode), dim text but brighten borders, desaturate accents so
  nothing vibrates. Never invert light mode.
- **No emoji icons, no key:value database dumps, no 1px divider on every row** —
  use whitespace + ONE monochromatic SVG icon set (Phosphor/Lucide).

## Spacing + type (applied to dense UI)
- Lock spacing to a **4/8px grid** (4, 8, 12, 16, 20, 24, 28, 32, then 48, 64);
  set the design-tool nudge from 10px to 8px; never ship 11px/23px. Above ~80px,
  switch to **exponential** steps (200 → 264 → 360 → 488) since 120 vs 128 reads
  identical.
- Reference type scale: **H1 64px / 72px line-height, subtext 20px / 28px, button
  16px / 20px, section gaps 32px.** Headlines >70–80px: letter-spacing −2% to −4%,
  line-height 110–120%; body 0% / ~1.5.
- **Size every icon to the adjacent text's LINE-HEIGHT**, not its font-size (15px
  text at 24px line-height → 24px icon).

## Color hierarchy + system (Kole)
- **Set text hierarchy by calculated lightness, not opacity:** headings ~11% white
  (#1C1C1C), body 15–20% (#2E2E30 / #424242), subtext 30–40% (#59595B / #727272);
  cascade gray-900 → gray-600 → gray-400. A filename must NOT look as important as
  its file size.
- **Build palettes by math** (HSB/OKLCH): per darker step Saturation **+20** /
  Brightness **−10**, and hue-shift **~+20 toward blue/purple** to darken (toward
  yellow/red to lighten) so temperature changes with value. Single OKLCH tinting
  formula (Lightness −0.03, Chroma +0.02, Hue → brand target) re-themes the whole
  neutral system across light AND dark in one move.
- **Tint neutrals, never pure** — GitHub dark #040D21, Studio Rubric light
  #FFF8F0; 2% brand-tinted sidebar anchoring a 100% pure-white content area is the
  Mercury pattern (subtle depth, zero borders).
- **Shadows** ~5–10% opacity, high blur, scaled up only for popovers/dropdowns;
  hue-shift shadows cooler toward blue/purple (not just darker) for real depth.
  Define card edges with ~85% white soft borders or low-opacity shadows — never
  harsh black borders.
- **Semantic colors override the brand:** destructive ALWAYS red (never a purple
  Delete button), green = success/new, yellow = warning, blue = trust; keep red +
  green in every palette even off-brand.

## States, content stress, and process
- **Ship the full state set:** buttons (default/hover/pressed/disabled/
  loading-spinner), inputs (default / focus brand-border / error red-border+text /
  warning yellow). No dead clicks; every interaction gets a visual response. Hover
  = +1 lightness step, active/pressed = −1.
- **Stress-test with the WORST real content** — extremely long names, blown-out
  bright user images, untruncated strings, zero/empty states. Guarantee icon
  contrast over photos with a dark semi-transparent circle/blur behind icons.
- **Pricing logic** (cap at 4 tiers — Free/Standard/Team/Enterprise; top tier
  'Custom'; each strictly costs more; discounts as struck-through prices) lives in
  `references/components.md`.
- **NUKE dead/illogical AI sections from orbit** — never patch a redundant-KPI or
  utility-free 'Current Plan: Free' card; delete and rebuild from human logic.
- **Reverse-engineer proven patterns from Mobbin** rather than inventing layouts —
  make it uniquely yours through micro-interactions, NOT novel layouts.
- **Don't force-snap a custom landing page to a strict 12-col grid** — but DO use a
  strict grid for product/dashboard layouts.
- **Build a design system sized to the team** — lightweight/flexible for startups,
  strict/deep (Material M3) for enterprise — and bend its rules only with intention.

## The divergence to decide (by goal)
**Whitespace-as-luxury vs density-as-craft** is a context flag, not a conflict:
controlled **data density** is right for dashboards (cap font ~24px, ≤6 sizes,
sparkline-rich cards), whereas max whitespace is right for premium/marketing.
Choose density here.
