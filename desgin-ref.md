---
name: World Mod
description: A payout ledger you can read at arm's length with a phone still warm on your forehead.
colors:
  bone: "#e9e9e6"
  paper: "#f6f6f4"
  paper-sunk: "#e2e2de"
  ink: "#0d0d0f"
  ink-raised: "#1b1b1f"
  foreground: "#131315"
  muted: "#56565e"
  subtle: "#63636b"
  on-ink: "#f4f4f1"
  on-ink-muted: "#a0a0a8"
  mint: "#c7e6da"
  mint-ink: "#1d5b49"
  lilac: "#ded0f3"
  lilac-ink: "#5b3d8c"
  butter: "#f6dcab"
  butter-ink: "#7a5013"
  positive: "#1f6b55"
  caution: "#7a5013"
  negative: "#a8372f"
typography:
  figure-hero:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "52px"
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: "-0.035em"
    fontVariant: "tabular-nums"
  figure-lead:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: "-0.035em"
    fontVariant: "tabular-nums"
  figure-inline:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: "-0.035em"
    fontVariant: "tabular-nums"
  headline:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
  label:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.005em"
  unit:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "max(10px, 0.34em)"
    fontWeight: 600
    letterSpacing: "0.02em"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "normal"
    fontVariant: "tabular-nums"
rounded:
  panel: "30px"
  card: "22px"
  inner: "16px"
  pill: "999px"
spacing:
  gutter: "16px"
  stack: "12px"
  panel-x: "20px"
  panel-y: "28px"
  card-x: "16px"
  card-y: "14px"
components:
  bar-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pill}"
    padding: "6px"
    height: "64px"
  bar-primary-knob:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.pill}"
    size: "52px"
  bar-withdraw:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.pill}"
    padding: "6px"
    height: "64px"
  bar-withdraw-knob:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pill}"
    size: "52px"
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pill}"
    padding: "16px 20px"
  button-paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "12px 20px"
  button-attention:
    backgroundColor: "{colors.butter}"
    textColor: "{colors.butter-ink}"
    rounded: "{rounded.pill}"
    padding: "14px 20px"
  chip-selected:
    backgroundColor: "{colors.lilac}"
    textColor: "{colors.lilac-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  chip-unselected:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  panel-money:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.panel}"
    padding: "28px 20px"
  panel-viewfinder:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.panel}"
  card-paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  card-settled:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.card}"
    padding: "16px 20px"
  card-attention:
    backgroundColor: "{colors.butter}"
    textColor: "{colors.butter-ink}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  dock:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink-muted}"
    rounded: "{rounded.panel}"
    padding: "10px 0 8px"
  dock-disc:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.pill}"
    size: "68px"
---

# Design System: World Mod

## Overview

**Creative North Star: "The Payout Ledger"**

This is a ledger, read outdoors, at arm's length, by somebody who has just taken a phone off their forehead and wants to know what they earned. Everything follows from that scene. The ground is bone — a warm off-white, never pure white, because white next to black strobes in sunlight. The surface is a stack of soft lozenges at a 30px radius, each holding one thing. One figure is quoted at a time, at 600 weight, with a small unit riding its baseline.

It refuses the dark crypto dashboard on purpose: no chart wall, no neon accent, no metric grid, no gradient text. Dark survives in exactly two roles, and in both of them it is a material rather than a theme — the live viewfinder, and the ink cards that hold money that has actually settled. Colour is never decoration here. Three flat pastel fields each own a meaning and are used only where that meaning applies, so a contributor scanning the screen in daylight can tell what a panel is about before reading a word of it.

The world was pinned by a user-supplied reference image (a pastel crypto-wallet UI) rather than chosen by a direction roll, which is why the radii are unusually large and why the palette is a family of flat tints rather than a single accent with neutrals.

**Key Characteristics:**
- Bone ground (`#e9e9e6`), never pure white, never near-black.
- Stacked lozenges: 30px panels, 22px cards, full pills for anything pressable.
- Three meaning-bearing fields — mint, lilac, butter — plus ink for settled money.
- Figures at 600 weight, tabular, tight tracking, with a small unit on the baseline.
- One elevation: a soft offset shadow. Panels take shadow, not border.
- One authored motion moment: a four-step downward settle on arrival.

## Colors

A family of flat, desaturated pastel fields on a warm bone ground, with off-black reserved as a material for money and for live video.

### Primary
- **Mint** (`#c7e6da`, text `#1d5b49`): the task, and the money you can act on. It marks what this take pays, the withdraw bar, the accepted verdict, the record knob, the balance panel. Mint is the colour of a thing you can go and do.
- **Ink** (`#0d0d0f`, text `#f4f4f1`): settled money and the live viewfinder. Off-black rather than true black so the mint beside it does not look punched out. An episode that paid is an ink card; one that did not is paper.

### Secondary
- **Lilac** (`#ded0f3`, text `#5b3d8c`): the model's own reading of you. Task selection chips, the live prediction thumbnail, the acceptance-rate bar, the location opt-in. Anything that is machine judgement rather than money.

### Tertiary
- **Butter** (`#f6dcab`, text `#7a5013`): something needs a hand. Insecure-connection notices, in-take coaching ("tilt down", "move around more"), queued uploads, unrecoverable-key warnings, the offline page. Never celebratory, never an error — a nudge.

### Neutral
- **Bone** (`#e9e9e6`): the page ground and the dock's backing strip.
- **Paper** (`#f6f6f4`): raised surfaces on the bone ground — stat cards, secondary buttons, unpaid episode rows.
- **Paper Sunk** (`#e2e2de`): the recessed track of meters and progress bars, skeleton fill, small inert discs.
- **Foreground** (`#131315`), **Muted** (`#56565e`), **Subtle** (`#63636b`): the three text weights on bone or paper — read, explain, footnote.
- **On Ink** (`#f4f4f1`) / **On Ink Muted** (`#a0a0a8`): the same two roles inside ink cards and the viewfinder.
- **Ink Raised** (`#1b1b1f`): the one step above ink, for a surface layered inside an ink card.

### Status
- **Positive** (`#1f6b55`), **Caution** (`#7a5013`), **Negative** (`#a8372f`): drawn from the fields above so a verdict reads as part of the surface rather than a browser alert dropped on top of it. Negative is used sparingly — the live recording dot, a failed meter segment.

### Named Rules

**The Earned-Colour Rule.** Nothing is coloured in a field it has not earned. Mint means the task or money you can move; lilac means the model's reading; butter means something needs a hand; ink means money that has settled. A panel that is none of those is paper on bone. Audit test: point at any coloured panel and name which of the four meanings it carries — if you cannot, it should be paper.

**The Field-Not-Sprinkle Rule.** A field colours a whole region — a panel, a pill, a card — never a word, an icon, an underline, or a border. There is no accent colour in this system.

**The Contrast Floor.** Verified numerically at finish. Body on bone 15.25, muted on bone 5.98, subtle on bone 4.89, subtle on paper 4.67, mint-ink on mint 5.96, lilac-ink on lilac 5.79, butter-ink on butter 5.28, on-ink on ink 17.62, on-ink-muted on ink 7.48. Every pairing clears 4.5:1. Any new pairing must be measured, not assumed — the fields are light enough that a wrong ink drops below the floor immediately.

## Typography

**Body Font:** Manrope (400/500/600/700), with `ui-sans-serif, system-ui, sans-serif`
**Data Font:** Geist Mono, with `ui-monospace, monospace`

**Character:** A geometric grotesque with a tall x-height and genuinely tight numerals — this world spends most of its type budget on numbers, and Manrope's figures hold a column without jitter. There is no separate display face; size and weight do the work a second family would otherwise do. Geist Mono is scoped, not decorative.

### Hierarchy
- **Figure — hero** (600, 52px, line-height 0.95, tracking -0.035em, tabular): the one number a screen exists to quote. The withdrawable balance; an accepted take's payment. One per screen.
- **Figure — lead** (600, 34px, same treatment): total earned, in the capture header.
- **Figure — inline** (600, 17–24px, same treatment): a figure inside a card — a stat, a per-take amount, the take's remaining seconds.
- **Headline** (600, 38px, line-height 1.05, tracking -0.03em): the landing page's one sentence.
- **Title** (600, 17–19px, tracking -0.025em): screen titles, panel headings, the bounty's name.
- **Body** (400, 14–15px, line-height ~1.6): explanation, reasons, coaching copy. Kept to `max-w-xs`/`max-w-prose`, never full-bleed.
- **Label** (500, 11px, tracking 0.005em, sentence case): the small grey caption that names a figure (`.tag`). Never uppercase.
- **Unit** (600, `max(10px, 0.34em)`, tracking 0.02em, 72% opacity, inherits colour): the rider beside a figure.
- **Data** (Geist Mono, 12px, tabular): addresses, transaction hashes, sensor measurements. Nothing else.

### Named Rules

**The Quoted Figure Rule.** A figure is one weight and one size (600, tracking -0.035em, tabular). Its unit is a small rider on the same baseline at 34% of the figure's size, inheriting the figure's colour at 72% opacity — so a unit on mint reads as mint, never as grey punched into it. Never scale the unit by a second type step; never colour it independently.

**The Cents Knock-Down.** The cents of a dollar amount drop to 62% opacity, because nobody decides anything on the cents. **This is a bone-ground-only device.** On the mint fields the same knock-down falls under 3:1 against its own panel, so figures on mint, lilac or butter stay solid.

**The Tabular Rule.** Every number in this product is compared against another — frame rates, scores, payments. All of them carry `tabular-nums`, via `.figure`, `.tabular`, or `[data-numeric]`.

**The Sentence-Case Rule.** No uppercase labels, no letter-spaced small caps, no kickers or eyebrows. The reference whispers; caps at 11px lose legibility outdoors.

## Layout

A single-column phone layout. Content lives in a centred column capped at `max-w-md` (28rem) for the ledger and result screens and `max-w-lg` for the dock, with a 16px page gutter throughout.

Vertical rhythm is a stack of lozenges separated by 12px (`mt-3` / `space-y-2`–`space-y-3`), with a larger 28px break (`mt-7`) before a new section heading. Panel padding is 20px horizontal and up to 28px vertical when the panel quotes a hero figure; cards run 16px/14px. Small controls sit on a ~10px×16px pill padding.

The capture screen is a flex column that fills the viewport: header, then the viewfinder taking all remaining height, then the primary control in the thumb zone, then the dock. The dock is `sticky bottom-0` on a bone strip with `pb-[max(0.75rem,env(safe-area-inset-bottom))]` — safe-area insets are honoured because this ships as an installed PWA including iOS, and the viewport is locked at `maximumScale: 1` with `viewportFit: "cover"` so a stray pinch never zooms the viewfinder.

There are no breakpoints in the contributor surfaces. The layout is phone-shaped and simply centres on a larger screen; do not add a desktop grid to it.

## Elevation & Depth

Depth is carried mostly by tone: bone recedes, paper lifts, ink is the deepest and heaviest material. Shadow is a single soft, offset lift used to separate paper from bone — it is a light source, not a stack of z-levels. **Panels take shadow, not border.**

Ink panels and the coloured fields (mint, lilac, butter) generally carry no shadow, because their tone already separates them; the exceptions are the viewfinder and the two floating elements that must read as physically above the surface.

### Shadow Vocabulary
- **Lift** (`0 1px 2px rgb(19 19 21 / 0.04), 0 10px 28px -14px rgb(19 19 21 / 0.22)`): the default for a paper surface on bone, and for the viewfinder panel.
- **Lift High** (`0 2px 6px rgb(19 19 21 / 0.06), 0 22px 48px -20px rgb(19 19 21 / 0.3)`): only for something genuinely floating — the record disc straddling the dock, the live prediction thumbnail over video.

### Named Rules

**The Two-Elevations Rule.** There are exactly two shadows. If a surface needs to feel deeper, change its tone (bone → paper → ink), do not invent a third shadow.

**The No-Border Rule.** Surfaces are separated by tone and shadow. Hairlines (`--line`, `--line-strong`, `--line-on-ink`) exist for dividers and for outlined controls on ink, not for boxing a card.

## Shapes

Radii are the loudest thing about this world, and they are deliberately larger than a conventional craft floor allows (12–16px); the pinned brief overrides it.

- **Panel — 30px**: a screen's major regions. The viewfinder, the balance panel, the verdict, the dock bar, the landing page's two large rows.
- **Card — 22px**: a thing inside or beneath a panel. Stat cards, episode rows, notices, on-chain receipts.
- **Inner — 16px**: something nested inside a card, and small tap targets that are not pills.
- **Pill — 999px**: everything pressable, every status lozenge, every meter track, every avatar-sized disc.

Icons are drawn as inline SVG on a 24px viewBox at 1.7–1.9px stroke weight, round caps and joins, `currentColor`. There is no icon font and no glyph substitution.

### Named Rules

**The Pill Rule.** If it can be pressed, it is a full pill — buttons, chips, tabs, toggles, discs. Rectangles with modest corners are surfaces; pills are controls. The only pressable exception is a whole-surface row (the landing page's large ink and paper rows) which stays at panel radius because it *is* a panel.

## Components

### The Knob Bar (signature)

The system's signature control: a full-pill bar with a circular knob inset at its head, straddling the seam between two colours. The bar is 6px of padding around a 48–54px knob, so the knob's own pill sits flush inside the bar's.

- **Start recording:** ink bar (`#0d0d0f`), mint knob, label centred in the remaining width with `pr-[52px]` so the text sits true-centre against the knob.
- **Withdraw:** the same bar in reverse — mint field, ink knob. The reversal is the point: recording and collecting are the same gesture in opposite directions.
- **Disabled:** `opacity-40` (start) / `opacity-60` (withdraw); no colour change.
- Never put a knob bar on paper, and never build one in butter or lilac.

### Buttons
- **Shape:** full pill (999px) in every variant.
- **Ink (primary):** ink ground, on-ink label, 600 weight, ~16px vertical padding. The "do the next thing" button — Record another, Go to capture.
- **Paper (secondary):** paper ground, foreground label, carries Lift. Sits beside an ink button, never alone as a primary.
- **Butter (attention):** butter ground, butter-ink label. Reserved for "something needs a hand" — retry a queued upload, resolve a warning.
- **Ghost on ink:** transparent with a 2px `white/45` border, on-ink label. Used only inside the viewfinder, where a paper button would glare.
- **Hover / press:** `.interactive` — a 200ms ease-out on colour, border, shadow, and 160ms on transform, with `:active { transform: scale(0.975) }` so a press sinks toward the page. Wrapped in `prefers-reduced-motion: no-preference`.
- **Focus:** 2px solid foreground outline at 2px offset, pill-radius; switches to on-ink inside any `.on-ink` region.

### Chips
- **Selected:** lilac ground, lilac-ink label, 600 weight — because a chosen task is the model's framing of the work, not money.
- **Unselected:** paper ground, muted label.
- **Shape:** full pill, ~10px/16px padding, horizontal scroller with a negative page-gutter margin so chips bleed to the screen edge.

### Cards / Containers
- **Corner:** 22px (`card`) inside a 30px (`panel`) parent.
- **Paper card:** paper ground, Lift shadow, no border. The default container.
- **Ink card:** ink ground, `.on-ink` class on the wrapper (which re-targets focus rings), no shadow. Reserved for settled money and on-chain receipts.
- **Field card:** mint / lilac / butter ground, its matching ink for all text, no shadow.
- **Padding:** 16px horizontal, 14px vertical for cards; 20px/28px for panels quoting a figure.

### Meters
A meter is a label and a percentage on one baseline, a 8px pill track in paper-sunk beneath, and a one-line plain-language hint under that. Fill tone is a verdict: mint-ink above 70%, butter-ink above 40%, negative below, paper-sunk when unknown. Minimum fill width is 4% so a near-zero score is still visible as a mark.

### Navigation — the dock
- **Style:** an ink bar at panel radius (30px), sitting on a bone strip, sticky to the bottom of every route on both halves of the product. It is the seam between the contributor's bone world and the buyer's dashboard, so it reads the same from both sides.
- **Record disc:** a 68px ink circle with a 5px bone border, offset `-top-6` so it breaks the bar's top edge — the bone ring is what makes it look cut *out of* the bar rather than stuck onto it. Carries Lift High.
- **Disc colour:** on-ink normally; **mint only on `/c`**, where it means "you are here" rather than competing with the mint record knob already on screen.
- **Tabs:** two, one either side of the disc, with `pr-10` / `pl-10` clearing it. 22px stroked icon over an 11px medium label; the active tab fills its icon at 18% opacity and lifts from on-ink-muted to on-ink.

### The viewfinder (signature)
The live camera is not a video element with a border — it is *the* ink panel of this world, at 30px radius with Lift, and everything the take needs to say is said inside it: the countdown as a 76px figure, the remaining-seconds clock as a paper pill in the top-left, coaching as a butter pill at the foot, the task name over a bottom-up ink gradient.

**This dark surface is a reasoned exception, not a leftover theme.** Light chrome over live video is glare on a phone strapped to someone's head. In this world it reads as the ink card.

When the take ends, the verdict *leaves* the ink card: the result renders on a bone overlay inside the same frame. The camera has stopped talking; the ledger is talking.

## Do's and Don'ts

### Do:
- **Do** pick a panel's colour from its meaning: mint = the task or money you can move, lilac = the model's reading, butter = needs a hand, ink = settled money. Otherwise paper on bone.
- **Do** quote one figure per screen at 52px, and give it a `.tag` label above and a `.unit` rider beside it.
- **Do** use `.figure` for every amount, score, and count, so columns of numbers do not jitter.
- **Do** put a full pill on anything pressable, and reach for the knob bar when the action is the screen's whole purpose.
- **Do** measure any new colour pairing against the 4.5:1 floor before shipping it; the fields are light and a wrong ink fails immediately.
- **Do** put the primary action in the thumb zone directly above the dock.
- **Do** honour `env(safe-area-inset-bottom)` on anything fixed to the bottom — this ships as an installed PWA on iOS.
- **Do** wrap every transition and animation in `prefers-reduced-motion: no-preference`, and start animated elements from a *visible* default so a failed animation never costs someone their balance.
- **Do** scope Geist Mono to addresses, hashes, and sensor measurements. Everything a person *reads* is Manrope.

### Don't:
- **Don't** introduce an accent colour, a gradient fill, or a neon. This world refuses the dark crypto dashboard; the four fields are the whole palette.
- **Don't** paint a border on a panel to separate it. Tone and the Lift shadow do that.
- **Don't** invent a third shadow, or stack z-levels. Change the tone instead.
- **Don't** apply `.cents` on a mint, lilac, or butter ground — the knock-down drops under 3:1 there.
- **Don't** set a label in uppercase or letter-spaced small caps, and don't add a kicker or eyebrow above a heading.
- **Don't** use ink as a background for anything other than settled money, live video, and the dock. It is a material, not a theme.
- **Don't** put a chart wall or a metric grid on a contributor screen. One figure at a time.
- **Don't** shrink the `.unit` below its 10px floor — a rider on a 17px figure was computing to under 6px before it was floored.
- **Don't** add a second animation. There is one authored moment (`.settle`), and adding a second one makes the first stop meaning anything.

---

## Known boundaries

**Scope.** This system was authored for the contributor surfaces (`web/src/app/(contributor)/`, the root landing, `not-found`, `offline`, and the shared dock). The buyer dashboard under `web/src/app/(buyer)/` received a **mechanical class sweep** onto these tokens — the `--background` / `--surface` / `--surface-raised` / `--accent` aliases in `globals.css` exist for exactly that — so it stays legible on the bone ground. It was **not** redesigned, and its compositions are not evidence of this system. Do not read layout, density, or component grammar out of the buyer routes; build new buyer surfaces from the rules above.

**Deliberate override.** `--r-panel: 30px` exceeds the usual 12–16px card-radius floor. This is the pinned brief's central gesture and is intentional. It is not licence to inflate radii further.
