# Components — buttons, inputs, cards, pricing, icons

The ~10 rules that matter most when building or refining individual interactive
components, with numbers. Load this for component-level work. **This is a floor —
the brand brief sets direction and wins any conflict.**

## Core context rules
- **Ship the full state set on every element:** button
  (default/hover/pressed/disabled/loading-spinner), input (default / focus
  brand-border / error red-border+text / warning yellow). **Hover = +1 lightness
  step, active/pressed = −1.** No dead clicks — every interaction gets a visual
  response; no silent confirmations.
- **Button padding: horizontal = 2× vertical** (e.g. 16px top/bottom, 32px
  left/right). Sizes on the grid: **LG 64px / MD 48px / SM 40px tall**. Rank by
  darkness (primary darkest → secondary 90–95% white → ghost transparent).
- **Card edges from ~85% white soft borders** or **5–10%-opacity high-blur
  shadows** — never harsh black/dark borders. In dark mode use **light** for
  elevation, not shadow.
- **Destructive action ALWAYS red**; semantic green = success, yellow = warning,
  blue = trust — kept in every palette even off-brand. Never a purple Delete button.
- **No dead clicks, no silent confirmations:** a Copy click spawns an animated
  'Copied!' green-check chip (**~#4ADE80**); confirmation moments get deliberate
  craft (dark toast, glowing green check, subtle confetti, distinct primary 'Done'
  vs secondary 'Explore').
- **Icons from ONE monochromatic set (Phosphor/Lucide)**, sized to the adjacent
  text's **line-height** (not font-size) — 15px text at 24px line-height → 24px
  icon. Never OS emoji, never mixed free vector icons. No graphics beat bad
  graphics — default to typography over a cheap icon.
- **Manual hierarchy on conversion components:** oversize the price, shrink the
  '/month' label, show a crossed-out original for a real discount, emphasize what
  the NEXT tier unlocks. Never the '/month' label at the same size as the price.
- **Pricing: max 4 logical tiers** (Free/Standard/Team/Enterprise); each strictly
  costs more; top tier 'Custom'; show discounts as struck-through prices. Never 5+
  tiers, never a higher tier cheaper than a lower one (Standard $2 below Hobby $3),
  never a fixed price on the enterprise/custom tier.
- **Avoid the default card** (white box + drop shadow + icon + translateY(−5px)
  hover, repeated in a rigid grid); prefer video/GIF-backed or content-rich cards
  with positional fan-out. Stress-test with long strings so values never push off
  the card.

## Radii, color, and contrast (from the system)
- **Nest corner radii:** inner = outer − padding (30px outer + 10px padding → 20px
  inner); iOS corner smoothing **100%** for squircles.
- **Generate the accent as a full 10-step 50–950 ramp**, never a single hex: light
  mode rest = **500/600**, hover = **700**, links = **400/500**; dark mode rest =
  **300/400**, hover = **400/500**. Hardcoding one hex reused for button/hover/link
  is a tell.
- **Set text hierarchy by calculated lightness:** headings ~gray-900 (#1C1C1C),
  body 15–20% white (#2E2E30 / #424242), subtext 30–40% (#727272). Two-tier
  contrast: near-black headline + mid-gray copy.
- **Run WCAG on every button** (**4.5:1** text minimum). If brand+white text fails
  (flag **1.55:1 / 1.99:1 / 2.34:1**), apply a luminance darken to **~4.05:1** or
  flip to dark text. Never ship without the check; never eyeball it.

## Motion on components
- Reveal by **clip/mask (overflow:hidden)**, not a flat opacity fade. Two timing
  tiers: **~800ms** gentle/spring for a single load reveal, **~300ms** uniform for
  every interaction/state change. Ease Out for discrete state changes; Linear for
  drag/scroll-scrubbed.
- Pair object entries with a **10°→0°** rotation for a natural wrist-flick arc —
  never a straight linear slide on one axis.
- Micro-interactions YES (Copy → 'Copied!'); flair-for-other-designers NO. Motion
  must add clarity, not decoration.

## Signature upgrades (from raw → crafted)
- Raw-number KPI squares → wide horizontal cards with embedded sparklines.
- Bar charts → styled donut charts. Country lists → shaded world map with data
  points. Vague full-width progress bar → donut/fraction usage readout.
- Account card pinned to the sidebar bottom with Settings/Billing in a popover
  (replaces AI gradient-initial avatars).
- **Progressive disclosure** as default: start minimal, reveal options only as
  intent expands; collapse advanced options.
