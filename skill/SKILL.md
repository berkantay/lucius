---
name: lucius
description: Drive the lucius pairing canvas — build rich, self-contained HTML/CSS/JS/SVG one-pagers on ANY topic (architecture diagrams, product one-pagers, sales/CS collateral, design docs, explainers, simulations) as versioned iterations while pairing with a user. Use when the user says "lucius", "put it on the canvas", "new iteration", "one-pager", or wants to review artifact versions.
---

# lucius canvas operator

lucius is a desktop app (Tauri) showing a canvas the user watches while you pair.
You drive it with the `lucius` CLI (this skill's directory — invoke as `"$SKILL_DIR/lucius"` or put it on $PATH). Each push is an immutable **version**; the user scrubs history in the app. Comments are voice notes anchored to versions.

The canvas renders full HTML documents with inline CSS, JavaScript and SVG. It
is topic-agnostic: an architecture explorer, a product one-pager for the sales
or customer-success team, a post-mortem, an explainer with a live simulation —
anything that fits on one rich page. Treat every iteration as a real artifact.

**REQUIRED: read `design.md` in this skill directory before authoring any
artifact.** It is the taste layer — the lucius monochrome house style (ink on
paper, ink as the only accent, tight radii, typography-led hierarchy), the anti-slop list,
the component mindset, and the pre-render self-review. An artifact that
ignores it is a defect even if the content is correct.

## Two artifact modes — pick before writing

**Document mode** (default — explainers, product briefs, specs, write-ups,
post-mortems). This is the tdoc explainer recipe, copied from their real docs
(e.g. `frontier-training-explained`, `integrations-architecture`). Follow it
structurally, not loosely:

- **Card narrative.** The doc is a sequence of `.card` sections (white,
  1px border, radius ~12px, subtle shadow) on a warm paper background
  (`#f7f5ef`-family). Each card = ONE concept, with: an eyebrow pill label
  (uppercase mono, ink on wash, e.g. "THE WHOLE THING IN ONE LINE", "STAGE 2 ·
  THE SWITCHBOARD"), an h2, real prose, and its OWN diagram or visual.
  One diagram per card — not one diagram per doc.
- **Progressive zoom.** Card 1 is the whole system as a numbered pipeline
  (circled 1-2-3-4-5 stages, SVG). Every following card zooms into one stage
  in order. The reader never wonders where they are.
- **Compare with mini-grids.** Alternatives/branches go in a `grid2` of mini
  cards (title + 2-line description, ★ or badge on the recommended one).
- **Recap table.** End with a table that restates every component in one row:
  plain name | what it does | real/technical name. This is where both
  audiences meet, and where accuracy is auditable.
- **Receipts.** Sections that describe a real system state facts with their
  real names ("with receipts"); the closing note records what the doc was
  grounded in and the scan date.
- **Ambient motion.** Flow edges in diagrams animate always-on (dashed
  `stroke-dasharray` + `@keyframes dash` offset), state indicators blink
  subtly. Motion lives INSIDE the diagrams; scroll reveals and one optional
  guided "watch it travel" run are extras, not the substance. All of it
  behind `prefers-reduced-motion`.
- **Tokens.** `:root{--ink;--mut;--paper;--line;--wash}` — warm neutrals
  only, ink as the accent: eyebrows and key terms are ink on wash, the live
  element is solid ink. Wrap: `max-width: 840px`.
  System fonts. h1 ~30px −0.02em; card h2 ~21px; card prose ~15.5px/1.6.
- **Substance bar.** A real explainer runs 8-10 cards and ~15-25KB of HTML.
  If the doc has fewer than ~6 sections or one lonely diagram, it is too
  thin — add the missing stages, comparisons, and the recap table.

**Canvas mode** (the artifact IS the interface: architecture explorers,
simulations, clickable prototypes, dashboards). Go full-bleed with the house
tokens from `design.md` (strictly monochrome, ink as accent), and add the
interaction the subject calls for — click-to-inspect, hover highlighting,
animated flows, keyboard navigation.

## Projects (tabs)

The app has project tabs — each an independent workspace with its own version
history and comments, backed by SQLite. Scope every command with `-p <project>`
(or `LUCIUS_PROJECT` env); unscoped commands hit the `default` project.
`lucius projects` lists tabs; `lucius new-project "<name>"` creates one and
prints its id. When pairing on a named topic, create/use a project for it
instead of piling everything into `default`.

## Workflow

1. `lucius ping` — confirm the app is running. If not, ask the engineer to launch lucius.
2. Write a **self-contained** HTML file (inline CSS/JS/SVG — no external URLs) to a temp path.
3. `lucius render /path/diagram.html "short label"` — it appears on the canvas instantly and becomes the new latest version (e.g. `v4`).
4. Iterate: each `render` is a NEW version. Never try to mutate an old one — that's the point.
5. `lucius comment "note text" v4` — record decisions and voice notes as you go.
5b. `lucius status working "drafting v5"` when you START on a session, update the
   detail per phase (searching/solving/composing/shaping), and ALWAYS
   `lucius status idle` when done — it drives the live orb the user (and their
   team, on published docs) watches.
6. `lucius state` — versions + comments as JSON. `lucius html v2` — read back an old iteration. `lucius focus v2` — make the app show a version while discussing it.

## Truth rules (non-negotiable)

- **Ground before you write.** When the artifact describes a real system, scan
  the actual repo/docs FIRST and write only what the scan supports. Record in
  a `lucius comment` which sources informed the artifact.
- **Simplify the vocabulary, never the system.** For non-technical audiences,
  rename components in plain terms ("router" → "the switchboard") — but if the
  system has N major moving parts, the diagram shows N. Omitting a real
  component (a router, a gateway, a queue) is an error, not a simplification.
- **No hand-rolled facts.** No invented numbers, quotes, capabilities, or
  integrations. If a claim can't be traced to a source, verify it or leave it
  out — and say so in the comment. Features marked planned/roadmap in the
  source are labeled as such or excluded, never presented as shipped.

## Artifact conventions (both modes)

- **Self-contained, always.** One full HTML doc, everything inline. The iframe is
  sandboxed (`allow-scripts`): inline `<script>` runs, but assume no network and
  no parent access — never reference CDNs, webfonts, or external images.
- **Write real content.** A one-pager is words first: a title that states the
  thesis, real sections, real numbers, real names. Never lorem, never
  placeholder bullets. Match the register to the audience (an exec skims, an
  engineer inspects).
- **Motion is part of the artifact.** Ship purposeful animation by default:
  an animated flow through the diagram (a packet traveling the real path),
  staged reveal of sections on scroll, hover/click highlighting of connected
  elements. Motion must point at meaning — never decoration for its own sake —
  and every animation respects `prefers-reduced-motion` with a static or
  text fallback.
- **Responsive.** `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  fluid widths, no hardcoded pixel dimensions on images/SVG (`max-width: 100%`),
  tables and code blocks in `overflow-x: auto` wrappers.
- **Interactive where it earns its place.** Sliders, click-to-inspect, animated
  flows — if the prompt implies a model or simulation, build the live thing.
  Respect `prefers-reduced-motion`. What's interactive should look interactive.
- **Stay coherent across iterations of the same doc.** Keep palette, layout
  language, and voice stable version to version so the user can diff by eye;
  change them only when the change is the point of the iteration.
- Label every meaningful arrow/edge in diagrams. Fewer, clearer elements over
  exhaustive detail.

## Selection — "this thing here"

The app has a **Select** mode: the user clicks an element in the rendered
artifact and it becomes the current selection (CSS selector + tag + text
snippet, scoped to project/version). When the user says "this", "here",
"what I selected", "drop a comment on that":

1. `lucius selection` — read what they're pointing at (null if nothing).
2. React to it: `lucius comment "<note>" <version-id>` (the comment's anchor
   field carries the selector when set via MCP), or rework that element in
   the next iteration.
3. Selections go stale — re-read before each use rather than caching.

## MCP server

The app also serves MCP (Streamable HTTP) at `http://127.0.0.1:7317/mcp`
(fixed port when free; check `server.json` port otherwise). Register once:
`claude mcp add --transport http --scope user lucius http://127.0.0.1:7317/mcp`.
Tools: `get_selection`, `list_projects`, `get_state`, `render`, `add_comment`
(supports `anchor` selector), `focus`, `get_version_html`. MCP and the CLI hit
the same store — use whichever is available.

## Sharing, invites, and reacting to web comments

Published docs support members: `lucius -p <proj> share --private --add <gh-user>`
limits viewing/commenting to invited GitHub logins (worker-side gate with a
branded sign-in page); `--link` makes it link-visible again; `lucius acl` shows
current state. The app's Publish dialog has the same controls.

When web comments arrive (they merge into `lucius state` within ~60s, author
"<login> (web)"), address EVERY one: fix it in the next iteration or explain,
then `lucius -p <proj> reply <comment-id> "<what you did>" applied|partial|question`
— this posts an agent reply on the published page and stamps the status emoji,
exactly like tdoc's comment loop.

## Auth plumbing (handled by the CLI)

The app writes `~/Library/Application Support/ai.glorya.lucius/server.json`
(`{port, token, pid}`) on every launch and serves HTTP on `127.0.0.1:<port>`.
All routes except `/api/ping` need `authorization: Bearer <token>`. The CLI
re-reads that file on every call — never cache the port or token yourself.
