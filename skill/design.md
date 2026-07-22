# lucius design system — read this BEFORE writing any artifact

You are the design lead, not a template engine. Every artifact gets a point of
view, pitched at what the content calls for. This file is the taste layer; the
SKILL.md recipes (card explainer, canvas mode) are the structure layer. Both
apply.

## The house world: black and white

lucius is a monochrome product. Artifacts live in the same world as the shell:
**ink on paper, hierarchy through typography and spacing, color almost never.**

```css
:root{
  --paper: #F7F5EF;   /* warm paper — page ground */
  --card:  #FFFFFF;   /* raised surface */
  --ink:   #1D1B17;   /* warm near-black — text, strokes, marks */
  --mut:   #6F685C;   /* secondary text — warm grey, never #999 */
  --line:  #E7E1D4;   /* hairlines, borders */
  --wash:  #F0EFE9;   /* recessed surface (code, quotes, insets) */
  --signal:#C2410C;   /* THE one accent — see budget below */
}
```

- **Neutrals are chosen, not defaulted.** All greys carry the warm bias above.
  Pure #808080/#CCCCCC reads unconsidered — never use it.
- **The signal budget:** `--signal` appears in at most THREE kinds of places
  per artifact: (1) the eyebrow/section labels, (2) the single live/animated
  element (packet, pulse, active state), (3) `<b class="k">` key terms in
  prose. If you're about to use it for a fourth thing, remove one first.
  A fully monochrome artifact is always acceptable; a colorful one never is.
- **Depth is the shell's ladder:** paper → card (1px `--line` border, radius
  14–18px, shadow no stronger than `0 1px 0 rgba(0,0,0,.02)`) → wash insets.
  No colored zones, no tinted section backgrounds, no gradients — zone
  identity comes from position, dashed hairline boxes, and labels.

## Typography does the work color can't

- System stacks only: `system-ui` for prose, `ui-monospace` for identifiers,
  data, paths, and eyebrow labels. The PAIRING is the craft: mono for
  machine-things, sans for human-things — applied consistently, it reads as
  a designed system.
- State a scale and stay on it: h1 30/1.15 −0.02em · h2 21/1.25 −0.01em ·
  prose 15.5/1.6 · captions 12–13 · labels 10–11 uppercase +1.5–2.5px
  tracking. Weight jumps ≥ 200 between levels; never adjacent weights.
- Prose measure ≤ 70ch. `text-wrap: balance` on headings.
  `font-variant-numeric: tabular-nums` wherever digits align.
- Hierarchy test: squint. If you can't tell heading from label from prose
  with the text blurred, the type scale is too timid.

## The anti-slop list — never ship these

- Stat-tile rows ("3 ways · 7 services · 100%") unless each number is real,
  sourced, and the row earns its place better than a sentence would.
- Chip/badge clouds as decoration. Chips only for true enumerable sets.
- Numbered markers (01/02/03) on content that isn't actually a sequence.
- Emoji as section markers or bullets. Icons that merely restate the label.
- Gradient anything. Glassmorphism. Drop shadows above the house ladder.
- `border-radius` soup — pick 6–8px (small) and 14–18px (cards); nothing else.
- Centered everything. Center a hero line at most; content is left-set.
- Generic "card with icon + title + two lines" grids — if every cell has the
  same shape and none would be missed, the section is filler.
- Cream + serif + terracotta, near-black + acid green, purple-blue gradient
  hero — the recognizable AI-default looks. The monochrome house style exists
  precisely so we never reach for them.

## Component mindset: every element encodes something true

Before styling any component, name its job in one sentence. If the job is
"look organized," delete it and write a sentence instead.

- **Structure is information.** A mini-card grid exists because the items are
  genuine alternatives. A table exists because rows share attributes. A
  timeline exists because order matters. Otherwise: prose.
- **State lives in form, not color.** Solid vs outline, filled vs hollow dot,
  weight, position — monochrome forces this, and it's better: it survives
  grayscale printing and colorblindness by construction.
- **Interactive things look interactive** (cursor, hover weight/outline
  shift); static things never do. Nothing hovers that doesn't respond.
- **Diagrams:** boxes carry ≤ 3 lines (name, role, one detail); every edge is
  labeled with real transport; node names are real names. Stroke hierarchy:
  primary flow 1.4px solid, secondary 1.1px, zone boxes 1px dashed. Prefer
  fewer, bigger, truer boxes.
- **Charts:** SVG, quiet hairline grid, emphasized endpoint or delta, real
  numbers only, axis labels in mono 10px. No chart without a source.

## Sleek monochrome — the interface ground (distilled from the registries)

Reading docs use the warm paper world above. **Interface-mode artifacts**
(dashboards, explorers, tools) may instead use the pure-neutral ground the
best shadcn registries share (shadcn neutral, Fluid Functionalism, Geist):

```css
:root{
  --bg:     oklch(1 0 0);        /* pure white ground */
  --ink:    oklch(0.145 0 0);    /* near-black */
  --solid:  oklch(0.205 0 0);    /* filled buttons/chips — value, not hue */
  --mut:    oklch(0.556 0 0);    /* secondary text */
  --wash:   oklch(0.97 0 0);     /* recessed surface */
  --hair:   rgb(0 0 0 / 0.07);   /* hairlines — translucent, not grey */
}
```

What actually makes these registries read "sleek" — copy the moves, not the look:

- **Contrast is the accent.** Monochrome pops through value jumps: near-black
  solid fills for the primary action/chip, everything else outline or ghost.
  No hue needed; the signal budget still applies on top.
- **Hairlines are translucent black** (`rgb(0 0 0 / .06–.08)`), never a grey
  hex — they sit correctly on every surface level automatically.
- **In-between weights.** Fluid tunes Inter to wght 450/550, not 400/600 —
  labels feel machined instead of bolded. With system fonts, approximate:
  500 for labels + slight tracking, 600 reserved for real emphasis.
- **Data is mono and tabular, always** — ids, counts, timestamps, port
  numbers in `ui-monospace` with `tabular-nums`; uppercase micro-labels at
  10–11px with +1.5–2px tracking. This one habit does half the sleekness.
- **Motion is critically damped** — 80–160ms, zero bounce, settles exactly
  (Fluid's spring tokens). Interface artifacts never wobble; save the
  personality for the one ambient/live element.
- **Two radii, one shadow step.** Registries feel tight because nothing
  varies without meaning: 6–8px controls, 14–18px containers, and at most
  one shadow level above the hairline.

## Motion has a job (fluid-functionalism rule)

Every animation points at something: a packet tracing the real path, a pulse
on the one live element, a staged reveal that paces reading. Springy and
subtle beats long and showy. If you can't say what a motion explains, cut it.
Everything behind `prefers-reduced-motion` with a static fallback.

## Process — do this every time

1. **Plan before HTML** (5 lines, in your head or a comment): subject + one-
   sentence job of the page · treatment (utilitarian/editorial) · where the
   signal budget goes · the one bespoke component this content deserves ·
   what you will NOT include.
2. Build with the house tokens. Real content only.
3. **Self-review against the anti-slop list**, then the squint test, then the
   truth rules. Delete one decorative element before shipping — there is
   always one.
