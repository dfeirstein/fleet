# Anti-AI-slop linter — PASS/FAIL

A reviewable checklist a taste-judge runs against a **RENDERED** design (screenshot
or live page) before calling it done. Each item is the generic LLM tell ("the mean")
+ the fix. This is the skill's own proof artifact — **the design is not done until
every applicable box passes** (mark N/A only when the context genuinely doesn't apply,
e.g. dark-mode items on a light-only page). It covers all 25 mean tells, then
adds anti-pattern catches.

**Remember the framing:** these ban the generic tells; they do NOT set direction.
The brand brief decides palette/voice/art direction and wins any conflict. Don't
let "pass everything" collapse the design into minimalist Linear/Vercel SaaS — that
is just a new mean.

## The 25 mean tells (all must pass)
- [ ] **No purple/indigo→blue gradient hero** (the 'ShopNow'/default-AI look) — and no
  gradient-initial avatars or neon gradient blobs to "look tech"? *Fix: one
  flat/sampled accent; real product or genuine photo as the hero.*
- [ ] **Brand color does NOT flood 50%+ of the screen** — no full-bleed colored
  nav/header/footer or large saturated background sections? *Fix: near-monochrome
  neutral canvas; accent reserved for action.*
- [ ] **Accent is a full 50–950 ramp, not one hardcoded hex** reused for
  button/hover/link alike? *Fix: 10-step ramp — light rest 500/600, hover 700, links
  400/500; dark rest 300/400.*
- [ ] **Color was NOT model-picked** into bright, clashing, low-cohesion hues (5
  saturated at once, dark-on-dark cards, random #240CAF dumped everywhere)? *Fix:
  color is a human/brand-brief decision, built by math.*
- [ ] **Not 60-30-10 on a dashboard** — disproportionate **~90/8/2** neutral instead?
  *Fix: lopsided toward tinted neutrals (Vercel/Linear).*
- [ ] **No pure #FFF backgrounds / pure #000 text everywhere**, and no harsh black 1px
  borders separating washed-out cards, no 1px divider on every row? *Fix: tint
  neutrals 2–3% brand hue; separate with whitespace; ~85% white soft borders.*
- [ ] **Text hierarchy set by calculated lightness, not opacity vibes** — a filename
  is NOT as dark as its metadata? *Fix: cascade gray-900 → gray-600 → gray-400.*
- [ ] **Body copy is 16–20px, never 12/14px**, and not a dense wall of multi-line
  paragraphs explaining everything? *Fix: 20px marketing long-form / 16px dense UI;
  short scannable graphic copy.*
- [ ] **No system-default typography shipped as-rendered** — explicit line-height +
  letter-spacing set, leading varies by size, H1/H2/body clearly differ? *Fix: tighten
  large type (−2% to −4% tracking, 104–120% leading); leading tightens as size grows.*
- [ ] **No eyeballed spacing** (margin-top:17px, padding:12px 20px) AND no uniform
  gap-8 on every section regardless of context? *Fix: lock to the 8-pt (4/8) grid;
  scale gap-to-CTA with heading size (160/40, 120/32, 80/24, 48/16).*
- [ ] **No OS emoji** (✅🔥👁️📅) as status/action icons, no generic free-tier Flaticon
  vector line icons, no 15-min Canva-tier logo? *Fix: ONE monochromatic SVG set
  (Phosphor/Lucide); no graphics > bad graphics.*
- [ ] **No generic stock photos** ('office high-fives', 'people pointing at laptops'),
  AI studio shots, or isometric vector dashboard illustrations — and no static
  PNG/screenshot hero instead of interactive real-product DOM? *Fix: stylized real
  product UI or genuine/messy real photography.*
- [ ] **No default card** (white box + drop shadow + icon + translateY(−5px) hover)
  repeated in a rigid grid? *Fix: video/GIF-backed or content-rich cards, positional
  fan-out.*
- [ ] **No animation-as-flair** — no load-in slides, scroll-jacking, heavy parallax,
  spinning/bouncing, autoplay 3D (Spline/Rive), 'buttery-smooth' demos to impress
  other designers? *Fix: motion guides/confirms only; spectacle only if engineered +
  damped + 3D-storytelling.*
- [ ] **No opacity-fade-only reveal** (0→1, ~500ms) as the only animation? *Fix: reveal
  by clip/mask (overflow:hidden); object entries get a 10°→0° rotation.*
- [ ] **No multiple competing CTAs** in different bright colors routing to different
  destinations, and no generic CTA verbs ('Click Here', 'Submit', 'Learn More')?
  *Fix: one primary CTA per section that pre-sets the next step, all routing to the
  identical destination.*
- [ ] **Pricing shows a real number, not hidden behind 'Book a Call'** — and pricing
  logic is sound (no higher tier cheaper than a lower one, ≤4 tiers, no fixed price on
  the enterprise/custom tier, '/month' label NOT as large as the price)? *Fix:
  transparent price/minimum; oversize price, shrink '/month', struck-through discount.*
- [ ] **KPIs are not static raw numbers in tiny squares** ('Total Clicks: 0') with no
  sparkline/trend, and no key:value vertical dumps (Name: / Location: / Cost:) reading
  as a raw database table? *Fix: wide cards with sparklines; drop labels the UI implies.*
- [ ] **No text dropped on busy photography without a contrast plate/gradient**, and no
  brand-on-white CTA that fails WCAG (1.55:1 / 1.99:1 / 2.34:1) shipped without a
  check? *Fix: radial sampled-color plate or gradient-to-0%; verify 4.5:1 (7:1 premium
  body) mathematically.*
- [ ] **Dark mode is NOT a math-inverted light mode** — no neon, no vibrating saturated
  chips, no pure-white text, no tiny 1–2% lightness steps, and surfaces get LIGHTER as
  they elevate (not darker)? *Fix: elevate with light (Brightness +4–6, Sat −10–20),
  4–6% steps, brighten borders, desaturate accents.*
- [ ] **Designed with worst-case real content, not perfect dummy data** — long names
  don't overflow, white icons don't vanish on bright photos, strings don't push price
  off the card? *Fix: stress-test longest/blown-out/empty states; dark blur behind
  icons over photos.*
- [ ] **No 8+ dropdown nav** (Services/Solutions/Industries/Resources/Company/Partners),
  no global nav left on a paid-traffic landing page, no ads routed to the homepage?
  *Fix: ultra-simple funnel nav; strip global nav on paid landers.*
- [ ] **Did NOT start in a builder/template on Day 1** — strategy + reference research
  came before any color/layout choice? *Fix: research 3–6 best-in-class refs first;
  define the one feeling + one action.*
- [ ] **Not award-bait avant-garde** where it takes ~10s to figure out what the company
  sells — and Awwwards/Dribbble were used for aesthetics/micro-interactions only, never
  page STRUCTURE? *Fix: clarity is the design; recombine proven structure from
  Lapa.ninja/Mobbin.*
- [ ] **Whitespace is treated as an active structural lever, not wasted space** to
  backfill with text/icons/patterns/decorative fluff? *Fix: ~120px+ section padding,
  gap-8–gap-16 gutters; let elements breathe.*

## Additional anti-pattern catches (from the designers)
- [ ] **One font family** (or a second only with a hard rationale), all sizes from a
  fixed scale, every computed value rounded to a whole/8-pt pixel (22.5→24 — no blurry
  sub-pixel)?
- [ ] **Strict 12-col / 20px-gutter / centered max-width** for product/dashboard;
  intentional grid-breaks only where editorial and deliberate (not accidental off-grid
  misalignment)?
- [ ] **Full state set present** — default/hover/pressed/disabled/loading/focus/error —
  with no dead clicks and no silent confirmations (Copy → animated 'Copied!' green check
  ~#4ADE80)?
- [ ] **Destructive action is red** (never on-brand purple Delete); semantic
  green/yellow/blue kept in the palette even off-brand?
- [ ] **Charts in OKLCH** (lock L ~0.5682 / C ~0.1136, step hue 25–30), not the reused
  brand ramp or hand-picked HSL/RGB with unequal perceived brightness?
- [ ] **Nested corner radii** (inner = outer − padding); shadows ~5–10% opacity high
  blur, hue-shifted cooler — not flat black?
- [ ] **No dead/utility-free AI sections** (redundant KPIs, 'Current Plan: Free' filler)
  — deleted and rebuilt from human logic, not patched?
- [ ] **Mobile**: body 16–18px min, media focal-cropped (not whole-box scaled to
  illegibility), wrapper overflow-x:hidden, loaders ≤2s?
- [ ] **Instrumented before launch** — load <3s on 4G, GA4/heatmaps live, drop-off
  hunted (for shippable production pages)?
