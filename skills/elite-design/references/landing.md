# Landing / marketing pages

The ~10 rules that matter most for a landing or marketing page, with numbers.
Load this when the task is a landing page, marketing page, or homepage. **This is
a floor — the brand brief sets direction and wins any conflict.**

## Core context rules
- **Hero = exactly 4 elements** — headline / subheadline / one full-bleed visual /
  one CTA. Obsess over the **top half** of the hero disproportionately — the
  verdict forms there (50ms–3s, the Halo Effect) and halos everything below.
- **Headline 1–3 words for luxury, 5–8 for tech/SaaS** at text-6xl–text-7xl (~3–4×
  body). Make the **real product the hero** — interactive DOM or a stylized
  3D-skewed UI shot, never a static PNG, isometric vector, or stock photo.
- **Sequence in 5 canonical blocks:** Hero → USP/Value Prop → Features → CTA →
  Footer. Organize a Figma file as 3 pages: Inspo / Explorations / Design.
- **One primary CTA per section, all routing to the IDENTICAL destination.**
  Pre-set the next step ('Book a Demo', 'Get Free Strategy Call →') — never
  generic verbs ('Click Here', 'Submit', 'Learn More'). Demote secondaries to
  ghost buttons or text links.
- **Strip ALL global nav from paid-traffic landing pages** (one audience, one
  action); never route ads to the homepage. Consolidate the rest of the site into
  an ultra-simple funnel nav — kill 8+ dropdowns (Services/Solutions/Industries/
  Resources/Company/Partners).
- **Place social proof high** — testimonials, client logos, hard metric cards
  ($180M+ revenue, 523 clients, 11 years, 98% retention). Trust badges in the
  footer. The **About page** (the #2 most-visited page) leads with a transformation
  statement + metric cards, never a 'Founded in 2015' timeline.
- **Show price or a 'starting from / minimum'** to filter leads ('Investment:
  $5,000/month minimum'). Never gate price behind 'Book a Call'.
- **Cut homepage copy ~75%** (50%, then 50% again). Punchy headlines, short
  sentences, bolded keywords, written for scanners. Name ONE avatar and repel the
  rest ('e-commerce brands doing $50k+/mo ready to invest $10k+/mo' — repelling is
  a feature).
- **Don't force-snap a custom landing page to a strict 12-col grid.** Extreme
  whitespace (py-24/py-32, 120px+ section padding) reads as confident premium.

## Type + spacing (from the designers, applied to landing)
- ONE sans family; build hierarchy from its weights/sizes/opacities. Match the
  inspiration's word count — don't force a 5-word headline into a 2-word layout.
- Type scale by math: base 18–20px × ~1.25 (Major Third); round every value to a
  whole/8-pt pixel (22.5→24). Body **20px** for marketing long-form (16px floor
  for dense UI). Never 12/14px. Base desktop frames at **1440px** wide (test H1
  ~96px, subtext ~40px there).
- Bind heading size to placement AND scale the gap-to-CTA in lockstep:
  center/hero **160px head → 40px gap**, 50/50 split **120px → 32px**,
  offset/carousel **80px → 24px**, grid/card **48px → 16px**.
- Headings >70px: letter-spacing **−2% to −4%**, line-height **104–120%**; leading
  tightens as size grows. 12-col grid, **20px gutter**, centered max-width.

## Color + assets (image-led OR UI-led — pick by goal)
- Reserve 100% saturated brand color for CTAs + critical emphasis only; keep it
  off backgrounds/headers/large sections. Secondary surfaces = a 5–10% tint of the
  primary, or a near-white gray (#F8F9FA). Don't invent new colors.
- **Image-led (Gabe):** eyedrop the CTA/accent hex straight out of a vibrant
  element of the hero photo (pink sampled from mountains → 'JOIN THE CLUB'). Let
  the image dictate the palette. Aurora glow (duplicate focal asset behind, scale
  up, ~120px layer blur single / ~200px multiple) for a color-matched ambient halo.
  Radial sampled-color contrast plate behind hero text (transparent at center →
  dark image-sampled color at edges) so text pops over busy imagery — never a flat
  scrim.
- **UI-led (Kole):** color is human-chosen math; the hero is a stylized,
  3D-skewed shot of the REAL product UI. Presentation is the trust/conversion
  signal, not feature complexity.
- Verify text/bg WCAG mathematically (black on #8850BC = 3.92:1 FAILS); never raw
  white text on a busy photo without a gradient/plate.

## Allowed engineered signature moves (NOT defaults — gate behind flagship/editorial)
Use only when engineered + damped, when the goal is brand-aura over raw conversion:
- **Text-as-mask windowing** — a large bold headline windows an image/video, then
  scrolls up and gets chopped by an invisible clipped top edge (Drive Capital).
- **Color-wipe text** — two stacked identical layers + an expanding clipped
  container sweep a sharp physical line across; never animate the CSS color
  property (Starfades).
- **Intentional grid-breaks** via absolute positioning — stagger headings/body/
  images off-axis for editorial feel instead of the rigid centered SaaS template
  (Miro, Gleec). Self-drawing SVG data viz (stroke-dashoffset + IntersectionObserver)
  over multi-speed parallax (background y×0.2, content normal, foreground y×−0.5).
- **Brand-aura mode (Stryds/Apple):** de-emphasized CTAs, cryptic pure-black
  editorial voids, floating focal element that fades+scales-down+locks on scroll,
  fixed bottom pill nav (bottom:20px, backdrop-filter blur(10px), border-radius:50px)
  — sacrifices sign-up rate for an elite Apple-like brand.
- **Reveal by masking, not fading:** overflow:hidden / clip so content rises out of
  a hard boundary. Two motion tiers only: **800ms** gentle/spring for the single
  page-load reveal, **300ms** uniform for every interaction. Object entries get a
  **10°→0°** rotation for a natural arc. Loaders ≤1.5–2.0s; mobile body 16–18px min;
  wrapper overflow-x:hidden.

## The divergence to decide (by goal)
**Conversion-first** (Crawford/Kole — paid-traffic funnel): one clear CTA,
transparent pricing, repel the wrong client, CTA pre-sets the next step.
**Brand-aura** (Gabe/Stryds — flagship brand): de-emphasized CTAs, editorial
pure-black layouts that trade sign-up rate for brand. Don't flatten — pick the side
the goal demands.
