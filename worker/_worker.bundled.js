// tdoc Cloudflare Worker — published view + GitHub Device Flow auth.
//
// Bindings (wrangler.toml):
//   DOCS   — R2 bucket (key: docs/<slug>/v<N>/index.html)
//   META   — KV namespace
// Vars:
//   GITHUB_CLIENT_ID — hardcoded "Ov23liZ1UAGOchvKPmlS"
// Secrets:
//   TDOC_UPLOAD_TOKEN — shared secret for /api/upload from `tdoc publish`
//
// IMPORTANT: This file contains a placeholder string `__TDOC_OVERLAY_JS__`.
// The publish script reads server/overlay.js and replaces that placeholder
// inline before deploy, producing worker/_worker.bundled.js. Do not deploy
// worker.js directly — the overlay would be missing.

const OVERLAY_JS = "// tdoc overlay — single-file design.\n// Sections are demarcated with `// ========== Name ==========` headers so the\n// file reads like several concatenated modules. Each section depends only on\n// the ones above it (and on `state`). No section reaches sideways.\n//\n// External contract preserved verbatim:\n//   - Endpoints: /api/comments, /api/reactions, /api/auth/device/start,\n//     /api/auth/device/poll, /api/auth/logout, /d/<slug>/v/<n>/export\n//   - Globals: window.__tdocCopyDocMd(includeComments), window.__tdocCopyCommentMd(id, btn)\n//   - Body classes: tdoc-has-comments, tdoc-narrow\n//   - Keyboard: ⌘/Ctrl-Enter submits, Esc cancels.\n//\n// Highlight rendering: CSS Custom Highlight API (CSS.highlights). One named\n// highlight `tdoc-pending` for the in-flight selection, and one\n// `tdoc-anchor-<id>` per saved comment. This replaces the legacy\n// surroundContents/extractContents path that produced empty yellow bars when\n// the selection crossed block boundaries. A minimal single-textnode <span>\n// fallback runs on browsers without `CSS.highlights`.\n\n(function () {\n  // ========== Config & DOM setup ==========\n  const cfg = window.__TDOC__ || {};\n  const { slug, version } = cfg;\n  const mode = cfg.mode || 'local';\n  const isPublished = mode === 'published';\n  const isFork = mode === 'fork';\n  const isLocal = mode === 'local';\n  // Fork mode renders the doc read-only with comments mirrored from the\n  // embedded #tdoc-fork-comments JSON. No /api calls, no auth, no publish.\n  // The original published slug is in cfg.originalSlug so we can label it.\n  let identity = cfg.identity || null;\n  let isOwner = !!cfg.isOwner; // true only for the configured TDOC_OWNER\n  if (!slug) return;\n\n  const HIGHLIGHT_API = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';\n\n  // Phones need this or they render at a virtual ~980px viewport.\n  if (!document.querySelector('meta[name=\"viewport\"]')) {\n    const m = document.createElement('meta');\n    m.name = 'viewport';\n    m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';\n    document.head.appendChild(m);\n  }\n\n  // ========== UI selector registry ==========\n  // One source of truth for \"is this part of the tdoc overlay UI?\".\n  //   UI_CONTAINERS — top-level overlay regions: bar, popups, comment column,\n  //                   margin cards, modals, footer. Use these when finding the\n  //                   doc's article element or stripping the overlay from a\n  //                   clone for export.\n  //   UI_ALL        — UI_CONTAINERS plus per-element decorations (anchor marks,\n  //                   outlines, hover affordances, menus). Use this for event\n  //                   delegation guards (\"did the user click *our* chrome?\").\n  const UI_CONTAINERS = '.tdoc-bar, .tdoc-oldver-strip, .tdoc-popup, .tdoc-margin-comment, .tdoc-modal-bg, #tdoc-comment-layer, .tdoc-footer';\n  const UI_ALL = UI_CONTAINERS + ', .tdoc-anchor-mark, .tdoc-element-outline, .tdoc-hover-outline, .tdoc-comment-pill, .tdoc-emoji-picker, .tdoc-secondary-menu';\n\n  // ========== Geometry helpers ==========\n  // Position `box` as an absolutely-positioned overlay around `el`, inflated\n  // by `inset` pixels on each side (default 3 → a 3px-wide outline ring).\n  function positionOutlineAround(box, el, inset = 3) {\n    const r = el.getBoundingClientRect();\n    box.style.top = (window.scrollY + r.top - inset) + 'px';\n    box.style.left = (window.scrollX + r.left - inset) + 'px';\n    box.style.width = (r.width + inset * 2) + 'px';\n    box.style.height = (r.height + inset * 2) + 'px';\n  }\n\n  // ========== Styles ==========\n  // Each logical group is one comment block; rules within a group are tightly\n  // packed. The narrow visual mode lives at the bottom and overrides base.\n  const css = `\n  /* Layout */\n  /* Default: text is selectable everywhere in the document body, so users\n     can highlight prose inside any container (including custom-div-wrapped\n     artifacts like transcript panes). UI chrome opts out explicitly via\n     .tdoc-* selectors below. Media artifacts (img/svg/canvas/video) are\n     non-selectable by their nature so they don't need an exception. */\n  body { padding-top: 44px !important; padding-bottom: 24px; -webkit-user-select: text; user-select: text; }\n  body .tdoc-bar, body .tdoc-bar *, body #tdoc-comment-layer, body #tdoc-comment-layer *, body .tdoc-hover-outline, body .tdoc-comment-pill, body .tdoc-emoji-picker, body .tdoc-secondary-menu, body .tdoc-anchor-mark.tdoc-anchor-mark-element, body .tdoc-drag-marquee, body .tdoc-modal, body .tdoc-modal * { -webkit-user-select: none !important; user-select: none !important; }\n  body .tdoc-modal .code, body .tdoc-modal textarea, body .tdoc-modal input { -webkit-user-select: text !important; user-select: text !important; }\n  /* Reserve the 320px comment column on the right. The article centers\n     itself inside the remaining (viewport - 320px) space via margin auto\n     (applied below in :where()). Adding a left padding keeps it from\n     hugging the screen edge on wide windows. */\n  body.tdoc-has-comments:not(.tdoc-narrow) { padding-right: 320px !important; padding-left: 80px !important; }\n  body.tdoc-narrow { padding-right: 0 !important; }\n  /* Center the article container in the reading column. :where() so any\n     doc-defined margin wins. Applies only on wide layouts; narrow mode\n     uses the full body width via the drawer. */\n  body:not(.tdoc-narrow) :where(body > .wrap, body > main, body > article, body > .content, body > .container) {\n    margin-left: auto !important;\n    margin-right: auto !important;\n  }\n  /* The body right-padding reserves space for the comment column. The\n     article centers itself naturally inside the remaining (viewport minus\n     320px) space via its own margin auto. As the window shrinks, the symmetric\n     margins shrink with it; once they hit the article's min width, narrow-mode\n     takes over and the drawer kicks in. */\n  /* ========== Default doc template (single typography template) ==========\n     One canonical look for every tdoc doc: same font stack, sizes, spacing,\n     headings, lists, code, tables, quotes. Wrapped in :where() so a doc that\n     truly needs a different aesthetic can override per element. Future\n     templates would live alongside this block, switched by a body class. */\n  /* Default template, modeled after Claude Code's markdown rendering.\n     Readable, system-fonts, rounded-cell tables, circle task checkboxes. */\n  :where(body) {\n    font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n    font-size: 17px;\n    line-height: 1.6;\n    color: #1a1a1a;\n    background: #fff;\n    text-rendering: optimizeLegibility;\n    -webkit-font-smoothing: antialiased;\n  }\n  :where(body h1) { font-size: 38px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 20px; color: #1a1a1a; }\n  :where(body h2) { font-size: 27px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; margin: 44px 0 14px; color: #1a1a1a; }\n  :where(body h3) { font-size: 21px; line-height: 1.35; font-weight: 700; margin: 32px 0 10px; color: #1a1a1a; }\n  :where(body h4) { font-size: 17px; font-weight: 700; margin: 22px 0 6px; color: #1a1a1a; }\n  :where(body h5, body h6) { font-size: 14px; font-weight: 600; margin: 16px 0 4px; color: #1a1a1a; text-transform: uppercase; letter-spacing: 0.06em; }\n  :where(body p) { margin: 0 0 16px; }\n  :where(body a) { color: #1652f0; text-decoration: underline; text-underline-offset: 2px; }\n  :where(body a:hover) { text-decoration-thickness: 2px; }\n  :where(body ul, body ol) { margin: 0 0 18px; padding-left: 26px; }\n  :where(body li) { margin: 8px 0; }\n  :where(body blockquote) { margin: 20px 0; padding: 2px 0 2px 20px; border-left: 3px solid #d9d8d3; color: #6b6a66; }\n  :where(body code) { font-family: ui-monospace, \"SF Mono\", Menlo, monospace; font-size: 0.88em; background: #f0f0ee; padding: 2px 6px; border-radius: 6px; }\n  :where(body pre) { font-family: ui-monospace, \"SF Mono\", Menlo, monospace; font-size: 14.5px; line-height: 1.6; background: #f7f7f5; border: 1px solid #e8e7e3; border-radius: 10px; padding: 16px 18px; margin: 20px 0; overflow-x: auto; }\n  :where(body pre code) { background: transparent; padding: 0; border-radius: 0; }\n  :where(body hr) { border: 0; border-top: 1px solid #e8e7e3; margin: 36px 0; }\n  /* Tables: Claude-style rounded cells with white gutters — no rules/borders. */\n  :where(body table) { border-collapse: separate; border-spacing: 3px; margin: 0 0 18px -14px; font-size: 16px; }\n  :where(body th, body td) { padding: 10px 14px; background: #f0f0ee; border-radius: 8px; border: 0; text-align: left; }\n  :where(body th) { font-weight: 600; color: #1a1a1a; }\n  :where(body figcaption) { font-size: 13px; color: #6b6a66; margin-top: 6px; text-align: center; }\n  /* Task lists: circle checkboxes, Claude Code style. Works for raw\n     <input type=checkbox> in lists and markdown-converted .task-list-item. */\n  :where(body li:has(> input[type=\"checkbox\"]), body li.task-list-item) { list-style: none; margin-left: -26px; }\n  :where(body input[type=\"checkbox\"]) {\n    appearance: none; -webkit-appearance: none;\n    width: 17px; height: 17px;\n    border: 1.5px solid #c9c8c3; border-radius: 50%;\n    vertical-align: -3px; margin: 0 8px 0 0;\n    background: #fff; cursor: default;\n  }\n  :where(body input[type=\"checkbox\"]:checked) {\n    background: #1a1a1a center / 11px no-repeat url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path d=\"M3 8.5l3.5 3.5L13 5\" stroke=\"white\" stroke-width=\"2.2\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>');\n    border-color: #1a1a1a;\n  }\n  /* Doc imagery only — exclude overlay UI so icons inside the bar / chips /\n     buttons / cards keep their inline layout instead of stacking to 16px tall. */\n  :where(body img, body svg, body canvas, body video):not(.tdoc-bar *):not(.tdoc-margin-comment *):not(.tdoc-popup *):not(.tdoc-modal-bg *):not(.tdoc-chip *):not(.tdoc-fab *):not(#tdoc-comment-layer *):not(.tdoc-footer *) { display: block; margin: 16px auto; border-radius: 6px; }\n  /* Reading column for the doc container. :where() so a doc's own rule wins. */\n  :where(body > .wrap, body > main, body > article, body > .content, body > .container) {\n    max-width: 720px;\n    padding: 56px 24px 80px;\n    box-sizing: border-box;\n  }\n  /* End default template. ====================================================== */\n\n  /* Defensive responsive defaults for artifacts. Docs sometimes hardcode pixel\n     widths (e.g. <canvas width=\"640\">) that overflow on phones. These rules\n     constrain every artifact to its container width without changing its\n     aspect ratio. Wrapped in :where() so the doc's own CSS wins if specified. */\n  :where(body img, body video, body iframe, body svg, body canvas) {\n    max-width: 100% !important;\n    height: auto;\n    box-sizing: border-box;\n  }\n  /* Canvas needs special handling: scaling its CSS size doesn't change its\n     drawing-buffer size, but at least the box won't overflow. */\n  :where(body canvas) { display: block; }\n  /* Wide tables: keep TRUE table layout on desktop — display:block on a\n     table element discards real table layout for anonymous-box fixup, which\n     some engines render with uneven row heights and gaps (seen on published\n     docs). Only degrade to a scrollable block on narrow viewports, where\n     horizontal overflow is the bigger evil. NOTE: no backticks in comments\n     here — this CSS lives inside a JS template literal. */\n  :where(body table) { max-width: 100%; }\n  @media (max-width: 760px) {\n    :where(body table) { display: block; overflow-x: auto; }\n  }\n  /* Pre/code blocks scroll horizontally instead of breaking the layout. */\n  :where(body pre) { max-width: 100%; overflow-x: auto; }\n\n  /* ========== Top bar (HackMD-inspired rhythm) ==========\n     Three groups: left breadcrumb (workspace + slug + version), center\n     doc title (truncates), right cluster (identity, primary CTA, more).\n     No borders on individual buttons — uses hover background instead, so\n     the bar reads as a clean strip rather than a row of chiclets.\n     Light theme to match the doc body. */\n  .tdoc-bar { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #fff; color: #1a1a1a; display: flex; align-items: center; padding: 0 12px; font: 13px system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; z-index: 999999; gap: 8px; border-bottom: 1px solid #e5e5e7; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }\n  .tdoc-bar-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1; }\n  .tdoc-bar-center { flex: 1 1 auto; display: flex; justify-content: center; min-width: 0; padding: 0 8px; }\n  .tdoc-bar-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }\n\n  /* Workspace mark — circular dot like HackMD's logo. Clicks → /. */\n  .tdoc-bar-mark { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border-radius: 999px; background: #1652f0; color: #fff; font-weight: 700; font-size: 13px; letter-spacing: -0.01em; cursor: pointer; flex-shrink: 0; border: none; }\n  .tdoc-bar-mark:hover { background: #1245d0; }\n\n  /* Breadcrumb: workspace · slug · v3 — separated by \" / \". */\n  .tdoc-bar .crumb { color: #555; font-weight: 500; padding: 4px 6px; border-radius: 6px; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n  .tdoc-bar .crumb-sep { color: #c0c0c4; user-select: none; padding: 0 1px; }\n  .tdoc-bar .doc-title { color: #1a1a1a; font-weight: 600; font-size: 14px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n\n  /* Default action button — icon and/or label, no border, hover bg only. */\n  .tdoc-bar button { background: transparent; border: none; color: #555; padding: 6px 8px; border-radius: 6px; font: inherit; cursor: pointer; transition: background .12s, color .12s; display: inline-flex; align-items: center; gap: 6px; }\n  .tdoc-bar button:hover { background: #f0f1f4; color: #1a1a1a; }\n  .tdoc-bar button:disabled { opacity: 0.5; cursor: not-allowed; }\n  .tdoc-bar button svg { flex-shrink: 0; }\n\n  /* Primary CTA (Share / Publish) — filled blue button at the right. */\n  .tdoc-bar button.primary { background: #1652f0; color: #fff; padding: 7px 14px; font-weight: 600; }\n  .tdoc-bar button.primary:hover { background: #1245d0; color: #fff; }\n\n  /* Version picker chip — pill in the left breadcrumb. */\n  .tdoc-version-wrap { position: relative; display: inline-block; flex-shrink: 0; }\n  .tdoc-version-toggle { background: #f0f1f4 !important; color: #1a1a1a !important; padding: 3px 10px !important; border-radius: 999px !important; font: 12px ui-monospace, \"SF Mono\", Menlo, monospace !important; }\n  .tdoc-version-toggle:hover { background: #e5e6ea !important; }\n\n  /* Dropdown menus — light surface to match the bar. */\n  .tdoc-menu, .tdoc-secondary-menu, .tdoc-version-menu { display: none; position: absolute; background: #fff; border: 1px solid #e5e5e7; border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); z-index: 1000000; min-width: 160px; }\n  .tdoc-version-menu { top: calc(100% + 6px); left: 0; max-height: 60vh; overflow-y: auto; }\n  .tdoc-menu { top: calc(100% + 6px); right: 0; min-width: 180px; }\n  .tdoc-secondary-menu { top: calc(100% + 6px); right: 0; }\n  .tdoc-menu.open, .tdoc-secondary-menu.open, .tdoc-version-menu.open { display: block; }\n  .tdoc-menu button, .tdoc-secondary-menu button, .tdoc-version-menu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 4px; color: #1a1a1a; font: 13px system-ui, sans-serif; }\n  .tdoc-version-menu button { font-family: ui-monospace, \"SF Mono\", Menlo, monospace; }\n  .tdoc-menu button:hover, .tdoc-secondary-menu button:hover, .tdoc-version-menu button:hover { background: #f0f1f4; }\n  .tdoc-version-menu button.current { color: #1652f0; font-weight: 600; }\n\n  .tdoc-menu-wrap { position: relative; display: inline-block; }\n  /* Overflow ⋯ button shows on narrow viewports. */\n  .tdoc-bar .tdoc-secondary-toggle { display: none; padding: 6px 10px; }\n\n  /* Identity chip — avatar + name (name hides on narrow). */\n  .tdoc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 12px 3px 3px; background: #f0f1f4; border-radius: 999px; cursor: pointer; color: #1a1a1a; font: inherit; border: none; }\n  .tdoc-chip:hover { background: #e5e6ea; }\n  .tdoc-chip img { width: 26px; height: 26px; border-radius: 50%; }\n  .tdoc-chip .name { font-size: 13px; font-weight: 500; }\n  .tdoc-chip.signin { padding: 7px 14px; background: #1652f0; color: #fff; font-weight: 600; }\n  .tdoc-chip.signin:hover { background: #1245d0; }\n\n  /* Comment cards */\n  #tdoc-comment-layer { position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; z-index: 999996; }\n  .tdoc-margin-comment { position: absolute; width: 280px; background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); font: 13px system-ui, sans-serif; transition: box-shadow .15s, transform .15s; z-index: 999996; pointer-events: auto; }\n  .tdoc-margin-comment.active { box-shadow: 0 4px 16px rgba(22,82,240,0.18); border-color: #1652f0; }\n  .tdoc-margin-comment.tdoc-unanchored { border-style: dashed; }\n  .tdoc-reanchor-btn { display: none; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px; cursor: pointer; background: none; border: none; padding: 0; text-align: left; }\n  .tdoc-margin-comment.tdoc-unanchored .tdoc-reanchor-btn { display: block; }\n  /* Anchored cards also expose a \"move anchor\" action when they're active. */\n  .tdoc-margin-comment.active .tdoc-reanchor-btn { display: block; }\n  .tdoc-reanchor-btn:hover { color: #1652f0; }\n  /* Label swap: \"unanchored\" wording on unanchored cards, \"move anchor\" on\n     active anchored cards. */\n  .tdoc-reanchor-btn .tdoc-reanchor-unanchored,\n  .tdoc-reanchor-btn .tdoc-reanchor-anchored { display: none; }\n  .tdoc-margin-comment.tdoc-unanchored .tdoc-reanchor-btn .tdoc-reanchor-unanchored { display: inline; }\n  .tdoc-margin-comment:not(.tdoc-unanchored).active .tdoc-reanchor-btn .tdoc-reanchor-anchored { display: inline; }\n  /* Container for the anchor action buttons. */\n  .tdoc-anchor-actions { display: flex; gap: 12px; align-items: center; margin: 0 0 6px; }\n  /* While re-anchor mode is active, dim the rest of the UI and prompt the\n     user to select. */\n  /* Re-anchor banner: pinned below the bar with three actions. Visible\n     only while body.tdoc-reanchoring is set. */\n  .tdoc-reanchor-banner { display: none; position: fixed; top: 56px; left: 50%; transform: translateX(-50%); background: #1652f0; color: #fff; padding: 6px 10px 6px 14px; border-radius: 999px; font: 12px system-ui; z-index: 999999; align-items: center; gap: 6px; box-shadow: 0 4px 16px rgba(22,82,240,0.35); }\n  body.tdoc-reanchoring .tdoc-reanchor-banner { display: inline-flex; }\n  .tdoc-reanchor-banner .label { padding: 0 4px; }\n  .tdoc-reanchor-banner button { background: rgba(255,255,255,0.15); border: none; color: #fff; padding: 4px 10px; border-radius: 999px; font: 12px system-ui; cursor: pointer; }\n  .tdoc-reanchor-banner button:hover { background: rgba(255,255,255,0.28); }\n  .tdoc-reanchor-banner button.danger { background: rgba(255,255,255,0.15); }\n  .tdoc-reanchor-banner button.danger:hover { background: #c33; }\n  /* Old-version strip — a thin, quiet bar just under the top bar shown when\n     the viewer is on a non-latest version. Single-direction nudge: it only\n     points forward to the latest version. Hidden by default; the bar-setup\n     code reveals it (and adds the body padding) only when version < latest. */\n  .tdoc-oldver-strip { display: none; position: fixed; top: 44px; left: 0; right: 0; height: 28px; background: #fbf6e9; color: #6b5e3a; border-bottom: 1px solid #efe6cd; font: 12px system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; align-items: center; justify-content: center; gap: 6px; z-index: 999998; padding: 0 12px; }\n  body.tdoc-has-oldver-strip .tdoc-oldver-strip { display: flex; }\n  body.tdoc-has-oldver-strip { padding-top: 72px !important; }\n  .tdoc-oldver-strip a { color: #8a6d1f; font-weight: 600; text-decoration: none; border-bottom: 1px solid currentColor; }\n  .tdoc-oldver-strip a:hover { color: #6b5413; }\n  /* Ghost marker — a faint horizontal line at the unanchored comment's\n     original Y position, so the user can see where the deleted text used\n     to be. Stays in document coordinates. */\n  .tdoc-ghost-marker { position: absolute; left: 0; right: 320px; height: 0; border-top: 1px dashed #d4d4d4; pointer-events: none; z-index: 999990; }\n  body.tdoc-narrow .tdoc-ghost-marker { display: none; }\n  .tdoc-margin-comment .author { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }\n  .tdoc-margin-comment .author img { width: 24px; height: 24px; border-radius: 50%; }\n  .tdoc-margin-comment .author .login { font-weight: 600; color: #111; font-size: 13px; }\n  .tdoc-margin-comment .author .anon { color: #888; font-style: italic; }\n  /* Agent identity — a simple \"⚡ lucius-agent\" badge in place of an avatar.\n     The status chip on agent replies (applied / partial / question) lets\n     the user tell at a glance whether their comment was addressed. */\n  .lucius-agent-badge { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; background: #111; color: #fff; align-items: center; justify-content: center; font-size: 13px; }\n  .lucius-agent-reply { background: #fafafb; border-left: 3px solid #111; padding-left: 8px; }\n  .lucius-agent-status { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; margin: 0 0 6px; font-weight: 600; }\n  .lucius-agent-status-applied { background: #e8f5ed; color: #1a7340; }\n  .lucius-agent-status-partial { background: #fff4dc; color: #8a5a00; }\n  .lucius-agent-status-question { background: #ffe7e7; color: #a52323; }\n  .tdoc-margin-comment .text { color: #111; line-height: 1.45; word-wrap: break-word; }\n  .tdoc-margin-comment .meta { font-size: 11px; color: #888; margin-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }\n  .tdoc-margin-comment .meta > span:first-child { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n  .tdoc-margin-comment .del { cursor: pointer; color: #c33; }\n  .tdoc-margin-comment .del:hover { text-decoration: underline; }\n  .tdoc-margin-comment .actions { display: inline-flex; gap: 8px; align-items: center; flex-shrink: 0; }\n  .tdoc-margin-comment .copy-md { cursor: pointer; color: #888; display: inline-flex; align-items: center; }\n  .tdoc-margin-comment .copy-md:hover { color: #1652f0; }\n  .tdoc-margin-comment .copy-md svg { width: 14px; height: 14px; display: block; }\n  .tdoc-margin-comment .tdoc-reply-toggle { cursor: pointer; color: #1652f0; }\n  .tdoc-margin-comment .tdoc-reply-toggle:hover { text-decoration: underline; }\n\n  /* Reactions + emoji picker */\n  .tdoc-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }\n  .tdoc-react-chip { position: relative; display: inline-flex; align-items: center; gap: 4px; font: 12px system-ui; background: #f5f6f8; border: 1px solid #e5e5e5; border-radius: 999px; padding: 2px 8px; cursor: pointer; color: #333; transition: background .12s, border-color .12s; }\n  .tdoc-react-chip:hover { background: #eef0f3; }\n  .tdoc-react-chip.mine { background: #e8eeff; border-color: #1652f0; color: #1652f0; }\n  /* Agent reactions get a tinted background so users can scan a long doc\n     and spot which comments the agent has already responded to. */\n  .tdoc-react-chip.agent { background: #f3eaff; border-color: #c3a8f0; color: #5a2da8; }\n  .tdoc-react-chip.agent.mine { background: #f3eaff; border-color: #c3a8f0; color: #5a2da8; }\n  /* Custom reactors tooltip — shows the GitHub logins (or agent labels) of\n     everyone who used this emoji. Native title= has ~1s delay; this is\n     instant and styled to match the doc. */\n  .tdoc-react-chip[data-users]:hover::after {\n    content: attr(data-users);\n    position: absolute;\n    bottom: calc(100% + 6px);\n    left: 50%;\n    transform: translateX(-50%);\n    background: #111;\n    color: #fff;\n    padding: 4px 8px;\n    border-radius: 6px;\n    font: 11px/1.3 system-ui;\n    white-space: pre;\n    max-width: 240px;\n    pointer-events: none;\n    z-index: 999999;\n  }\n  .tdoc-react-add { background: transparent; border: none; color: #aaa; padding: 0; cursor: pointer; line-height: 1; transition: color .12s, opacity .12s; display: inline-flex; align-items: center; }\n  .tdoc-react-add svg { width: 16px; height: 16px; display: block; }\n  .tdoc-reactions .tdoc-react-add { opacity: 0; padding: 2px 4px; }\n  .tdoc-margin-comment:hover .tdoc-reactions .tdoc-react-add, .tdoc-reply:hover .tdoc-reactions .tdoc-react-add, .tdoc-reactions:has(.tdoc-react-chip) .tdoc-react-add { opacity: 1; }\n  .tdoc-react-add.inline svg { width: 14px; height: 14px; }\n  .tdoc-react-add.inline { opacity: 0.55; vertical-align: middle; }\n  .tdoc-react-add:hover { color: #1652f0; opacity: 1; }\n  .tdoc-emoji-picker { position: absolute; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 6px; display: grid; grid-template-columns: repeat(6, 32px); gap: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); z-index: 1000001; }\n  .tdoc-emoji-picker button { background: transparent; border: none; padding: 0; cursor: pointer; border-radius: 4px; width: 32px; height: 32px; font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }\n  .tdoc-emoji-picker button:hover { background: #f5f6f8; }\n  .tdoc-emoji-picker button.tdoc-emoji-text { grid-column: span 6; height: auto; padding: 6px 8px; font-size: 12px; font-weight: 600; color: #1652f0; }\n  .tdoc-emoji-picker button.tdoc-emoji-text:hover { background: #e8eeff; }\n\n  /* Replies + reply form */\n  .tdoc-replies-toggle { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 12px; color: #1652f0; user-select: none; }\n  .tdoc-replies-toggle:hover { text-decoration: underline; }\n  .tdoc-replies-toggle .chev { transition: transform .15s; }\n  .tdoc-replies-toggle.open .chev { transform: rotate(90deg); }\n  .tdoc-replies { display: none; flex-direction: column; gap: 10px; margin-top: 10px; }\n  .tdoc-replies.open { display: flex; }\n  .tdoc-reply { padding-left: 12px; border-left: 2px solid #e5e5e5; }\n  .tdoc-reply .author { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }\n  .tdoc-reply .author img { width: 18px; height: 18px; border-radius: 50%; }\n  .tdoc-reply .author .login { font-weight: 600; font-size: 12px; color: #111; }\n  .tdoc-reply .author .anon { color: #888; font-style: italic; font-size: 12px; }\n  .tdoc-reply .text { color: #222; font-size: 13px; line-height: 1.4; word-wrap: break-word; }\n  .tdoc-reply .meta { font-size: 11px; color: #888; margin-top: 4px; display: flex; justify-content: space-between; }\n  .tdoc-reply .del { cursor: pointer; color: #c33; }\n  .tdoc-reply .del:hover { text-decoration: underline; }\n  .tdoc-reply-form { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; }\n  .tdoc-reply-form.open { display: block; }\n  .tdoc-reply-form textarea { width: 100%; min-height: 48px; box-sizing: border-box; padding: 6px 8px; font: 13px system-ui; border: 1px solid #ccc; border-radius: 6px; resize: vertical; outline: none; }\n  .tdoc-reply-form textarea:focus { border-color: #1652f0; }\n  .tdoc-reply-form-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }\n  .tdoc-reply-form-foot .hint { color: #888; font-size: 11px; }\n  .tdoc-reply-form-foot .tdoc-reply-submit { background: #1652f0; color: #fff; border: none; border-radius: 6px; padding: 5px 12px; font: 12px system-ui; cursor: pointer; }\n  .tdoc-reply-form-foot .tdoc-reply-submit:hover { background: #1245d0; }\n\n  /* Anchor highlights (Custom Highlight API + fallback span) */\n  ::highlight(tdoc-pending) { background-color: #fff3a8; }\n  ::highlight(tdoc-anchor) { background-color: #fff7d0; }\n  /* Active = clicked. Visibly different from resting: vivid yellow + thick\n     gold underline. (The CSS Highlight API only supports background-color,\n     color, and text-decoration — so we stack those.) */\n  ::highlight(tdoc-anchor-active) {\n    background-color: #ffd84d;\n    text-decoration: underline solid #b8860b;\n    text-decoration-thickness: 3px;\n    text-underline-offset: 2px;\n  }\n  .tdoc-anchor-mark { background: #fff7d0; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }\n  .tdoc-anchor-mark:hover { background: #fdedb0; }\n  .tdoc-anchor-mark.active { background: #ffd84d; box-shadow: 0 -3px 0 -1px #b8860b inset; }\n\n  /* Element outlines + hover affordance */\n  .tdoc-element-outline { position: absolute; pointer-events: none; border: 1.5px solid rgba(22,82,240,0.35); border-radius: 4px; box-sizing: border-box; z-index: 999995; transition: border-color .15s, box-shadow .15s, border-width .15s; }\n  .tdoc-element-outline.pending { border-color: #f0d000; border-width: 2px; background: transparent; }\n  .tdoc-element-outline.active { border-color: #1652f0; border-width: 2px; box-shadow: 0 0 0 4px rgba(22,82,240,0.18); }\n  .tdoc-hover-outline { position: absolute; pointer-events: none; z-index: 999995; border: 2px dashed #1652f0; border-radius: 4px; background: rgba(22,82,240,0.06); box-sizing: border-box; transition: opacity .12s; }\n  /* Clickable pill that appears NEXT TO commentable artifacts (img/canvas/svg/video/pre).\n     Positioned just outside the artifact's right edge so it can't obscure\n     content. Uses !important on the visible colors to defend against doc-side\n     button:hover rules that would otherwise repaint our background. */\n  .tdoc-comment-pill {\n    position: absolute !important; z-index: 999998 !important;\n    background: #1652f0 !important; color: #fff !important;\n    font: 600 11px system-ui !important;\n    padding: 4px 10px !important;\n    border: none !important; border-radius: 999px !important;\n    cursor: pointer !important;\n    box-shadow: 0 2px 8px rgba(22,82,240,0.38) !important;\n    display: inline-flex !important; align-items: center !important; gap: 4px !important;\n    transition: transform .12s, background-color .12s, box-shadow .12s, opacity .12s !important;\n    line-height: 1 !important;\n    text-decoration: none !important;\n    opacity: 0.92 !important; visibility: visible !important;\n  }\n  .tdoc-comment-pill:hover {\n    background: #1245d0 !important; color: #fff !important;\n    opacity: 1 !important;\n    transform: translateY(-1px) !important;\n    box-shadow: 0 4px 12px rgba(22,82,240,0.50) !important;\n  }\n  .tdoc-comment-pill:active { background: #0f3bb0 !important; transform: translateY(0) !important; }\n  .tdoc-comment-pill svg { width: 12px !important; height: 12px !important; flex-shrink: 0 !important; stroke: #fff !important; }\n  .tdoc-drag-marquee { position: absolute; pointer-events: none; z-index: 999997; border: 1.5px solid #1652f0; background: rgba(22,82,240,0.1); box-sizing: border-box; }\n\n  /* Popup (new-comment) */\n  .tdoc-popup { position: absolute; background: #0a0a0a; color: #fff; border-radius: 10px; padding: 14px; width: 320px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); z-index: 999998; font: 13px system-ui, sans-serif; }\n  .tdoc-popup .head { display: flex; justify-content: space-between; margin-bottom: 8px; }\n  .tdoc-popup .head .h { color: #aaa; }\n  .tdoc-popup .head .x { cursor: pointer; color: #888; }\n  .tdoc-popup textarea { width: 100%; min-height: 64px; background: transparent; color: #fff; border: 1px solid #1652f0; border-radius: 6px; padding: 8px; font: inherit; resize: vertical; box-sizing: border-box; outline: none; }\n  .tdoc-popup .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }\n  .tdoc-popup .hint { color: #888; font-size: 11px; }\n  .tdoc-popup .submit { background: #1652f0; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }\n  .tdoc-popup .submit:hover { background: #1245d0; }\n  .tdoc-popup .signin-needed { color: #f5a623; font-size: 12px; padding: 8px 0; }\n\n  /* Modal (sign-in) */\n  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }\n  .tdoc-modal { background: #fff; color: #111; border-radius: 12px; padding: 28px; width: 460px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }\n  .tdoc-modal h3 { margin: 0 0 8px; font-size: 20px; }\n  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }\n  .tdoc-modal .code { background: #0a0a0a; color: #fff; padding: 18px; border-radius: 8px; font: 24px ui-monospace, \"SF Mono\", Menlo, monospace; letter-spacing: 0.15em; text-align: center; margin: 0 0 14px; user-select: all; cursor: copy; }\n  .tdoc-modal .step { display: flex; gap: 10px; margin-bottom: 8px; color: #444; }\n  .tdoc-modal .step .n { width: 22px; height: 22px; border-radius: 50%; background: #1652f0; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }\n  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }\n  .tdoc-modal button { padding: 8px 16px; border-radius: 6px; font: inherit; cursor: pointer; border: 1px solid #ccc; background: #fff; }\n  .tdoc-modal button.primary { background: #1652f0; border-color: #1652f0; color: #fff; }\n  .tdoc-modal button.primary:hover { background: #1245d0; }\n  .tdoc-modal .status { color: #888; font-size: 13px; }\n  /* Modal helper classes used by Publish/Share so dark-mode can override. */\n  .tdoc-modal .muted { color: #666; font-size: 13px; }\n  .tdoc-modal .divider { border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px; }\n  .tdoc-modal .danger { color: #c33; font-size: 13px; }\n  .tdoc-modal code { background: #f5f6f8; padding: 1px 5px; border-radius: 3px; }\n\n  /* Bar collapse breakpoints — tied to viewport width, not layout class.\n     The bar progressively hides elements as the viewport tightens, so it\n     stays elegant at every size.\n       ≥1100px: workspace · slug · v · | title | identity · share · ⋯\n       <1100px: workspace ·          v · | title | identity · share · ⋯  (slug hides)\n       < 900px: workspace ·          v · | title | avatar   · share · ⋯  (name hides)\n       < 700px: workspace             · | title |            share · ⋯  (version+identity into ⋯) */\n  @media (max-width: 1100px) {\n    .tdoc-bar .crumb-slug, .tdoc-bar .crumb-sep-slug { display: none; }\n  }\n  @media (max-width: 900px) {\n    .tdoc-chip .name { display: none; }\n    .tdoc-chip { padding: 3px; }\n    .tdoc-bar #tdoc-fork-btn, .tdoc-bar #tdoc-saveas-btn { display: none; }\n    .tdoc-bar .tdoc-secondary-toggle { display: inline-flex; }\n  }\n  @media (max-width: 700px) {\n    .tdoc-bar { padding: 0 8px; gap: 4px; }\n    .tdoc-version-wrap { display: none; }\n    .tdoc-bar .doc-title { font-size: 13px; }\n    .tdoc-bar #tdoc-copy-md-btn span { display: none; }\n    .tdoc-bar #tdoc-publish-btn span, .tdoc-bar #tdoc-share-btn span { display: inline; }\n  }\n\n  /* Narrow mode (drawer + FAB) — still driven by the layout evaluator so\n     it can also kick in when the comment column would crowd the article. */\n  body.tdoc-narrow #tdoc-comment-layer { position: fixed; top: auto; left: 0; right: 0; bottom: 0; max-height: 70vh; width: 100%; pointer-events: auto; background: #fff; border-top: 1px solid #e5e5e5; box-shadow: 0 -4px 24px rgba(0,0,0,0.08); transform: translateY(100%); transition: transform .2s; overflow-y: auto; padding: 12px 12px 24px; box-sizing: border-box; z-index: 999998; }\n  body.tdoc-narrow #tdoc-comment-layer.open { transform: translateY(0); }\n  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle { display: block; width: 36px; height: 4px; background: #ccc; border-radius: 2px; margin: 0 auto 12px; cursor: grab; touch-action: none; user-select: none; }\n  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle:active { cursor: grabbing; }\n  body.tdoc-narrow .tdoc-margin-comment { position: static !important; width: auto !important; left: auto !important; top: auto !important; margin-bottom: 10px; transform: none !important; }\n  body.tdoc-narrow .tdoc-fab { position: fixed; bottom: 16px; right: 16px; z-index: 999997; background: #1652f0; color: #fff; border: none; border-radius: 999px; padding: 10px 16px; font: 13px system-ui; font-weight: 600; box-shadow: 0 4px 16px rgba(22,82,240,0.35); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }\n  body.tdoc-narrow .tdoc-fab:active { transform: scale(0.96); }\n  body.tdoc-narrow .tdoc-popup { width: calc(100vw - 24px); max-width: 320px; left: 12px !important; }\n  body.tdoc-narrow .tdoc-modal { width: calc(100vw - 32px); padding: 20px; }\n  body.tdoc-narrow .tdoc-modal .code { font-size: 20px; }\n  body.tdoc-narrow .tdoc-hover-outline, body.tdoc-narrow .tdoc-comment-pill, body.tdoc-narrow .tdoc-drag-marquee { display: none; }\n  body.tdoc-narrow .tdoc-emoji-picker { grid-template-columns: repeat(6, 36px); }\n  body.tdoc-narrow .tdoc-emoji-picker button { width: 36px; height: 36px; font-size: 20px; }\n  @media (max-width: 480px) {\n    .tdoc-bar { padding: 0 10px; gap: 8px; }\n    .tdoc-bar button, .tdoc-bar .tdoc-menu-wrap > button { padding: 4px 8px; font-size: 12px; }\n    .tdoc-icon-btn span { display: none; }\n    .tdoc-emoji-picker { grid-template-columns: repeat(5, 40px); padding: 8px; }\n    .tdoc-emoji-picker button { width: 40px; height: 40px; font-size: 22px; }\n    .tdoc-emoji-picker button.tdoc-emoji-text { grid-column: span 5; }\n  }\n\n  /* Footer */\n  .tdoc-footer { margin-top: 80px; padding: 20px 16px 28px; font: 12px system-ui, sans-serif; color: #888; text-align: center; border-top: 1px solid #eee; box-sizing: border-box; max-width: 100%; }\n  .tdoc-footer .tdoc-footer-row { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; row-gap: 4px; }\n  .tdoc-footer a { color: #666; text-decoration: none; }\n  .tdoc-footer a:hover { color: #1652f0; text-decoration: underline; }\n  .tdoc-footer .sep { color: #ccc; }\n  @media (max-width: 700px) { .tdoc-footer .tdoc-footer-row { flex-direction: column; gap: 4px; } .tdoc-footer .sep { display: none; } }\n\n  `;\n  const style = document.createElement('style');\n  style.textContent = css;\n  document.head.appendChild(style);\n\n  // ========== State ==========\n  const state = {\n    activeComments: [],            // last-fetched open comments\n    cardEls: new Map(),            // id -> card element\n    anchorMarks: new Map(),        // id -> { kind, el? (fallback span or outline), ranges? (Highlight API), targetEl? }\n    activeId: null,\n    narrow: false,\n    reanchoringId: null,           // comment id awaiting a new selection for re-anchoring\n  };\n\n  // Highlight API: one shared registry for pending, one per saved comment.\n  const pendingHighlight = HIGHLIGHT_API ? new Highlight() : null;\n  if (HIGHLIGHT_API) {\n    CSS.highlights.set('tdoc-pending', pendingHighlight);\n  }\n  function rebuildSharedHighlights() {\n    if (!HIGHLIGHT_API) return;\n    const idle = new Highlight();\n    const active = new Highlight();\n    for (const [id, mark] of state.anchorMarks) {\n      if (!mark.ranges) continue;\n      const target = (id === state.activeId) ? active : idle;\n      for (const r of mark.ranges) target.add(r);\n    }\n    CSS.highlights.set('tdoc-anchor', idle);\n    CSS.highlights.set('tdoc-anchor-active', active);\n  }\n  function clearAllCommentHighlights() {\n    if (!HIGHLIGHT_API) return;\n    CSS.highlights.delete('tdoc-anchor');\n    CSS.highlights.delete('tdoc-anchor-active');\n  }\n\n  function escapeHtml(s) {\n    return String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  }\n\n  // ========== Top bar (HackMD-style three-group layout) ==========\n  const bar = document.createElement('div');\n  bar.className = 'tdoc-bar';\n\n  const versions = Array.isArray(cfg.versions) && cfg.versions.length ? cfg.versions : [{ n: version }];\n  versions.sort((a, b) => (a.n || 0) - (b.n || 0));\n  const slugCrumbLabel = isFork ? `fork of ${cfg.originalSlug || slug}` : slug;\n\n  // Left group: workspace mark + slug crumb + version picker.\n  const leftHtml = `\n    <button class=\"tdoc-bar-mark\" id=\"tdoc-bar-mark\" title=\"built on tdoc (GitHub)\" aria-label=\"built on tdoc (GitHub)\">lucius</button>\n    <span class=\"crumb crumb-slug\" title=\"${escapeHtml(slugCrumbLabel)}\">${escapeHtml(slugCrumbLabel)}</span>\n    <span class=\"crumb-sep crumb-sep-slug\" aria-hidden=\"true\">/</span>\n    <div class=\"tdoc-version-wrap\">\n      <button class=\"tdoc-version-toggle\" id=\"tdoc-version-toggle\" type=\"button\" aria-haspopup=\"listbox\" aria-expanded=\"false\">v${version}${versions.length > 1 ? ' ▾' : ''}</button>\n      ${versions.length > 1 ? `\n        <div class=\"tdoc-version-menu\" id=\"tdoc-version-menu\" role=\"listbox\">\n          ${versions.map(v => `<button role=\"option\" data-version=\"${v.n}\" class=\"${v.n === version ? 'current' : ''}\">v${v.n}${v.n === version ? ' · current' : ''}</button>`).join('')}\n        </div>\n      ` : ''}\n    </div>`;\n\n  // Center: doc title (pulled from <title>). Hidden on very narrow.\n  const centerHtml = `<span class=\"doc-title\" id=\"tdoc-title\">lucius</span>`;\n\n  // Right: copy menu + primary CTA (Share or Publish) + ⋯ overflow + identity.\n  const copyMenuHtml = `\n    <div class=\"tdoc-menu-wrap\">\n      <button id=\"tdoc-copy-md-btn\" title=\"Copy as Markdown\" aria-label=\"Copy as Markdown\">\n        <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg>\n        <span>Copy</span>\n      </button>\n      <div class=\"tdoc-menu\" id=\"tdoc-copy-md-menu\">\n        <button data-mode=\"doc\">Doc only</button>\n        <button data-mode=\"doc-comments\">Doc + comments</button>\n      </div>\n    </div>`;\n\n  const primaryCtaHtml = isFork ? '' : (isPublished\n    ? `<button id=\"tdoc-share-btn\" class=\"primary\" title=\"Share link\" aria-label=\"Share\">\n         <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/></svg>\n         <span>Share</span>\n       </button>`\n    : `<button id=\"tdoc-publish-btn\" class=\"primary\" title=\"Publish to your Worker\" aria-label=\"Publish\">\n         <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 19V5\"/><polyline points=\"5 12 12 5 19 12\"/></svg>\n         <span>Publish</span>\n       </button>`);\n\n  // Fork / Save-as live in the ⋯ menu on narrow viewports.\n  const forkBtnHtml = isPublished\n    ? '<button id=\"tdoc-fork-btn\">Fork</button>'\n    : (isFork ? '<button id=\"tdoc-saveas-btn\">Save As New Local Doc</button>' : '');\n\n  const rightHtml = `\n    ${copyMenuHtml}\n    ${forkBtnHtml}\n    ${primaryCtaHtml}\n    <div class=\"tdoc-menu-wrap\">\n      <button class=\"tdoc-secondary-toggle\" id=\"tdoc-more-btn\" aria-label=\"More\" title=\"More\">⋯</button>\n      <div class=\"tdoc-secondary-menu\" id=\"tdoc-secondary-menu\">\n        ${isPublished ? '<button data-action=\"share\">Share</button><button data-action=\"fork\">Fork</button>' : ''}\n        ${isLocal ? '<button data-action=\"publish\">Publish</button>' : ''}\n        ${isFork ? '<button data-action=\"saveas\">Save copy</button>' : ''}\n        <button data-action=\"repo\">built on tdoc (GitHub)</button>\n      </div>\n    </div>\n    <span id=\"tdoc-identity-slot\"></span>`;\n\n  bar.innerHTML = `\n    <div class=\"tdoc-bar-left\">${leftHtml}</div>\n    <div class=\"tdoc-bar-center\">${centerHtml}</div>\n    <div class=\"tdoc-bar-right\">${rightHtml}</div>\n  `;\n  document.body.appendChild(bar);\n\n  // Old-version strip — a quiet, single-direction nudge shown only when a\n  // published viewer is looking at a non-latest version. `versions` is already\n  // sorted ascending above, so the last entry is the latest. Fork/local modes\n  // and the latest version itself get nothing.\n  if (isPublished && versions.length > 1) {\n    const latestVersion = versions[versions.length - 1].n;\n    if (typeof version === 'number' && version < latestVersion) {\n      const strip = document.createElement('div');\n      strip.className = 'tdoc-oldver-strip';\n      const latestUrl = `/d/${encodeURIComponent(slug)}/v/${latestVersion}`;\n      strip.innerHTML = `<span>You're viewing v${version} — the latest is <a href=\"${latestUrl}\">v${latestVersion}</a></span>`;\n      document.body.appendChild(strip);\n      document.body.classList.add('tdoc-has-oldver-strip');\n    }\n  }\n\n  // Re-anchor banner — shown while a re-anchor action is in flight. Three\n  // explicit actions to avoid the gesture conflict (clicking empty space\n  // would otherwise be ambiguous with \"deselect\").\n  const reanchorBanner = document.createElement('div');\n  reanchorBanner.className = 'tdoc-reanchor-banner';\n  reanchorBanner.innerHTML = `\n    <span class=\"label\">Select text to move anchor</span>\n    <button type=\"button\" id=\"tdoc-reanchor-remove\">Remove anchor</button>\n    <button type=\"button\" id=\"tdoc-reanchor-cancel\" class=\"danger\">Cancel</button>\n  `;\n  document.body.appendChild(reanchorBanner);\n\n  const titleEl = document.querySelector('title');\n  if (titleEl && titleEl.textContent) document.getElementById('tdoc-title').textContent = titleEl.textContent;\n\n  // Workspace mark in the bar's left → the open-source project. There is\n  // no public catalog; the owner reaches their doc list via the profile\n  // chip menu instead.\n  document.getElementById('tdoc-bar-mark').onclick = () =>\n    window.open('https://github.com/serenakeyitan/tdoc', '_blank', 'noopener');\n\n  // Fork: opens the renderable /fork view in a new tab AND triggers a download\n  // (one click, both happen). We use a hidden iframe to fire the download so\n  // the user keeps focus on the new fork tab.\n  async function forkAndDownload() {\n    // Fetch the fork HTML once, then both download AND open it via a blob URL.\n    // This way the new tab shows exactly the SAME bytes the user has on disk —\n    // a real local copy, not the worker-hosted /fork page. Self-contained:\n    // closing the tab doesn't lose the file, and the tab has no worker\n    // dependency (uses blob: not https:).\n    const base = `/d/${encodeURIComponent(slug)}/v/${version}`;\n    let bodyText;\n    try {\n      const resp = await fetch(`${base}/fork`);\n      if (!resp.ok) throw new Error(`fork fetch failed: ${resp.status}`);\n      bodyText = await resp.text();\n    } catch (e) {\n      // Fallback: old behavior (let the worker route handle download)\n      window.location.href = `${base}/export?download=1`;\n      return;\n    }\n    const blob = new Blob([bodyText], { type: 'text/html;charset=utf-8' });\n    const blobUrl = URL.createObjectURL(blob);\n\n    // 1. Trigger the file download via <a download>.\n    const a = document.createElement('a');\n    a.href = blobUrl;\n    a.download = `${slug}-v${version}-fork.html`;\n    document.body.appendChild(a);\n    a.click();\n    a.remove();\n\n    // 2. Open the same blob in a new tab so the user sees their fork rendered.\n    //    Small delay so the download starts before the new tab steals focus.\n    setTimeout(() => {\n      window.open(blobUrl, '_blank');\n      // Revoke after a generous interval — the new tab may still be parsing.\n      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);\n    }, 250);\n  }\n  if (isPublished) {\n    const fb = document.getElementById('tdoc-fork-btn');\n    if (fb) fb.onclick = forkAndDownload;\n    const sb = document.getElementById('tdoc-share-btn');\n    if (sb) sb.onclick = (e) => { e.stopPropagation(); showShareModal(); };\n  }\n  if (isLocal) {\n    const pb = document.getElementById('tdoc-publish-btn');\n    if (pb) pb.onclick = (e) => { e.stopPropagation(); showPublishModal(); };\n  }\n  function triggerForkDownload(slug, version) {\n    const a = document.createElement('a');\n    a.href = `/d/${encodeURIComponent(slug)}/v/${version}/export?download=1`;\n    a.download = `${slug}-v${version}-fork.html`;\n    document.body.appendChild(a); a.click(); a.remove();\n  }\n  if (isFork) {\n    // Save As: same download as Fork, but from within fork mode (no /fork open\n    // since we ARE the fork tab already).\n    const sa = document.getElementById('tdoc-saveas-btn');\n    if (sa) sa.onclick = () => triggerForkDownload(slug, version);\n  }\n\n  // Version picker — clicking a row navigates to /d/<slug>/v/<n>. The\n  // worker handles version routing; we let the browser do the navigation\n  // instead of any in-page swap so the user can hit Back to return.\n  const versionToggle = document.getElementById('tdoc-version-toggle');\n  const versionMenu = document.getElementById('tdoc-version-menu');\n  if (versionToggle && versionMenu) {\n    versionToggle.onclick = (e) => {\n      e.stopPropagation();\n      const open = versionMenu.classList.toggle('open');\n      versionToggle.setAttribute('aria-expanded', open ? 'true' : 'false');\n    };\n    versionMenu.querySelectorAll('button').forEach(b => {\n      b.onclick = (e) => {\n        e.stopPropagation();\n        versionMenu.classList.remove('open');\n        const n = Number(b.dataset.version);\n        if (!Number.isFinite(n) || n === version) return;\n        location.href = `/d/${encodeURIComponent(slug)}/v/${n}`;\n      };\n    });\n  }\n\n  const copyBtn = document.getElementById('tdoc-copy-md-btn');\n  const copyMenu = document.getElementById('tdoc-copy-md-menu');\n  copyBtn.onclick = (e) => { e.stopPropagation(); copyMenu.classList.toggle('open'); };\n  copyMenu.querySelectorAll('button').forEach(b => {\n    b.onclick = async (e) => {\n      e.stopPropagation();\n      copyMenu.classList.remove('open');\n      await window.__tdocCopyDocMd(b.dataset.mode === 'doc-comments');\n    };\n  });\n\n  const moreBtn = document.getElementById('tdoc-more-btn');\n  const secMenu = document.getElementById('tdoc-secondary-menu');\n  moreBtn.onclick = (e) => { e.stopPropagation(); secMenu.classList.toggle('open'); };\n  secMenu.querySelectorAll('button').forEach(b => {\n    b.onclick = (e) => {\n      e.stopPropagation();\n      secMenu.classList.remove('open');\n      if (b.dataset.action === 'repo') window.open('https://github.com/serenakeyitan/tdoc', '_blank', 'noopener');\n      if (b.dataset.action === 'fork') forkAndDownload();\n      if (b.dataset.action === 'share') showShareModal();\n      if (b.dataset.action === 'publish') showPublishModal();\n      if (b.dataset.action === 'saveas') triggerForkDownload(slug, version);\n    };\n  });\n\n  function renderIdentity() {\n    const slot = document.getElementById('tdoc-identity-slot');\n    if (!isPublished) { slot.innerHTML = ''; return; }\n    if (identity) {\n      // Profile chip → dropdown. \"My docs\" is owner-only (the configured\n      // TDOC_OWNER); everyone signed in still gets Sign out.\n      slot.innerHTML =\n        `<div class=\"tdoc-menu-wrap\">\n          <button class=\"tdoc-chip\" id=\"tdoc-me\" aria-haspopup=\"menu\" aria-expanded=\"false\">\n            <img src=\"${escapeHtml(identity.avatar_url || '')}\" alt=\"\"><span class=\"name\">${escapeHtml(identity.login)}</span>\n          </button>\n          <div class=\"tdoc-menu\" id=\"tdoc-me-menu\" role=\"menu\">\n            ${isOwner ? `<button id=\"tdoc-my-docs\" role=\"menuitem\">My docs</button>` : ''}\n            <button id=\"tdoc-signout\" role=\"menuitem\">Sign out</button>\n          </div>\n        </div>`;\n      const meBtn = document.getElementById('tdoc-me');\n      const meMenu = document.getElementById('tdoc-me-menu');\n      meBtn.onclick = (e) => {\n        e.stopPropagation();\n        const open = meMenu.classList.toggle('open');\n        meBtn.setAttribute('aria-expanded', open ? 'true' : 'false');\n      };\n      if (isOwner) {\n        document.getElementById('tdoc-my-docs').onclick = () => {\n          window.open('/me', '_blank', 'noopener');\n        };\n      }\n      document.getElementById('tdoc-signout').onclick = async () => {\n        await fetch('/api/auth/logout', { method: 'POST' });\n        identity = null;\n        isOwner = false;\n        renderIdentity();\n        refreshComments();\n      };\n    } else {\n      slot.innerHTML = `<button class=\"tdoc-chip signin\" id=\"tdoc-signin\">Sign in with GitHub</button>`;\n      document.getElementById('tdoc-signin').onclick = startDeviceFlow;\n    }\n  }\n  renderIdentity();\n\n  // ========== Comment layer + FAB ==========\n  const commentLayer = document.createElement('div');\n  commentLayer.id = 'tdoc-comment-layer';\n  const drawerHandle = document.createElement('div');\n  drawerHandle.className = 'tdoc-drawer-handle';\n  drawerHandle.setAttribute('aria-label', 'Drag down to close comments');\n  commentLayer.appendChild(drawerHandle);\n  document.body.appendChild(commentLayer);\n\n  const fab = document.createElement('button');\n  fab.className = 'tdoc-fab';\n  fab.style.display = 'none';\n  fab.innerHTML = '💬 <span id=\"tdoc-fab-count\">0</span>';\n  fab.onclick = (e) => { e.stopPropagation(); commentLayer.classList.toggle('open'); };\n  document.body.appendChild(fab);\n\n  // Drawer drag-to-close\n  drawerHandle.onclick = (e) => { e.stopPropagation(); commentLayer.classList.remove('open'); };\n  let drag = null;\n  function dragStart(e) {\n    e.preventDefault();\n    drag = { y0: e.touches ? e.touches[0].clientY : e.clientY, dy: 0 };\n    commentLayer.style.transition = 'none';\n  }\n  function dragMove(e) {\n    if (!drag) return;\n    const y = e.touches ? e.touches[0].clientY : e.clientY;\n    drag.dy = Math.max(0, y - drag.y0);\n    commentLayer.style.transform = `translateY(${drag.dy}px)`;\n  }\n  function dragEnd() {\n    if (!drag) return;\n    commentLayer.style.transition = '';\n    commentLayer.style.transform = '';\n    if (drag.dy > 40) commentLayer.classList.remove('open');\n    drag = null;\n  }\n  drawerHandle.addEventListener('touchstart', dragStart, { passive: false });\n  drawerHandle.addEventListener('touchmove', dragMove, { passive: true });\n  drawerHandle.addEventListener('touchend', dragEnd);\n  drawerHandle.addEventListener('mousedown', (e) => {\n    dragStart(e);\n    document.addEventListener('mousemove', dragMove);\n    document.addEventListener('mouseup', function onUp() {\n      dragEnd();\n      document.removeEventListener('mousemove', dragMove);\n      document.removeEventListener('mouseup', onUp);\n    });\n  });\n\n  // ========== Footer ==========\n  const footer = document.createElement('footer');\n  footer.className = 'tdoc-footer';\n  footer.innerHTML =\n    '<div class=\"tdoc-footer-row\">' +\n      '<a href=\"https://github.com/serenakeyitan/tdoc\" target=\"_blank\" rel=\"noopener\">github.com/serenakeyitan/tdoc</a>' +\n      '<span class=\"sep\">·</span>' +\n      '<span>built with <a href=\"https://github.com/serenakeyitan/tdoc\" target=\"_blank\" rel=\"noopener\">lucius</a></span>' +\n      '<span class=\"sep\">·</span>' +\n      '<span>inspired by <a href=\"https://x.com/jessepollak/status/2054313757543964857\" target=\"_blank\" rel=\"noopener\">bdocs by @jessepollak</a></span>' +\n    '</div>';\n  document.body.appendChild(footer);\n\n  // ========== Anchor matching (text → Range, element → Element) ==========\n  // Flatten the document's commentable text into one string, plus a parallel\n  // (node, offsetInString) map. Selections often span multiple text nodes\n  // (e.g. across <b>, <a>, <em>), so a per-node indexOf would miss them.\n  // Searching the flattened string handles that uniformly.\n  // Build a flat view of the document's commentable text plus a per-text-node\n  // offset map. We also build a *normalized* projection where every run of\n  // whitespace collapses to a single space. Multi-paragraph selections — which\n  // `Selection.toString()` returns with embedded \"\\n\\n\" — match against the\n  // normalized projection; the projection→raw map lets us recover the exact\n  // text-node/offset pair for the Range.\n  function collectTextNodes() {\n    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {\n      acceptNode(n) {\n        if (!n.parentElement) return NodeFilter.FILTER_REJECT;\n        if (n.parentElement.closest(UI_CONTAINERS)) return NodeFilter.FILTER_REJECT;\n        // Skip script/style/template etc — their .textContent is irrelevant.\n        const tag = n.parentElement.tagName;\n        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;\n        return NodeFilter.FILTER_ACCEPT;\n      }\n    });\n    const nodes = [];\n    let total = '';\n    // norm[i] = raw-string offset corresponding to normalized-string offset i.\n    let norm = '';\n    const normToRaw = [];\n    let prevWasSpace = false;\n    while (walker.nextNode()) {\n      const n = walker.currentNode;\n      const start = total.length;\n      const v = n.nodeValue;\n      nodes.push({ node: n, start, end: start + v.length });\n      total += v;\n      // If the previous block ended on non-space content and the next text\n      // node lives under a different block-level parent, treat the boundary\n      // as a single space in the normalized projection. This is what makes\n      // \"para1\\n\\npara2\" (from Selection.toString) collapse to \"para1 para2\".\n      for (let i = 0; i < v.length; i++) {\n        const ch = v.charCodeAt(i);\n        const isWs = ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xa0;\n        if (isWs) {\n          if (!prevWasSpace && norm.length) {\n            norm += ' ';\n            normToRaw.push(start + i);\n            prevWasSpace = true;\n          }\n        } else {\n          norm += v[i];\n          normToRaw.push(start + i);\n          prevWasSpace = false;\n        }\n      }\n    }\n    // Sentinel: normToRaw.length === norm.length, plus one trailing entry so\n    // end offsets at the very end of the doc still translate.\n    normToRaw.push(total.length);\n    return { nodes, total, norm, normToRaw };\n  }\n  // Collapse runs of whitespace into a single space so saved anchor text\n  // and the doc's normalized projection agree on inter-block boundaries.\n  // Two flavors:\n  //   normalizeNeedle: also trims edges. The user's selection often has\n  //     a stray leading/trailing newline that's not present in the doc\n  //     text we want to match against.\n  //   normalizeContext: preserves leading/trailing whitespace. Boundary\n  //     whitespace is what makes context disambiguation work — the doc's\n  //     normalized projection has a single space between block elements\n  //     before the needle, so trimming context tails would strand them at\n  //     punctuation and break commonSuffixLen.\n  function normalizeNeedle(s) {\n    return s ? s.replace(/\\s+/g, ' ').trim() : '';\n  }\n  function normalizeContext(s) {\n    return s ? s.replace(/\\s+/g, ' ') : '';\n  }\n  // Back-compat alias for older callers (getContext etc.) — they handle\n  // their own normalization where needed.\n  function normalizeQuery(s) { return normalizeNeedle(s); }\n  // Locate (node, offset) in the per-node map from a raw-string offset.\n  function locateAt(nodes, rawOffset) {\n    let lo = 0, hi = nodes.length - 1;\n    while (lo <= hi) {\n      const mid = (lo + hi) >> 1;\n      const n = nodes[mid];\n      if (rawOffset < n.start) hi = mid - 1;\n      else if (rawOffset > n.end) lo = mid + 1;\n      else return { node: n.node, offset: rawOffset - n.start };\n    }\n    return null;\n  }\n  // Anchor matching protocol (architectural):\n  //\n  //   Invariant: a text anchor resolves only when the saved context_before /\n  //   context_after agrees with the candidate location. The same `text` may\n  //   appear N times in the doc; context is the disambiguator that picks\n  //   THIS occurrence — moving the anchor (re-anchor) rewrites the context\n  //   to the new neighbors, so the matcher MUST refuse to fall back to the\n  //   first hit when context fails to match. Without this guard, re-anchor\n  //   silently re-resolves to the old location whenever the old text still\n  //   exists in the doc (the \"stale highlight\" bug).\n  //\n  //   We compare longer context windows (60 chars by default, scaled down\n  //   to what was saved) for stronger disambiguation, and require at least\n  //   one side to match to accept the hit. If no candidate clears the bar,\n  //   return null and let the caller fall back to the saved position ratio.\n  const CTX_MATCH_LEN = 60;\n  function findTextRange(anchor, cache) {\n    if (!anchor || !anchor.text || anchor.text.length < 2) return null;\n    const view = cache || collectTextNodes();\n    if (!view.norm) return null;\n\n    const needleN = normalizeNeedle(anchor.text);\n    if (needleN.length < 2) return null;\n    const beforeN = normalizeContext(anchor.context_before);\n    const afterN = normalizeContext(anchor.context_after);\n\n    const hits = [];\n    for (let i = 0; (i = view.norm.indexOf(needleN, i)) !== -1; i += Math.max(1, needleN.length)) {\n      hits.push(i);\n      if (hits.length > 64) break;\n    }\n    if (!hits.length) return null;\n\n    // Single hit and no saved context → unambiguous, accept.\n    // Multiple hits with no context → ambiguous, refuse.\n    const hasContext = beforeN.length > 0 || afterN.length > 0;\n    if (hits.length === 1 && !hasContext) {\n      return rangeFromNormalizedOffsets(view, hits[0], needleN.length);\n    }\n    if (!hasContext) return null;\n\n    // Score each hit by how many context chars match on each side. Require\n    // a *meaningful* match — at least MIN_CTX_MATCH chars — so we don't\n    // accept hits that only agree on trailing punctuation/spaces (\".\" or\n    // \": \"). That guard is what makes re-anchor robust: when the user\n    // moves the anchor, the new context_before/after refer to the new\n    // neighbors; the old location's punctuation overlap shouldn't be\n    // enough to keep the highlight there.\n    const MIN_CTX_MATCH = 4;\n    const ctxLen = CTX_MATCH_LEN;\n    const bTail = beforeN.slice(-Math.min(ctxLen, beforeN.length));\n    const aHead = afterN.slice(0, Math.min(ctxLen, afterN.length));\n    let bestIdx = -1, bestScore = 0;\n    for (const h of hits) {\n      const beforeSlice = view.norm.slice(Math.max(0, h - ctxLen), h);\n      const afterSlice = view.norm.slice(h + needleN.length, h + needleN.length + ctxLen);\n      const bScore = commonSuffixLen(beforeSlice, bTail);\n      const aScore = commonPrefixLen(afterSlice, aHead);\n      // A side counts only if it cleared the meaningful-match bar.\n      const score = (bScore >= MIN_CTX_MATCH ? bScore : 0) + (aScore >= MIN_CTX_MATCH ? aScore : 0);\n      if (score > bestScore) { bestScore = score; bestIdx = h; }\n    }\n    // Reject if no candidate cleared the meaningful-match bar. Caller will\n    // use the saved fallback ratio rather than highlight the wrong spot.\n    if (bestIdx === -1 || bestScore === 0) return null;\n\n    return rangeFromNormalizedOffsets(view, bestIdx, needleN.length);\n  }\n  function rangeFromNormalizedOffsets(view, normIdx, normLen) {\n    const rawStart = view.normToRaw[normIdx];\n    const rawEnd = view.normToRaw[normIdx + normLen] ?? view.total.length;\n    const startLoc = locateAt(view.nodes, rawStart);\n    const endLoc = locateAt(view.nodes, rawEnd);\n    if (!startLoc || !endLoc) return null;\n    const range = document.createRange();\n    try {\n      range.setStart(startLoc.node, startLoc.offset);\n      range.setEnd(endLoc.node, endLoc.offset);\n    } catch { return null; }\n    return range;\n  }\n  function commonSuffixLen(a, b) {\n    let i = 0;\n    const min = Math.min(a.length, b.length);\n    while (i < min && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;\n    return i;\n  }\n  function commonPrefixLen(a, b) {\n    let i = 0;\n    const min = Math.min(a.length, b.length);\n    while (i < min && a[i] === b[i]) i++;\n    return i;\n  }\n  function findElement(anchor) {\n    if (!anchor) return null;\n    // Server-side reconciliation may have marked the anchor as lost — the\n    // artifact is gone in this version. Render unanchored, never guess.\n    if (anchor.kind === 'lost') return null;\n\n    // 1. IDENTITY-FIRST: anchor.aid is the artifact's content-derived id\n    //    stamped by the worker. Same artifact across versions = same aid\n    //    iff its content didn't change. When content DID change between\n    //    versions, the worker mints a new aid in the new version AND\n    //    keeps the old aid in `anchor.aid_history` (newest first) so that\n    //    viewers of OLDER versions still resolve to the same comment.\n    const aidCandidates = [];\n    if (anchor.aid) aidCandidates.push(anchor.aid);\n    if (Array.isArray(anchor.aid_history)) {\n      for (const x of anchor.aid_history) if (x && !aidCandidates.includes(x)) aidCandidates.push(x);\n    }\n    const fromSelector = anchor.selector && (/\\[data-tdoc-aid=\"([^\"]+)\"\\]/.exec(anchor.selector) || [])[1];\n    if (fromSelector && !aidCandidates.includes(fromSelector)) aidCandidates.push(fromSelector);\n    if (aidCandidates.length) {\n      for (const aid of aidCandidates) {\n        const byAid = document.querySelector(`[data-tdoc-aid=\"${aid}\"]`);\n        if (byAid) return byAid;\n      }\n      // Recorded aid(s), none present in this DOM → unanchored, never fallback.\n      return null;\n    }\n\n    // 2. LEGACY PATH (pre-aid comments): try the stored selector, but\n    //    NEVER trust the result without fingerprint validation. A bare\n    //    positional selector can silently point at a different artifact.\n    let bySelector = null;\n    if (anchor.selector) {\n      try { bySelector = document.querySelector(anchor.selector); } catch { bySelector = null; }\n    }\n    const fp = anchor.fingerprint;\n\n    // 2a. Has fingerprint: trust selector ONLY if it matches the fp,\n    //     otherwise scan all candidates.\n    if (fp) {\n      if (bySelector && fingerprintScore(fp, elementFingerprint(bySelector)) >= 0.6) {\n        return bySelector;\n      }\n      let best = null, bestScore = 0;\n      const tag = fp.tag || '*';\n      let cands;\n      try { cands = document.querySelectorAll(tag); } catch { cands = []; }\n      cands.forEach(el => {\n        if (el.closest && el.closest(UI_ALL)) return;\n        const sc = fingerprintScore(fp, elementFingerprint(el));\n        if (sc > bestScore) { bestScore = sc; best = el; }\n      });\n      if (best && bestScore >= 0.6) return best;\n      // No confident match → unanchored, never the wrong artifact.\n      return null;\n    }\n\n    // 2b. No fingerprint AND no aid (truly legacy). Validate the selector\n    //     match against the stored `label` (the artifact's tag). If the\n    //     tag matches, accept it — but this path is fragile and the\n    //     server-side reconciliation should convert these to aid anchors\n    //     on the next upload, after which we never hit this branch again.\n    if (bySelector && (!anchor.label || bySelector.tagName.toLowerCase() === anchor.label.toLowerCase())) {\n      return bySelector;\n    }\n    return null;\n  }\n\n  // Fallback span path — only used when CSS.highlights is unavailable AND the\n  // range is single-text-node (no cross-element risk → no empty bars).\n  function fallbackWrapAsSpan(comment, range) {\n    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;\n    const mark = document.createElement('span');\n    mark.className = 'tdoc-anchor-mark';\n    mark.dataset.commentId = comment.id;\n    try { range.surroundContents(mark); return mark; } catch { return null; }\n  }\n  function unwrapFallbackSpans() {\n    document.querySelectorAll('.tdoc-anchor-mark').forEach(mark => {\n      const parent = mark.parentNode;\n      if (!parent) return;\n      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);\n      parent.removeChild(mark);\n      parent.normalize?.();\n    });\n  }\n\n  // ========== Reactions + comment cards ==========\n  const QUICK_EMOJIS = ['👍', '❤️', '🔥', '🎉', '😂', '🤔', '👀', '🚀', '✅', '❌', '❓', '❗'];\n  const QUICK_TEXT_REACTIONS = ['LGTM'];\n  const REACT_ICON_SVG = `<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8 14s1.5 2 4 2 4-2 4-2\"/><line x1=\"9\" y1=\"9\" x2=\"9.01\" y2=\"9\"/><line x1=\"15\" y1=\"9\" x2=\"15.01\" y2=\"9\"/><line x1=\"19\" y1=\"6\" x2=\"19\" y2=\"10\"/><line x1=\"21\" y1=\"8\" x2=\"17\" y2=\"8\"/></svg>`;\n\n  function renderAuthor(author) {\n    if (!author) return `<div class=\"author\"><span class=\"anon\">anonymous</span></div>`;\n    if (author.kind === 'agent') {\n      // Agent identity (currently always 'lucius-agent'). No avatar URL — use\n      // a generic icon-circle to differentiate from human commenters.\n      return `<div class=\"author lucius-agent-author\"><span class=\"lucius-agent-badge\">⚡</span><span class=\"login\">${escapeHtml(author.login || 'lucius-agent')}</span></div>`;\n    }\n    const avatar = author.avatar_url ? `<img src=\"${escapeHtml(author.avatar_url)}\" alt=\"\">` : '';\n    return `<div class=\"author\">${avatar}<span class=\"login\">${escapeHtml(author.login || 'anonymous')}</span></div>`;\n  }\n  function renderReactionsRow(target) {\n    const reactions = target.reactions || {};\n    const me = identity?.login || 'anon';\n    const entries = Object.entries(reactions).filter(([, u]) => u && u.length > 0);\n    if (!entries.length) return '';\n    const chips = entries.map(([emoji, users]) => {\n      const mine = users.includes(me);\n      const hasAgent = users.includes('lucius-agent');\n      const cls = [`tdoc-react-chip`, mine ? 'mine' : '', hasAgent ? 'agent' : ''].filter(Boolean).join(' ');\n      return `<span class=\"${cls}\" data-emoji=\"${escapeHtml(emoji)}\" data-target-id=\"${escapeHtml(target.id)}\" data-users=\"${users.map(escapeHtml).join('\\n')}\">${escapeHtml(emoji)} ${users.length}</span>`;\n    }).join('');\n    return `<div class=\"tdoc-reactions\" data-target-id=\"${escapeHtml(target.id)}\">${chips}<button class=\"tdoc-react-add\" data-target-id=\"${escapeHtml(target.id)}\" title=\"Add reaction\" aria-label=\"Add reaction\">${REACT_ICON_SVG}</button></div>`;\n  }\n  function renderReactInline(target) {\n    return `<button class=\"tdoc-react-add inline\" data-target-id=\"${escapeHtml(target.id)}\" title=\"Add reaction\" aria-label=\"Add reaction\">${REACT_ICON_SVG}</button>`;\n  }\n  function renderReply(reply) {\n    const canDelete = !isFork && (!isPublished || (identity && reply.author && identity.login === reply.author.login));\n    const hasReactions = reply.reactions && Object.values(reply.reactions).some(u => u && u.length > 0);\n    const isAgent = reply.author?.kind === 'agent';\n    // Whitelist the status (it drives a CSS class) instead of interpolating raw.\n    const safeStatus = ['applied', 'partial', 'question'].includes(reply.agent_status) ? reply.agent_status : null;\n    const statusChip = safeStatus\n      ? `<span class=\"lucius-agent-status lucius-agent-status-${safeStatus}\">${\n          safeStatus === 'applied' ? '✓ applied' :\n          safeStatus === 'partial' ? '◐ partial' :\n          '? question'\n        }</span>`\n      : '';\n    return `<div class=\"tdoc-reply${isAgent ? ' lucius-agent-reply' : ''}\" data-comment-id=\"${escapeHtml(reply.id)}\">\n      ${renderAuthor(reply.author)}\n      ${statusChip}\n      <div class=\"text\">${escapeHtml(reply.text)}</div>\n      ${hasReactions ? renderReactionsRow(reply) : ''}\n      <div class=\"meta\">\n        <span>${new Date(reply.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>\n        <span class=\"actions\">\n          ${!hasReactions && !isFork ? renderReactInline(reply) : ''}\n          ${canDelete ? `<span class=\"del\" data-id=\"${escapeHtml(reply.id)}\">delete</span>` : ''}\n        </span>\n      </div>\n    </div>`;\n  }\n  function buildCard(comment) {\n    const card = document.createElement('div');\n    card.className = 'tdoc-margin-comment';\n    card.dataset.commentId = comment.id;\n    const canDelete = !isFork && (!isPublished || (identity && comment.author && identity.login === comment.author.login));\n    const replies = Array.isArray(comment.replies) ? comment.replies : [];\n    const hasReactions = comment.reactions && Object.values(comment.reactions).some(u => u && u.length > 0);\n    card.innerHTML = `\n      ${isFork ? '' : `<div class=\"tdoc-anchor-actions\">\n        <button class=\"tdoc-reanchor-btn\" type=\"button\" data-id=\"${escapeHtml(comment.id)}\"><span class=\"tdoc-reanchor-unanchored\">unanchored — click to re-anchor</span><span class=\"tdoc-reanchor-anchored\">↻ move anchor</span></button>\n      </div>`}\n      ${renderAuthor(comment.author)}\n      <div class=\"text\">${escapeHtml(comment.text)}</div>\n      ${hasReactions ? renderReactionsRow(comment) : ''}\n      <div class=\"meta\">\n        <span>v${comment.version} · ${new Date(comment.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>\n        <span class=\"actions\">\n          ${!hasReactions && !isFork ? renderReactInline(comment) : ''}\n          ${isFork ? '' : `<span class=\"tdoc-reply-toggle\" data-id=\"${escapeHtml(comment.id)}\">Reply</span>`}\n          <span class=\"copy-md\" data-id=\"${escapeHtml(comment.id)}\" title=\"Copy as Markdown\" aria-label=\"Copy as Markdown\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg></span>\n          ${canDelete ? `<span class=\"del\" data-id=\"${escapeHtml(comment.id)}\">delete</span>` : ''}\n        </span>\n      </div>\n      ${replies.length ? `\n        <div class=\"tdoc-replies-toggle\" data-id=\"${escapeHtml(comment.id)}\">\n          <svg class=\"chev\" width=\"10\" height=\"10\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"9 18 15 12 9 6\"/></svg>\n          ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}\n        </div>\n        <div class=\"tdoc-replies\">${replies.map(r => renderReply(r)).join('')}</div>\n      ` : ''}\n      ${isFork ? '' : `<div class=\"tdoc-reply-form\" data-parent-id=\"${escapeHtml(comment.id)}\">\n        <textarea placeholder=\"Reply…\"></textarea>\n        <div class=\"tdoc-reply-form-foot\">\n          <span class=\"hint\">⌘+Enter to submit · Esc to cancel</span>\n          <button class=\"tdoc-reply-submit\">Reply</button>\n        </div>\n      </div>`}\n    `;\n\n    const repliesToggle = card.querySelector('.tdoc-replies-toggle');\n    const repliesEl = card.querySelector('.tdoc-replies');\n    if (repliesToggle && repliesEl) {\n      repliesToggle.onclick = (e) => {\n        e.stopPropagation();\n        const open = repliesEl.classList.toggle('open');\n        repliesToggle.classList.toggle('open', open);\n        requestAnimationFrame(repositionCards);\n      };\n    }\n\n    const copyMdBtn = card.querySelector('.copy-md');\n    if (copyMdBtn) copyMdBtn.onclick = (e) => { e.stopPropagation(); window.__tdocCopyCommentMd(comment.id, copyMdBtn); };\n\n    const reBtn = card.querySelector('.tdoc-reanchor-btn');\n    if (reBtn) reBtn.onclick = (e) => { e.stopPropagation(); startReanchor(comment.id); };\n\n    card.querySelectorAll('.del').forEach(del => {\n      del.onclick = async (e) => {\n        e.stopPropagation();\n        const r = await fetch(`/api/comments?slug=${encodeURIComponent(slug)}&id=${del.dataset.id}&version=${version}`, { method: 'DELETE' });\n        if (!r.ok) {\n          // Surface the failure instead of silently re-rendering the comment.\n          const err = await r.json().catch(() => ({}));\n          alert('Could not delete: ' + (err.error || err.message || `HTTP ${r.status}`));\n          return;\n        }\n        // Belt + suspenders: drop the active highlight before refresh in case\n        // the deleted comment was the active one (which would leave a stale\n        // ::highlight(tdoc-anchor-active) ring until refresh completes).\n        setActiveComment(null);\n        await refreshComments();\n      };\n    });\n\n    const replyToggle = card.querySelector('.tdoc-reply-toggle');\n    const replyForm = card.querySelector('.tdoc-reply-form');\n    if (replyToggle && replyForm) {\n      replyToggle.onclick = (e) => {\n        e.stopPropagation();\n        if (isPublished && !identity) { startDeviceFlow(); return; }\n        replyForm.classList.toggle('open');\n        if (replyForm.classList.contains('open')) {\n          replyForm.querySelector('textarea').focus();\n          requestAnimationFrame(repositionCards);\n        }\n      };\n      const replyTa = replyForm.querySelector('textarea');\n      const submitReply = async () => {\n        const text = replyTa.value.trim();\n        if (!text) return;\n        const r = await fetch('/api/comments', {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ slug, parent_id: comment.id, text, version })\n        });\n        if (r.status === 401) { startDeviceFlow(); return; }\n        replyTa.value = '';\n        replyForm.classList.remove('open');\n        await refreshComments();\n      };\n      replyForm.querySelector('.tdoc-reply-submit').onclick = (e) => { e.stopPropagation(); submitReply(); };\n      replyTa.addEventListener('keydown', (e) => {\n        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitReply(); }\n        if (e.key === 'Escape') { replyForm.classList.remove('open'); requestAnimationFrame(repositionCards); }\n      });\n    }\n\n    card.querySelectorAll('.tdoc-react-chip').forEach(chip => {\n      chip.onclick = async (e) => {\n        e.stopPropagation();\n        if (isFork) return; // read-only mode\n        if (isPublished && !identity) { startDeviceFlow(); return; }\n        await fetch('/api/reactions', {\n          method: 'POST', headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ slug, comment_id: chip.dataset.targetId, emoji: chip.dataset.emoji, version })\n        });\n        await refreshComments();\n      };\n    });\n    card.querySelectorAll('.tdoc-react-add').forEach(addBtn => {\n      addBtn.onclick = (e) => {\n        e.stopPropagation();\n        if (isPublished && !identity) { startDeviceFlow(); return; }\n        openEmojiPicker(addBtn, addBtn.dataset.targetId);\n      };\n    });\n\n    card.addEventListener('click', (e) => { e.stopPropagation(); setActiveComment(comment.id); });\n    return card;\n  }\n\n  // ========== Emoji picker ==========\n  let emojiPicker = null;\n  function closeEmojiPicker() { if (emojiPicker) { emojiPicker.remove(); emojiPicker = null; } }\n  function openEmojiPicker(anchorBtn, targetId) {\n    closeEmojiPicker();\n    emojiPicker = document.createElement('div');\n    emojiPicker.className = 'tdoc-emoji-picker';\n    emojiPicker.innerHTML =\n      QUICK_EMOJIS.map(e => `<button data-emoji=\"${e}\">${e}</button>`).join('') +\n      QUICK_TEXT_REACTIONS.map(t => `<button class=\"tdoc-emoji-text\" data-emoji=\"${t}\">${t}</button>`).join('');\n    document.body.appendChild(emojiPicker);\n    const r = anchorBtn.getBoundingClientRect();\n    emojiPicker.style.visibility = 'hidden';\n    emojiPicker.style.top = '0'; emojiPicker.style.left = '0';\n    const pw = emojiPicker.offsetWidth, ph = emojiPicker.offsetHeight;\n    let left = window.scrollX + r.left;\n    let top = window.scrollY + r.bottom + 6;\n    const vpRight = window.scrollX + window.innerWidth - 8;\n    if (left + pw > vpRight) left = Math.max(8, (window.scrollX + r.right) - pw);\n    const vpBottom = window.scrollY + window.innerHeight - 8;\n    if (top + ph > vpBottom) top = window.scrollY + r.top - ph - 6;\n    emojiPicker.style.top = top + 'px'; emojiPicker.style.left = left + 'px';\n    emojiPicker.style.visibility = '';\n    emojiPicker.querySelectorAll('button').forEach(b => {\n      b.onclick = async (e) => {\n        e.stopPropagation();\n        const emoji = b.dataset.emoji;\n        closeEmojiPicker();\n        await fetch('/api/reactions', {\n          method: 'POST', headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ slug, comment_id: targetId, emoji, version })\n        });\n        await refreshComments();\n      };\n    });\n  }\n\n  // ========== Card positioning + active state ==========\n  // Single source of truth for \"where does the article column live?\".\n  // Returns viewport-coord metrics for the widest non-UI container element.\n  // Caller can add window.scrollX to `right`/`left` for page coords.\n  const ARTICLE_EXCLUDE = UI_CONTAINERS;\n  function getArticleMetrics() {\n    const candidates = document.querySelectorAll('main, article, .wrap, .content, .container');\n    let best = null, bestRect = null, bestW = 0;\n    for (const el of candidates) {\n      if (el.closest(ARTICLE_EXCLUDE)) continue;\n      const r = el.getBoundingClientRect();\n      if (r.width > bestW && r.width > 200 && r.width < window.innerWidth) {\n        best = el; bestRect = r; bestW = r.width;\n      }\n    }\n    if (best) {\n      return { el: best, width: bestRect.width, right: bestRect.right, left: bestRect.left };\n    }\n    // Fallback: pick the widest prose-ish element so margin cards have somewhere\n    // to anchor on pages with no wrapping container.\n    let fbRight = 0, fbLeft = 0, fbW = 0;\n    for (const el of document.querySelectorAll('p, h1, h2, h3')) {\n      if (el.closest(ARTICLE_EXCLUDE)) continue;\n      const r = el.getBoundingClientRect();\n      if (r.width > fbW && r.width > 300 && r.width < window.innerWidth) {\n        fbW = r.width; fbRight = r.right; fbLeft = r.left;\n      }\n    }\n    if (fbW > 0) {\n      return { el: document.body, width: fbW, right: fbRight, left: fbLeft };\n    }\n    return { el: document.body, width: Infinity, right: 0, left: 0 };\n  }\n\n  function repositionCards() {\n    // Always reposition element outlines first — they should track their\n    // anchor element on every layout change regardless of narrow/wide mode.\n    document.querySelectorAll('.tdoc-element-outline:not(.pending)').forEach(o => o._reposition?.());\n    if (state.narrow) {\n      for (const card of state.cardEls.values()) { card.style.top = ''; card.style.left = ''; }\n      return;\n    }\n    const margin = 12, cardGap = 16, cardWidth = 280;\n    const metrics = getArticleMetrics();\n    const rightEdge = metrics.width > 0 && metrics.right > 0\n      ? metrics.right + window.scrollX\n      : window.innerWidth - 320;\n    let cardLeft = rightEdge + cardGap;\n    const maxLeft = window.scrollX + window.innerWidth - cardWidth - 12;\n    if (cardLeft > maxLeft) cardLeft = maxLeft;\n\n    // Unified layout: every card (anchored + unanchored with fallback) is\n    // placed in a single Y-sorted pass. This eliminates the inter-group\n    // overlap class — previously anchored cards and unanchored-with-fallback\n    // cards used independent prevBottoms and could land on top of each\n    // other when their Ys interleaved.\n    //\n    // Cards without a fallback ratio (legacy comments) park below the\n    // article in stable id order — their Y depends only on themselves and\n    // the article height, so adding/removing other cards doesn't ripple.\n    const articleEl = metrics.el || document.body;\n    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;\n    const articleHeight = Math.max(1, articleEl.scrollHeight);\n\n    const rows = [];\n    for (const c of state.activeComments) {\n      const card = state.cardEls.get(c.id);\n      if (!card) continue;\n      const mark = state.anchorMarks.get(c.id);\n      if (mark && (mark.ranges?.[0] || mark.el)) {\n        // Anchored: place at its anchor's vertical position.\n        const r = (mark.ranges?.[0] || mark.el).getBoundingClientRect();\n        rows.push({ card, c, y: r.top + window.scrollY, anchored: true });\n      } else if (c.anchor?.fallback && typeof c.anchor.fallback.ratio === 'number') {\n        // Unanchored with saved fallback: place at the original ratio.\n        rows.push({ card, c, y: articleTop + c.anchor.fallback.ratio * articleHeight, anchored: false });\n      }\n    }\n    rows.sort((a, b) => a.y - b.y);\n\n    let prevBottom = 0;\n    for (const row of rows) {\n      let y = row.y;\n      if (y < prevBottom + margin) y = prevBottom + margin;\n      row.card.style.top = y + 'px';\n      row.card.style.left = cardLeft + 'px';\n      if (row.anchored) row.card.classList.remove('tdoc-unanchored');\n      else {\n        row.card.classList.add('tdoc-unanchored');\n        // Ghost marker shows where the deleted text USED to be — only\n        // meaningful when the anchor was lost involuntarily (the doc was\n        // rewritten). When the user explicitly removed the anchor via the\n        // \"Remove anchor\" pill, we set kind:'none' and shouldn't render a\n        // ghost at all (they intentionally cleared it).\n        if (row.c.anchor?.kind !== 'none') {\n          renderGhostMarker(row.c.id, articleTop + row.c.anchor.fallback.ratio * articleHeight);\n        } else {\n          removeGhostMarker(row.c.id);\n        }\n      }\n      prevBottom = y + row.card.offsetHeight;\n    }\n\n    // Legacy cards without fallback go below the article, stable id-sorted.\n    const articleBottom = articleTop + articleHeight;\n    const withoutFb = state.activeComments\n      .map(c => ({ c, card: state.cardEls.get(c.id) }))\n      .filter(x => x.card && !state.anchorMarks.get(x.c.id) && !(x.c.anchor?.fallback && typeof x.c.anchor.fallback.ratio === 'number'))\n      .sort((a, b) => (a.c.id || '').localeCompare(b.c.id || ''));\n    let tailY = Math.max(articleBottom + 32, prevBottom + margin);\n    for (const { card } of withoutFb) {\n      card.style.top = tailY + 'px';\n      card.style.left = cardLeft + 'px';\n      card.classList.add('tdoc-unanchored');\n      tailY += card.offsetHeight + margin;\n    }\n  }\n\n  function renderGhostMarker(commentId, pageY) {\n    let g = document.querySelector(`.tdoc-ghost-marker[data-comment-id=\"${CSS.escape(commentId)}\"]`);\n    if (!g) {\n      g = document.createElement('div');\n      g.className = 'tdoc-ghost-marker';\n      g.dataset.commentId = commentId;\n      document.body.appendChild(g);\n    }\n    g.style.top = pageY + 'px';\n  }\n  function removeGhostMarker(commentId) {\n    const g = document.querySelector(`.tdoc-ghost-marker[data-comment-id=\"${CSS.escape(commentId)}\"]`);\n    if (g) g.remove();\n  }\n\n  function setActiveComment(id) {\n    state.activeId = id || null;\n    document.querySelectorAll('.tdoc-anchor-mark.active, .tdoc-margin-comment.active, .tdoc-element-outline.active')\n      .forEach(el => el.classList.remove('active'));\n    if (!id) { rebuildSharedHighlights(); return; }\n    const mark = state.anchorMarks.get(id);\n    if (mark?.el?.classList) mark.el.classList.add('active');\n    const card = state.cardEls.get(id);\n    card?.classList.add('active');\n    rebuildSharedHighlights();\n    // Do NOT reposition cards on click — only the .active highlight should\n    // change. Reordering cards every click is disorienting; users expect\n    // stable positions and just the visual cue swap. Cards keep whatever\n    // layout repositionCards() established at refresh/resize time.\n    scrollAnchorIntoView(id);\n  }\n\n  function scrollAnchorIntoView(id) {\n    const mark = state.anchorMarks.get(id);\n    if (!mark) return;\n    let anchorRect = null;\n    // Prefer the underlying TARGET ELEMENT (canvas/img/video etc) over the\n    // overlay outline div — same rect, but more semantically correct.\n    if (mark.ranges?.[0]) anchorRect = mark.ranges[0].getBoundingClientRect();\n    else if (mark.targetEl?.getBoundingClientRect) anchorRect = mark.targetEl.getBoundingClientRect();\n    else if (mark.el?.getBoundingClientRect) anchorRect = mark.el.getBoundingClientRect();\n    if (!anchorRect) return;\n\n    // We consider the anchor \"comfortably visible\" if its top is between the\n    // bar (44px) and 60% of the viewport. Otherwise smooth-scroll so it lands\n    // in the upper third — readable, with room for the card next to it.\n    const barH = 44;\n    const top = anchorRect.top;\n    const vpH = window.innerHeight;\n    const comfortableMin = barH + 80;\n    const comfortableMax = vpH * 0.6;\n    if (top >= comfortableMin && top <= comfortableMax) return;\n    const targetTop = vpH * 0.25;          // land at 25% of viewport\n    const delta = top - targetTop;\n    window.scrollBy({ top: delta, behavior: 'smooth' });\n  }\n\n  // ========== Element outlines (saved + pending) ==========\n  function outlineElement(comment) {\n    const el = findElement(comment.anchor);\n    if (!el) return null;\n    const outline = document.createElement('div');\n    outline.className = 'tdoc-element-outline';\n    outline.dataset.commentId = comment.id;\n    document.body.appendChild(outline);\n    const repos = () => positionOutlineAround(outline, el);\n    repos();\n    outline._reposition = repos;\n    outline._targetEl = el;\n    outline.style.pointerEvents = 'none';\n    return { el: outline, targetEl: el };\n  }\n\n  // Tear down every per-comment artifact before a refresh: highlights, fallback\n  // spans, outlines (preserving the in-flight 'pending' one), margin cards, and\n  // both lookup maps. Anchored state must be reconstructed from the fresh list.\n  function resetAnchors() {\n    clearAllCommentHighlights();\n    unwrapFallbackSpans();\n    document.querySelectorAll('.tdoc-element-outline:not(.pending)').forEach(el => el.remove());\n    document.querySelectorAll('.tdoc-ghost-marker').forEach(el => el.remove());\n    for (const card of commentLayer.querySelectorAll('.tdoc-margin-comment')) card.remove();\n    state.anchorMarks.clear();\n    state.cardEls.clear();\n  }\n\n  // ========== refreshComments ==========\n  async function refreshComments() {\n    resetAnchors();\n\n    let list = [];\n    if (isFork) {\n      // Read-only: parse the embedded JSON. No /api calls.\n      const block = document.getElementById('tdoc-fork-comments');\n      if (block) {\n        try { list = (JSON.parse(block.textContent || '{}').comments) || []; } catch { list = []; }\n      }\n    } else {\n      try {\n        const r = await fetch(`/api/comments?slug=${encodeURIComponent(slug)}&version=${version}`);\n        list = await r.json();\n      } catch { list = []; }\n    }\n    state.activeComments = list.filter(c => c.status !== 'resolved');\n    document.body.classList.toggle('tdoc-has-comments', state.activeComments.length > 0);\n    document.body.dataset.tdocReady = '1';\n\n    const fabCount = document.getElementById('tdoc-fab-count');\n    if (fabCount) fabCount.textContent = state.activeComments.length;\n\n    const textCache = state.activeComments.some(c => (c.anchor?.kind || (c.anchor?.text ? 'text' : null)) === 'text')\n      ? collectTextNodes() : null;\n    for (const comment of state.activeComments) {\n      const kind = comment.anchor?.kind || (comment.anchor?.text ? 'text' : null);\n      if (kind === 'text') {\n        const range = findTextRange(comment.anchor, textCache);\n        if (range) {\n          if (HIGHLIGHT_API) {\n            state.anchorMarks.set(comment.id, { kind: 'text', ranges: [range] });\n          } else {\n            const span = fallbackWrapAsSpan(comment, range);\n            if (span) {\n              span.addEventListener('click', (e) => { e.stopPropagation(); setActiveComment(comment.id); });\n              span.style.cursor = 'pointer';\n              state.anchorMarks.set(comment.id, { kind: 'text', el: span });\n            }\n          }\n        }\n      } else if (kind === 'element') {\n        const out = outlineElement(comment);\n        if (out) {\n          out.targetEl.addEventListener('click', (e) => { e.stopPropagation(); setActiveComment(comment.id); });\n          if (out.targetEl.style) out.targetEl.style.cursor = 'pointer';\n          state.anchorMarks.set(comment.id, { kind: 'element', el: out.el, targetEl: out.targetEl });\n        }\n      }\n      const card = buildCard(comment);\n      commentLayer.appendChild(card);\n      state.cardEls.set(comment.id, card);\n    }\n    rebuildSharedHighlights();\n    evaluateLayout();\n    requestAnimationFrame(repositionCards);\n  }\n\n  // Click on a Highlight-API range → activate. Highlight API has no per-range\n  // event so we delegate from a root click handler by hit-testing ranges.\n  function findCommentAtPoint(x, y) {\n    if (!HIGHLIGHT_API) return null;\n    for (const [id, mark] of state.anchorMarks) {\n      if (!mark.ranges) continue;\n      for (const r of mark.ranges) {\n        const rects = r.getClientRects();\n        for (let i = 0; i < rects.length; i++) {\n          const rect = rects[i];\n          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;\n        }\n      }\n    }\n    return null;\n  }\n\n  // ========== Narrow mode (single source of truth) ==========\n  function evaluateLayout() {\n    const MIN_ARTICLE_WIDTH = 400;\n    const MIN_COLUMN_WIDTH = 300;\n    const isPhone = window.innerWidth < 700;\n    const metrics = getArticleMetrics();\n    const articleWidth = metrics.el === document.body ? Infinity : metrics.width;\n    const articleRight = metrics.el === document.body ? 0 : metrics.right;\n    const columnRoom = window.innerWidth - articleRight;\n    const narrow = isPhone || articleWidth < MIN_ARTICLE_WIDTH || columnRoom < MIN_COLUMN_WIDTH;\n    state.narrow = narrow;\n    document.body.classList.toggle('tdoc-narrow', narrow);\n    fab.style.display = (narrow && state.activeComments.length > 0) ? 'inline-flex' : 'none';\n    if (!narrow) commentLayer.classList.remove('open');\n  }\n\n  window.addEventListener('resize', () => requestAnimationFrame(() => { evaluateLayout(); repositionCards(); }));\n  // Esc cancels re-anchor mode globally.\n  document.addEventListener('keydown', (e) => {\n    if (e.key === 'Escape' && state.reanchoringId) exitReanchor();\n  });\n  window.addEventListener('scroll', () => requestAnimationFrame(repositionCards), { passive: true });\n  if (window.ResizeObserver) new ResizeObserver(() => repositionCards()).observe(document.body);\n\n  // ========== Auth (Device Flow) ==========\n  // GitHub returns \"slow_down\" if we poll faster than its current interval —\n  // and once it does, we must bump our interval by ≥5s or it will keep\n  // refusing forever. Use a chained setTimeout so each tick can adjust the\n  // delay before scheduling the next.\n  let pollTimer = null;\n  let pollInterval = 5;\n  async function startDeviceFlow() {\n    if (!isPublished) return;\n    const r = await fetch('/api/auth/device/start', { method: 'POST' });\n    const data = await r.json();\n    if (data.error) { alert('Sign-in error: ' + (data.message || data.error)); return; }\n    showDeviceModal(data);\n    window.open(data.verification_uri, '_blank');\n    pollInterval = Math.max(5, data.interval || 5);\n    schedulePoll(data.device_code);\n  }\n  function schedulePoll(device_code) {\n    pollTimer = setTimeout(() => pollDevice(device_code), pollInterval * 1000);\n  }\n  function showDeviceModal(data) {\n    const bg = document.createElement('div');\n    bg.className = 'tdoc-modal-bg';\n    bg.id = 'tdoc-device-modal';\n    bg.innerHTML = `\n      <div class=\"tdoc-modal\">\n        <h3>Sign in with GitHub</h3>\n        <div class=\"step\"><span class=\"n\">1</span><span>Copy this code:</span></div>\n        <div class=\"code\" id=\"tdoc-user-code\">${data.user_code}</div>\n        <div class=\"step\"><span class=\"n\">2</span><span>Paste it at <b>${data.verification_uri}</b> (opened in a new tab) and approve.</span></div>\n        <div class=\"step\"><span class=\"n\">3</span><span class=\"status\" id=\"tdoc-poll-status\">Waiting for you to approve…</span></div>\n        <div class=\"actions\"><button id=\"tdoc-modal-cancel\">Cancel</button></div>\n      </div>`;\n    document.body.appendChild(bg);\n    document.getElementById('tdoc-user-code').onclick = () => navigator.clipboard?.writeText(data.user_code);\n    document.getElementById('tdoc-modal-cancel').onclick = closeDeviceModal;\n  }\n  function closeDeviceModal() {\n    const m = document.getElementById('tdoc-device-modal');\n    if (m) m.remove();\n    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }\n  }\n\n  // ========== Publish / Share modals ==========\n  function closeAuxModal() {\n    const m = document.getElementById('tdoc-aux-modal');\n    if (m) m.remove();\n  }\n  function showPublishModal() {\n    closeAuxModal();\n    const bg = document.createElement('div');\n    bg.className = 'tdoc-modal-bg';\n    bg.id = 'tdoc-aux-modal';\n    bg.innerHTML = `\n      <div class=\"tdoc-modal\" data-state=\"idle\">\n        <h3>Publish this doc</h3>\n        <p>We'll deploy this to your Cloudflare Worker so anyone with the link can read it. GitHub sign-in is required for commenting.</p>\n        <div class=\"step\"><span class=\"n\">·</span><span>Slug: <code id=\"tdoc-pub-slug\">${escapeHtml(slug)}</code></span></div>\n        <div class=\"status\" id=\"tdoc-pub-status\" style=\"margin-top:10px;display:none;\"></div>\n        <div id=\"tdoc-pub-result\" style=\"margin-top:10px;display:none;\">\n          <div class=\"code\" style=\"font-size:14px;letter-spacing:0;text-align:left;\" id=\"tdoc-pub-url\"></div>\n          <div class=\"actions\" style=\"justify-content:flex-start;gap:8px;\">\n            <button class=\"primary\" id=\"tdoc-pub-copy\">Copy link</button>\n            <button id=\"tdoc-pub-open\">View live →</button>\n          </div>\n        </div>\n        <div class=\"actions\">\n          <button id=\"tdoc-pub-cancel\">Cancel</button>\n          <button class=\"primary\" id=\"tdoc-pub-go\">Publish</button>\n        </div>\n      </div>`;\n    document.body.appendChild(bg);\n    document.getElementById('tdoc-pub-cancel').onclick = closeAuxModal;\n    document.getElementById('tdoc-pub-go').onclick = async () => {\n      const status = document.getElementById('tdoc-pub-status');\n      const go = document.getElementById('tdoc-pub-go');\n      status.style.display = 'block';\n      status.textContent = 'Publishing — this can take 20–60s on first run…';\n      go.disabled = true;\n      try {\n        const r = await fetch('/api/publish', {\n          method: 'POST', headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ slug })\n        });\n        const data = await r.json();\n        if (!r.ok || data.error) {\n          status.textContent = 'Failed: ' + (data.error || data.message || 'unknown');\n          go.disabled = false;\n          return;\n        }\n        const url = data.url;\n        status.style.display = 'none';\n        const result = document.getElementById('tdoc-pub-result');\n        result.style.display = 'block';\n        document.getElementById('tdoc-pub-url').textContent = url;\n        document.getElementById('tdoc-pub-copy').onclick = () => navigator.clipboard?.writeText(url);\n        document.getElementById('tdoc-pub-open').onclick = () => window.open(url, '_blank');\n        document.getElementById('tdoc-pub-go').style.display = 'none';\n        document.getElementById('tdoc-pub-cancel').textContent = 'Done';\n      } catch (e) {\n        status.textContent = 'Failed: ' + e.message;\n        go.disabled = false;\n      }\n    };\n  }\n  function showShareModal() {\n    closeAuxModal();\n    const url = `${location.origin}/d/${encodeURIComponent(slug)}/v/${version}`;\n    const bg = document.createElement('div');\n    bg.className = 'tdoc-modal-bg';\n    bg.id = 'tdoc-aux-modal';\n    bg.innerHTML = `\n      <div class=\"tdoc-modal\">\n        <h3>Share this doc</h3>\n        <div class=\"code\" id=\"tdoc-share-url\" style=\"font-size:14px;letter-spacing:0;text-align:left;cursor:copy;\">${escapeHtml(url)}</div>\n        <div class=\"actions\" style=\"justify-content:flex-start;gap:8px;margin-top:0;margin-bottom:10px;\">\n          <button class=\"primary\" id=\"tdoc-share-copy\">Copy link</button>\n        </div>\n        <p class=\"muted\">Anyone with this link can read. To comment, they sign in with GitHub.</p>\n        <div class=\"divider\">\n          <p class=\"danger\" style=\"margin:0 0 6px;\"><b>Unpublish</b></p>\n          <p class=\"muted\" style=\"margin:0 0 6px;font-size:12px;\">Unpublish requires the upload token, which only lives on your laptop. Run this locally:</p>\n          <div class=\"code\" style=\"font-size:13px;letter-spacing:0;text-align:left;cursor:copy;\" id=\"tdoc-share-unpub\">lucius unpublish ${escapeHtml(slug)}</div>\n        </div>\n        <div class=\"actions\"><button id=\"tdoc-share-close\">Close</button></div>\n      </div>`;\n    document.body.appendChild(bg);\n    document.getElementById('tdoc-share-close').onclick = closeAuxModal;\n    document.getElementById('tdoc-share-copy').onclick = () => navigator.clipboard?.writeText(url);\n    document.getElementById('tdoc-share-url').onclick = () => navigator.clipboard?.writeText(url);\n    document.getElementById('tdoc-share-unpub').onclick = (e) => {\n      navigator.clipboard?.writeText(e.currentTarget.textContent);\n    };\n  }\n  async function pollDevice(device_code) {\n    const status = document.getElementById('tdoc-poll-status');\n    pollTimer = null;\n    try {\n      const r = await fetch('/api/auth/device/poll', {\n        method: 'POST', headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ device_code })\n      });\n      const data = await r.json();\n      if (data.ok && data.identity) {\n        identity = data.identity;\n        closeDeviceModal();\n        renderIdentity();\n        refreshComments();\n        return;\n      }\n      // slow_down: GitHub explicitly told us to back off. Bump interval by 5s\n      // (per RFC 8628 §3.5) before scheduling the next poll, otherwise GitHub\n      // will keep rejecting at the same cadence forever.\n      if (data.error === 'slow_down') {\n        // GitHub may suggest a new interval; otherwise add 5s.\n        pollInterval = Math.max(pollInterval + 5, Number(data.interval) || 0);\n        schedulePoll(device_code);\n        return;\n      }\n      if (data.error === 'authorization_pending' || (data.pending && !data.error)) {\n        schedulePoll(device_code);\n        return;\n      }\n      if (data.error === 'expired_token' || data.error === 'access_denied') {\n        if (status) status.textContent = 'Code expired or denied. Try again.';\n        return;\n      }\n      // Any other error (no_user, github_unreachable, 500) — show it and stop.\n      if (data.error || !r.ok) {\n        if (status) status.textContent = 'Sign-in failed: ' + (data.message || data.error || `HTTP ${r.status}`) + '. Try again.';\n        return;\n      }\n      // Fallback: unknown shape, keep polling at current interval.\n      schedulePoll(device_code);\n    } catch (e) {\n      if (status) status.textContent = 'Network error: ' + e.message + ' — retrying…';\n      schedulePoll(device_code);\n    }\n  }\n\n  // ========== Popup (new-comment): text + element anchors ==========\n  let popup = null;\n  let pendingElementOutline = null;\n\n  function setPendingTextHighlight(range) {\n    if (!HIGHLIGHT_API || !range) return;\n    pendingHighlight.clear();\n    pendingHighlight.add(range);\n  }\n  function clearPendingTextHighlight() {\n    if (HIGHLIGHT_API) pendingHighlight.clear();\n  }\n  function setPendingElementOutline(el) {\n    clearPendingElementOutline();\n    pendingElementOutline = document.createElement('div');\n    pendingElementOutline.className = 'tdoc-element-outline pending';\n    positionOutlineAround(pendingElementOutline, el);\n    document.body.appendChild(pendingElementOutline);\n  }\n  function clearPendingElementOutline() {\n    if (pendingElementOutline) { pendingElementOutline.remove(); pendingElementOutline = null; }\n  }\n  function closePopup() {\n    if (popup) { popup.remove(); popup = null; }\n    clearPendingTextHighlight();\n    clearPendingElementOutline();\n  }\n\n  function openPopup(anchor, rect) {\n    if (isFork) return; // read-only fork view: no new comments\n    closePopup();\n    hideHoverUI();\n    popup = document.createElement('div');\n    popup.className = 'tdoc-popup';\n    const needsSignIn = isPublished && !identity;\n    const preview = anchor.kind === 'text'\n      ? `\"${escapeHtml(anchor.text.slice(0, 80))}${anchor.text.length > 80 ? '…' : ''}\"`\n      : `📎 ${escapeHtml(anchor.label)}`;\n    popup.innerHTML = `\n      <div class=\"head\"><span class=\"h\">${preview}</span><span class=\"x\">×</span></div>\n      ${needsSignIn ? '<div class=\"signin-needed\">Sign in with GitHub to comment.</div>' : ''}\n      <textarea placeholder=\"What should change?\" ${needsSignIn ? 'disabled' : ''}></textarea>\n      <div class=\"foot\">\n        <span class=\"hint\">${needsSignIn ? '' : '⌘+Enter to submit'}</span>\n        <button class=\"submit\">${needsSignIn ? 'Sign in' : 'Comment'}</button>\n      </div>`;\n    // Default: open below `rect` (used for text-selection popups so it follows\n    // the cursor). For element anchors invoked via the Comment pill, we want\n    // the popup to open ABOVE the pill so it doesn't dive into the artifact\n    // body. The caller signals this by setting anchor._placeAbove = true.\n    document.body.appendChild(popup);   // append first so offsetHeight is known\n    const popupH = popup.offsetHeight || 140;\n    if (anchor._placeAbove && rect.top - 8 - popupH >= 8) {\n      popup.style.top = (window.scrollY + rect.top - popupH - 8) + 'px';\n    } else {\n      popup.style.top = (window.scrollY + rect.bottom + 8) + 'px';\n    }\n    const left = Math.min(rect.left + window.scrollX, window.innerWidth - 340);\n    popup.style.left = Math.max(8, left) + 'px';\n\n    if (anchor.kind === 'text' && anchor._range) {\n      setPendingTextHighlight(anchor._range);\n      window.getSelection()?.removeAllRanges();\n    } else if (anchor.kind === 'element' && anchor._el) {\n      setPendingElementOutline(anchor._el);\n    }\n\n    const textarea = popup.querySelector('textarea');\n    // Defer focus past the click cycle that follows mouseup — otherwise the\n    // root click handler can steal focus back and the user has to click the\n    // popup before they can type.\n    if (!needsSignIn) requestAnimationFrame(() => textarea.focus());\n    popup.querySelector('.x').onclick = closePopup;\n\n    const submit = async () => {\n      if (needsSignIn) { closePopup(); startDeviceFlow(); return; }\n      const text = textarea.value.trim();\n      if (!text) return;\n      // Capture a fallback position so the card can stay roughly in place\n      // even when the anchor text is later rewritten. articleY is the\n      // anchor's vertical center, measured as a fraction of the article's\n      // height — stable across viewport widths. nearestHeading is the id\n      // (or text) of the closest preceding h1/h2/h3, used as a structural\n      // landmark if the text-anchor fails entirely.\n      const fallback = captureFallbackPosition(anchor);\n      const sendAnchor = anchor.kind === 'text'\n        ? { kind: 'text', text: anchor.text, context_before: anchor.context_before, context_after: anchor.context_after, fallback }\n        : { kind: 'element', selector: anchor.selector, label: anchor.label,\n            // IDENTITY-FIRST: persist the worker-stamped artifact id so\n            // future resolution is by content identity, not DOM position.\n            // Same artifact in any future version = same aid.\n            aid: anchor._el ? elementAid(anchor._el) : null,\n            // Fingerprint is the legacy fallback for any pre-aid docs.\n            fingerprint: anchor._el ? elementFingerprint(anchor._el) : null,\n            fallback };\n      const r = await fetch('/api/comments', {\n        method: 'POST', headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ slug, version, anchor: sendAnchor, text })\n      });\n      if (r.status === 401) { closePopup(); startDeviceFlow(); return; }\n      await r.json().catch(() => null);\n      closePopup();\n      await refreshComments();\n    };\n    popup.querySelector('.submit').onclick = submit;\n    textarea.addEventListener('keydown', (e) => {\n      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();\n      if (e.key === 'Escape') closePopup();\n    });\n  }\n\n  // Capture position metadata at create time. Used when the saved text\n  // anchor no longer resolves (the doc was rewritten) — the card still\n  // lands near the original location instead of falling to the bottom.\n  function captureFallbackPosition(anchor) {\n    const metrics = getArticleMetrics();\n    const articleEl = metrics.el || document.body;\n    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;\n    const articleHeight = Math.max(1, articleEl.scrollHeight);\n    let rect = null;\n    if (anchor.kind === 'text' && anchor._range) rect = anchor._range.getBoundingClientRect();\n    else if (anchor.kind === 'element' && anchor._el) rect = anchor._el.getBoundingClientRect();\n    if (!rect) return null;\n    const centerY = rect.top + rect.height / 2 + window.scrollY;\n    const ratio = Math.max(0, Math.min(1, (centerY - articleTop) / articleHeight));\n    // Find the nearest preceding heading for a structural landmark.\n    let nearestHeading = null;\n    const headings = document.querySelectorAll('h1, h2, h3');\n    for (const h of headings) {\n      if (h.closest(UI_CONTAINERS)) continue;\n      const hr = h.getBoundingClientRect();\n      if (hr.top + window.scrollY <= centerY) {\n        nearestHeading = { id: h.id || null, text: h.textContent.trim().slice(0, 80) };\n      } else break;\n    }\n    return { ratio, nearestHeading };\n  }\n\n  function getContext(range, chars) {\n    // Use the same flattened-text view that findTextRange searches, so saved\n    // context can disambiguate hits across element boundaries.\n    try {\n      const { nodes, total } = collectTextNodes();\n      const startLoc = nodes.find(n => n.node === range.startContainer);\n      const endLoc = nodes.find(n => n.node === range.endContainer);\n      if (!startLoc || !endLoc) return { before: '', after: '' };\n      const startG = startLoc.start + range.startOffset;\n      const endG = endLoc.start + range.endOffset;\n      return {\n        before: total.slice(Math.max(0, startG - chars), startG),\n        after: total.slice(endG, endG + chars),\n      };\n    } catch { return { before: '', after: '' }; }\n  }\n\n  // ========== Drag-to-comment on artifacts ==========\n  // Commentable artifacts: leaf media + semantic blocks the author signaled\n  // are \"a unit\" (section/article/aside/blockquote/table/details — note\n  // `figure` and `pre` already included as media) + any element the author\n  // explicitly opted in via `data-tdoc-artifact` or a class containing\n  // `tdoc-artifact`. Author-composed cards (a transcript panel built from\n  // <div>s, a custom widget) become commentable as a unit when tagged —\n  // instead of being invisible to the artifact system.\n  // NB: `article` is excluded — it's a doc content-root pattern; making it\n  // commentable would let the whole doc become one big artifact. Use\n  // `section` or `data-tdoc-artifact` to mark sub-blocks instead.\n  const COMMENTABLE =\n    'img, svg, canvas, video, pre, figure, iframe[src], ' +\n    'section, aside, blockquote, table, details, ' +\n    '[data-tdoc-artifact], [class*=\"tdoc-artifact\"]';\n  // The doc content root (per SKILL.md every doc wraps content in one of\n  // these). resolveArtifact must never climb into/past it.\n  const ARTICLE_ROOT_SEL = 'main, article, .wrap, .content, .container';\n  const DRAG_THRESHOLD = 5;\n  let dragState = null;\n\n  function isInUI(el) {\n    return el && el.closest && el.closest(UI_ALL);\n  }\n\n  // Resolve the *meaningful* artifact boundary for a hovered/hit leaf.\n  //\n  // COMMENTABLE only lists leaf media (img/svg/canvas/video/pre/figure/\n  // iframe). Docs frequently compose ONE visual artifact out of <div>s\n  // wrapping a nested media element — e.g. a phone mockup\n  // <div class=\"phone\"> … <svg> progress ring </svg> … </div>.\n  // `closest(COMMENTABLE)` resolves to the inner <svg> (the ring), so the\n  // outline/anchor hugs a tiny inner region instead of the whole mockup.\n  //\n  // The robust signal for \"this is the artifact the author designed as one\n  // unit\" is NOT an id or an area ratio — it's a *visual container box*:\n  // an ancestor the author gave its own visual boundary (background,\n  // border, border-radius, box-shadow, or a fixed/aspect-ratio size).\n  // The phone mockup has background+border-radius+box-shadow+aspect-ratio;\n  // the inner `.screen`/`.ring-wrap` are pure layout flexers with none.\n  //\n  // Algorithm: climb from the media leaf to the OUTERMOST visual-box\n  // ancestor that is still tighter than the content column. <figure> is a\n  // definitive unit. Stop at the doc content root / UI / <body>. This is\n  // resilient to viewport width (no innerWidth break that truncates the\n  // climb before reaching the real artifact) and needs no id.\n  let _csCache = null, _csCacheEl = null;\n  function cs(el) {\n    if (_csCacheEl === el && _csCache) return _csCache;\n    try { _csCache = getComputedStyle(el); } catch (e) { _csCache = null; }\n    _csCacheEl = el;\n    return _csCache;\n  }\n  // Does this element have an author-given visual boundary (i.e. it reads\n  // as a self-contained \"card/frame/mockup\", not a transparent layout div)?\n  function isVisualBox(el) {\n    if (!el || el.nodeType !== 1 || el === document.body) return false;\n    const tag = el.tagName.toLowerCase();\n    if (tag === 'figure' || tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video') return true;\n    const s = cs(el);\n    if (!s) return false;\n    const hasBg =\n      (s.backgroundImage && s.backgroundImage !== 'none') ||\n      (s.backgroundColor &&\n        s.backgroundColor !== 'rgba(0, 0, 0, 0)' &&\n        s.backgroundColor !== 'transparent');\n    const hasBorder =\n      (s.borderTopWidth && parseFloat(s.borderTopWidth) > 0) ||\n      (s.borderBottomWidth && parseFloat(s.borderBottomWidth) > 0) ||\n      (s.borderLeftWidth && parseFloat(s.borderLeftWidth) > 0) ||\n      (s.borderRightWidth && parseFloat(s.borderRightWidth) > 0);\n    const hasRadius = s.borderRadius && s.borderRadius !== '0px' && parseFloat(s.borderRadius) > 0;\n    const hasShadow = s.boxShadow && s.boxShadow !== 'none';\n    const hasAspect = s.aspectRatio && s.aspectRatio !== 'auto';\n    return !!(hasBg || hasBorder || hasRadius || hasShadow || hasAspect);\n  }\n  function isFullWidthBand(el) {\n    const r = el.getBoundingClientRect();\n    if (!r.width) return true;\n    // Compare against the article column, not the viewport: a full-bleed\n    // showcase wrapper spans the column; the artifact inside it does not.\n    const root = articleRootEl();\n    const colW = root ? root.getBoundingClientRect().width : window.innerWidth;\n    return r.width >= Math.max(1, colW) * 0.92;\n  }\n  function articleRootEl() {\n    try {\n      const c = document.querySelector(ARTICLE_ROOT_SEL);\n      if (c && !(c.closest && (c.closest(UI_ALL)))) return c;\n    } catch (e) {}\n    return null;\n  }\n  // True if `node` sits within (or is) a resolved artifact — including the\n  // wrapper region around a nested media leaf. Used to keep text-marquee\n  // drags from starting on composite artifacts (e.g. the phone mockup's\n  // padding, which is a <div>, not a COMMENTABLE leaf).\n  function isWithinArtifact(node) {\n    if (!node || node.nodeType !== 1) return false;\n    const direct = node.matches(COMMENTABLE) ? node : node.closest(COMMENTABLE);\n    if (direct) return true;\n    // Climb: is any ancestor a resolved-artifact wrapper that contains a\n    // COMMENTABLE descendant? (cheap walk, capped)\n    let el = node, guard = 0;\n    while (el && el !== document.body && guard++ < 14) {\n      if (\n        el.querySelector &&\n        el.querySelector(COMMENTABLE) &&\n        resolveArtifact(el.querySelector(COMMENTABLE)) === el\n      ) {\n        return true;\n      }\n      el = el.parentElement;\n    }\n    return false;\n  }\n  function resolveArtifact(leaf) {\n    if (!leaf || leaf.nodeType !== 1) return leaf;\n    // If the leaf is already inside a comment-anchored element, keep that\n    // exact element so existing anchors don't shift.\n    if (leaf.closest && leaf.closest('[data-tdoc-anchored]')) {\n      return leaf.closest('[data-tdoc-anchored]');\n    }\n    // Climb the full ancestor chain up to the content root, recording the\n    // OUTERMOST visual-box ancestor that is still tighter than the content\n    // column. Crucially we DO NOT break early on a non-visual layout div\n    // (the inner `.screen`/`.ring-wrap` flexers): we climb THROUGH them so\n    // a transparent wrapper between the media and the real mockup box can\n    // never truncate the search before reaching the artifact.\n    let el = leaf;\n    let best = leaf;\n    let guard = 0;\n    while (el.parentElement && guard++ < 24) {\n      const parent = el.parentElement;\n      if (parent === document.body || parent.nodeType !== 1) break;\n      if (parent.closest && (parent.closest(UI_ALL) || isInUI(parent))) break;\n      // The doc's content root is a hard boundary — never the artifact.\n      if (parent.matches && parent.matches(ARTICLE_ROOT_SEL)) break;\n      if (parent.tagName && parent.tagName.toLowerCase() === 'figure') {\n        return parent; // semantic artifact unit — definitive\n      }\n      // A visual box that still fits inside the column is a candidate\n      // artifact boundary. Keep the OUTERMOST such box (so the whole phone\n      // mockup wins over an inner card), but never a full-bleed band.\n      if (isVisualBox(parent) && !isFullWidthBand(parent)) {\n        best = parent;\n      }\n      el = parent;\n    }\n    return best;\n  }\n\n  // Given ANY node the cursor is over (the ring, a button, a label, the\n  // empty padding — anything), return the artifact SECTION it belongs to,\n  // or null if it isn't inside one. An artifact section is the OUTERMOST\n  // ancestor (still inside the content column, never the content root) that\n  // contains a media element (img/svg/canvas/video) — i.e. the whole\n  // self-contained block the author composed. The entire section is one\n  // unit: hovering anywhere inside it targets the same section, so the\n  // Comment affordance never jumps as the cursor moves within it.\n  // Resolves the COMMENTABLE artifact a hovered node belongs to.\n  //\n  // Old version was hard-coded around \"must contain a media leaf\n  // (img/svg/canvas/video)\". That excluded the v0.1.54 cases — semantic\n  // blocks (<section>, <table>, etc.) and author opt-in (data-tdoc-artifact)\n  // can be commentable WITHOUT containing any media. This rewrite mirrors\n  // the COMMENTABLE selector exactly: an artifact is anything COMMENTABLE\n  // (either as the hovered element itself, an ancestor of it, or a\n  // commentable wrapper around a media leaf that IS the hovered element).\n  function artifactSectionOf(node) {\n    if (!node || node.nodeType !== 1) return null;\n    if (isInUI(node) || (node.closest && node.closest(UI_ALL))) return null;\n    // Existing anchored element wins (keep anchors stable).\n    if (node.closest) {\n      const anchored = node.closest('[data-tdoc-anchored]');\n      if (anchored) return anchored;\n    }\n    // 1. Direct hit: the hovered node IS a commentable artifact, OR it's\n    //    inside one. closest() finds the NEAREST commentable ancestor.\n    const direct = node.matches && node.matches(COMMENTABLE)\n      ? node\n      : (node.closest && node.closest(COMMENTABLE));\n    if (direct && !isInUI(direct) && !(direct.matches && direct.matches(ARTICLE_ROOT_SEL))) {\n      // Prefer the OUTERMOST commentable wrapper to handle the nesting case\n      // (e.g. a card containing a media SVG — comment on the card, not the\n      // svg, when the user hovers anywhere in the card). Climb past inner\n      // commentables only when they're enclosed in another commentable\n      // that's still inside the content column.\n      let best = direct;\n      let cur = direct.parentElement;\n      let guard = 0;\n      while (cur && cur !== document.body && guard++ < 20) {\n        if (cur.matches && cur.matches(ARTICLE_ROOT_SEL)) break;\n        if (cur.closest && (cur.closest(UI_ALL) || isInUI(cur))) break;\n        if (cur.matches && cur.matches(COMMENTABLE) && !isFullWidthBand(cur)) {\n          best = cur;\n        }\n        cur = cur.parentElement;\n      }\n      // resolveArtifact does final refinement (visual-box detection inside\n      // the chosen section); honor it but only if it stays inside `best`.\n      const refined = resolveArtifact(best);\n      return (refined && best.contains && best.contains(refined)) ? refined : best;\n    }\n    // 2. Nothing commentable in this hover path. Don't show a pill.\n    return null;\n  }\n  function rectsOverlap(a, b) { return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom); }\n  function findArtifactIntersecting(dragRect) {\n    const sx = window.scrollX, sy = window.scrollY;\n    for (const el of document.querySelectorAll(COMMENTABLE)) {\n      if (isInUI(el)) continue;\n      const resolved = resolveArtifact(el);\n      const r = resolved.getBoundingClientRect();\n      const pageRect = { left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy };\n      if (rectsOverlap(pageRect, dragRect)) return resolved;\n    }\n    return null;\n  }\n  function elementSelector(el) {\n    // IDENTITY FIRST: prefer the worker-stamped artifact id (immune to\n    // DOM restructuring — same artifact in a different version has the\n    // same aid).\n    const aid = el.getAttribute && el.getAttribute('data-tdoc-aid');\n    if (aid) return `[data-tdoc-aid=\"${aid}\"]`;\n    if (el.id) return `#${CSS.escape(el.id)}`;\n    // Last-resort positional path (used only for previews before the doc\n    // is published — after publish, every artifact has an aid).\n    const parts = [];\n    let cur = el;\n    while (cur && cur.nodeType === 1 && cur !== document.body) {\n      let part = cur.tagName.toLowerCase();\n      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }\n      const parent = cur.parentElement;\n      if (parent) {\n        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);\n        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;\n      }\n      parts.unshift(part);\n      cur = parent;\n    }\n    return parts.join(' > ');\n  }\n  function elementAid(el) {\n    return (el && el.getAttribute && el.getAttribute('data-tdoc-aid')) || null;\n  }\n  function elementLabel(el) {\n    return el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName.toLowerCase();\n  }\n\n  // ── Anchor stability for ELEMENT (artifact) comments ──────────────────\n  // Positional selectors like `div > svg:nth-of-type(1)` silently drift to\n  // a DIFFERENT artifact when /tdoc edit restructures the DOM (e.g. wraps\n  // an svg in a <figure>, or adds a sibling). To make element anchors\n  // survive regeneration we capture a CONTENT FINGERPRINT at comment time\n  // and validate it at resolve time — if the selector lands on something\n  // that isn't the same artifact, we treat the comment as unanchored\n  // instead of pointing it at the wrong thing.\n  function elementFingerprint(el) {\n    if (!el || el.nodeType !== 1) return null;\n    // Normalized, length-capped text content (collapses whitespace).\n    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400);\n    // Structural signature: ordered child tag names (one level) + svg/img\n    // intrinsics, so two same-tag artifacts with different innards differ.\n    const kids = Array.from(el.children).map(c => c.tagName.toLowerCase()).join(',');\n    const dims = [\n      el.getAttribute('viewBox') || '',\n      el.getAttribute('src') || '',\n      el.getAttribute('alt') || el.getAttribute('aria-label') || '',\n    ].join('|');\n    return {\n      tag: el.tagName.toLowerCase(),\n      text: txt,\n      kids,\n      meta: dims,\n      // cheap stable hash so we can compare without storing huge strings\n      h: cyrb53(el.tagName + '\u0001' + txt + '\u0001' + kids + '\u0001' + dims),\n    };\n  }\n  // Small, fast 53-bit string hash (public-domain cyrb53).\n  function cyrb53(str, seed = 0) {\n    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;\n    for (let i = 0, ch; i < str.length; i++) {\n      ch = str.charCodeAt(i);\n      h1 = Math.imul(h1 ^ ch, 2654435761);\n      h2 = Math.imul(h2 ^ ch, 1597334677);\n    }\n    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);\n    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);\n    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);\n  }\n  // How well do two fingerprints match? 1 = identical artifact, 0 = no\n  // relation. Tag mismatch is disqualifying. Otherwise weight exact-hash,\n  // then text similarity, then structural (kids) similarity.\n  function fingerprintScore(a, b) {\n    if (!a || !b || a.tag !== b.tag) return 0;\n    if (a.h === b.h) return 1;\n    let s = 0;\n    if (a.meta && a.meta === b.meta) s += 0.45;       // same viewBox/src/label\n    if (a.kids && a.kids === b.kids) s += 0.25;        // same child structure\n    if (a.text && b.text) {\n      // token Jaccard on the normalized text\n      const A = new Set(a.text.split(' ')), B = new Set(b.text.split(' '));\n      let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });\n      const uni = A.size + B.size - inter;\n      if (uni) s += 0.30 * (inter / uni);\n    }\n    return s;\n  }\n\n  document.addEventListener('mousedown', (e) => {\n    if (e.button !== 0) return;\n    const t = e.target;\n    if (!t || t.nodeType !== 1 || isInUI(t)) return;\n    if (t.closest('button, a, input, select, textarea, [contenteditable], [role=\"button\"]')) return;\n    if (isWithinArtifact(t)) return;\n    dragState = { x0: e.pageX, y0: e.pageY, marquee: null, dragged: false };\n  }, true);\n\n  document.addEventListener('mousemove', (e) => {\n    if (!dragState) return;\n    const dx = e.pageX - dragState.x0, dy = e.pageY - dragState.y0;\n    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;\n    dragState.dragged = true;\n    const dragRect = {\n      left: Math.min(dragState.x0, e.pageX), top: Math.min(dragState.y0, e.pageY),\n      right: Math.max(dragState.x0, e.pageX), bottom: Math.max(dragState.y0, e.pageY),\n    };\n    const hit = findArtifactIntersecting(dragRect);\n    if (hit) {\n      if (!dragState.marquee) {\n        dragState.marquee = document.createElement('div');\n        dragState.marquee.className = 'tdoc-drag-marquee';\n        document.body.appendChild(dragState.marquee);\n      }\n      dragState.marquee.style.left = Math.min(dragState.x0, e.pageX) + 'px';\n      dragState.marquee.style.top = Math.min(dragState.y0, e.pageY) + 'px';\n      dragState.marquee.style.width = Math.abs(dx) + 'px';\n      dragState.marquee.style.height = Math.abs(dy) + 'px';\n    } else if (dragState.marquee) {\n      dragState.marquee.remove(); dragState.marquee = null;\n    }\n  }, true);\n\n  document.addEventListener('mouseup', (e) => {\n    // Unified mouseup: drag-to-comment branch first, otherwise fall through to\n    // text-selection-popup behavior. Single capture-phase listener avoids the\n    // race where drag-end outside an artifact would still trigger the bubble-\n    // phase selection-popup handler.\n    const ds = dragState;\n    if (ds) {\n      const { x0, y0, dragged, marquee } = ds;\n      dragState = null;\n      if (marquee) marquee.remove();\n      if (dragged) {\n        const dragRect = {\n          left: Math.min(x0, e.pageX), top: Math.min(y0, e.pageY),\n          right: Math.max(x0, e.pageX), bottom: Math.max(y0, e.pageY),\n        };\n        const el = findArtifactIntersecting(dragRect);\n        if (el) {\n          e.preventDefault(); e.stopPropagation();\n          hideHoverUI();\n          openPopup({ kind: 'element', selector: elementSelector(el), label: elementLabel(el), _el: el }, el.getBoundingClientRect());\n          return;\n        }\n        // Dragged but no artifact hit — likely a text selection. Fall through.\n      }\n    }\n    maybeOpenSelectionPopup(e.target);\n  }, true);\n\n  // Mouse and touch both surface here. On iOS Safari long-press text-selection\n  // does NOT fire mouseup, so we also listen for touchend. selectionchange\n  // would seem cleaner but fires continuously during a drag — touchend gives\n  // us a single \"selection finished\" signal.\n  document.addEventListener('touchend', (e) => {\n    const t = e.target || (e.changedTouches?.[0] && document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY));\n    // Touchend fires before the OS finalizes selection — defer one tick.\n    setTimeout(() => maybeOpenSelectionPopup(t), 0);\n  }, true);\n\n  function maybeOpenSelectionPopup(target) {\n    // Selected text wins over \"comment whole artifact.\" If there's a real text\n    // selection, open the text-selection popup regardless of whether the\n    // selection lives inside a commentable artifact. The hover pill remains\n    // the path for \"comment on the whole artifact\" — they don't compete\n    // because they're driven by different gestures (hover vs. drag-select).\n    if (target && target.nodeType === 1 && isInUI(target)) return;\n    const sel = window.getSelection();\n    const text = sel && sel.toString().trim();\n    if (!text || text.length < 2 || !sel.rangeCount) return;\n    const anchorNode = sel.anchorNode;\n    const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;\n    if (anchorEl && isInUI(anchorEl)) return;\n    const range = sel.getRangeAt(0).cloneRange();\n    const ctx = getContext(range, 60);\n    // Re-anchor mode: rebind an existing unanchored comment to this selection\n    // instead of creating a new one. Captured fallback position is refreshed\n    // too so the comment \"moves\" to where the user just selected.\n    if (state.reanchoringId) {\n      const id = state.reanchoringId;\n      exitReanchor();\n      const newAnchor = {\n        kind: 'text', text, context_before: ctx.before, context_after: ctx.after,\n        fallback: captureFallbackPosition({ kind: 'text', _range: range }),\n      };\n      // Optimistic UI: drop the old anchor's highlight immediately so the\n      // user never sees stale yellow on the previous location while the\n      // PATCH is in flight. refreshComments() will repaint with the new\n      // anchor once the server confirms.\n      state.anchorMarks.delete(id);\n      rebuildSharedHighlights();\n      window.getSelection()?.removeAllRanges();\n      fetch('/api/comments', {\n        method: 'PATCH', headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ slug, id, anchor: newAnchor, version }),\n      }).then(r => {\n        if (r.status === 401) startDeviceFlow();\n        return r.ok ? refreshComments() : null;\n      });\n      return;\n    }\n    const rect = range.getBoundingClientRect();\n    openPopup({ kind: 'text', text, context_before: ctx.before, context_after: ctx.after, _range: range }, rect);\n  }\n\n  // Begin the re-anchor flow: future text selection on the doc will rebind\n  // this comment instead of creating a new one. Toggle off if clicked again.\n  function startReanchor(id) {\n    if (state.reanchoringId === id) { exitReanchor(); return; }\n    state.reanchoringId = id;\n    document.body.classList.add('tdoc-reanchoring');\n  }\n  function exitReanchor() {\n    state.reanchoringId = null;\n    document.body.classList.remove('tdoc-reanchoring');\n  }\n  // Capture a fallback position for an existing comment by reading the\n  // current anchor's location, so an unanchored card stays where it was.\n  function fallbackFromExistingAnchor(commentId) {\n    const mark = state.anchorMarks.get(commentId);\n    if (!mark) return null;\n    const metrics = getArticleMetrics();\n    const articleEl = metrics.el || document.body;\n    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;\n    const articleHeight = Math.max(1, articleEl.scrollHeight);\n    let rect = null;\n    if (mark.ranges?.[0]) rect = mark.ranges[0].getBoundingClientRect();\n    else if (mark.el) rect = mark.el.getBoundingClientRect();\n    else if (mark.targetEl) rect = mark.targetEl.getBoundingClientRect();\n    if (!rect) return null;\n    const centerY = rect.top + rect.height / 2 + window.scrollY;\n    return { ratio: Math.max(0, Math.min(1, (centerY - articleTop) / articleHeight)), nearestHeading: null };\n  }\n  // Wire banner buttons (created once near the bar). The banner is the\n  // only place we expose \"remove anchor\" — keeps cards uncluttered and\n  // resolves the gesture conflict you'd hit with \"click empty space\".\n  document.getElementById('tdoc-reanchor-cancel').onclick = (e) => { e.stopPropagation(); exitReanchor(); };\n  document.getElementById('tdoc-reanchor-remove').onclick = async (e) => {\n    e.stopPropagation();\n    const id = state.reanchoringId;\n    if (!id) return;\n    const fallback = fallbackFromExistingAnchor(id);\n    exitReanchor();\n    // Optimistic: clear the old highlight before the network call. If the\n    // PATCH fails we'll just re-fetch and the anchor will return — no\n    // worse than the pre-click state.\n    state.anchorMarks.delete(id);\n    rebuildSharedHighlights();\n    const r = await fetch('/api/comments', {\n      method: 'PATCH', headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ slug, id, anchor: { kind: 'none', fallback }, version }),\n    });\n    if (r.status === 401) { startDeviceFlow(); return; }\n    if (!r.ok) { const err = await r.json().catch(() => ({})); alert('Could not remove anchor: ' + (err.error || `HTTP ${r.status}`)); return; }\n    await refreshComments();\n  };\n\n  // ========== Hover affordance ==========\n  // ========== Artifact hover affordance ==========\n  // Hovering an unanchored commentable element (img/canvas/svg/video/pre)\n  // shows: (1) a dashed blue outline around it, (2) a clickable \"Comment\" pill\n  // in its top-right corner. Click the pill → opens the comment popup anchored\n  // to that element. This is the discoverable path; drag-from-outside also\n  // works for users who prefer that gesture.\n  // The artifact section is ONE unit. Hovering anywhere inside it shows a\n  // single Comment button anchored to the section's top-right corner — no\n  // full outline. While the cursor stays anywhere within the same section\n  // the button does not move or flicker.\n  let commentPill = null, pillTargetEl = null;\n  function showHoverUI(el) {\n    if (isFork) return; // read-only: no new-comment affordances\n    if (pillTargetEl === el && commentPill) return; // same section — keep as-is\n    hideHoverUI();\n    const r = el.getBoundingClientRect();\n\n    commentPill = document.createElement('button');\n    commentPill.className = 'tdoc-comment-pill';\n    commentPill.type = 'button';\n    commentPill.setAttribute('aria-label', 'Comment on this');\n    commentPill.innerHTML = `<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/></svg>Comment`;\n    // Top-right corner of the SECTION, so it visually belongs to the whole\n    // artifact regardless of where inside it the cursor is.\n    const pillW = 110;\n    commentPill.style.top = (window.scrollY + r.top + 8) + 'px';\n    commentPill.style.left = (window.scrollX + Math.max(r.left + 8, r.right - pillW - 8)) + 'px';\n    commentPill.onclick = (e) => {\n      e.stopPropagation();\n      e.preventDefault();\n      const target = pillTargetEl;\n      const pillRect = commentPill.getBoundingClientRect();\n      hideHoverUI();\n      if (!target) return;\n      openPopup({\n        kind: 'element',\n        selector: elementSelector(target),\n        label: elementLabel(target),\n        _el: target,\n        _placeAbove: true,\n      }, pillRect);\n    };\n    pillTargetEl = el;\n    document.body.appendChild(commentPill);\n  }\n  function hideHoverUI() {\n    if (commentPill) { commentPill.remove(); commentPill = null; }\n    pillTargetEl = null;\n  }\n\n  document.addEventListener('mouseover', (e) => {\n    const t = e.target;\n    if (!t || t.nodeType !== 1) return;\n    // The pill itself is in `body` — don't hide UI when the cursor enters it.\n    if (t.closest('.tdoc-comment-pill')) return;\n    if (isInUI(t)) { hideHoverUI(); return; }\n    // ANY element under the cursor → the artifact section it belongs to\n    // (the ring, a button, a label, empty padding — all map to the SAME\n    // section). Hovering anywhere inside one artifact targets the whole\n    // artifact as one unit.\n    const section = artifactSectionOf(t);\n    if (!section || isInUI(section)) { hideHoverUI(); return; }\n    showHoverUI(section);\n  });\n  document.addEventListener('mouseout', (e) => {\n    const next = e.relatedTarget;\n    if (!next) { hideHoverUI(); return; }\n    // Stay shown if cursor moves into the Comment button.\n    if (next.closest && next.closest('.tdoc-comment-pill')) return;\n    // Stay shown while the cursor remains anywhere inside the SAME section.\n    if (pillTargetEl && pillTargetEl.contains && pillTargetEl.contains(next)) return;\n    if (pillTargetEl && artifactSectionOf(next) === pillTargetEl) return;\n    if (isInUI(next)) hideHoverUI();\n  });\n\n  // ========== Selection → popup ==========\n  // (See unified mouseup handler above — selection-popup branch lives in the\n  // capture-phase handler so drag and selection cannot race.)\n\n  // ========== Root click handler (delegated): menus, drawer, deselect, anchor click ==========\n  document.addEventListener('click', (e) => {\n    const t = e.target;\n    if (!t || t.nodeType !== 1) return;\n\n    // Close menus that aren't under the cursor\n    if (!t.closest('#tdoc-more-btn') && !t.closest('#tdoc-secondary-menu')) secMenu.classList.remove('open');\n    if (!t.closest('.tdoc-menu-wrap')) copyMenu.classList.remove('open');\n    // Close the profile menu on any click outside its wrapper.\n    if (!t.closest('#tdoc-me') && !t.closest('#tdoc-me-menu')) {\n      const mm = document.getElementById('tdoc-me-menu');\n      const mb = document.getElementById('tdoc-me');\n      if (mm) mm.classList.remove('open');\n      if (mb) mb.setAttribute('aria-expanded', 'false');\n    }\n    if (!t.closest('.tdoc-version-wrap')) {\n      const vm = document.getElementById('tdoc-version-menu');\n      const vt = document.getElementById('tdoc-version-toggle');\n      if (vm) vm.classList.remove('open');\n      if (vt) vt.setAttribute('aria-expanded', 'false');\n    }\n    if (!t.closest('.tdoc-emoji-picker') && !t.closest('.tdoc-react-add')) closeEmojiPicker();\n\n    // Close drawer on outside click (narrow only)\n    if (commentLayer.classList.contains('open') &&\n        !t.closest('#tdoc-comment-layer, .tdoc-fab, .tdoc-popup, .tdoc-modal-bg, .tdoc-emoji-picker')) {\n      commentLayer.classList.remove('open');\n    }\n\n    // Custom-Highlight API: hit-test anchor ranges to detect anchor click.\n    if (HIGHLIGHT_API && !isInUI(t)) {\n      const hitId = findCommentAtPoint(e.clientX, e.clientY);\n      if (hitId) { setActiveComment(hitId); return; }\n    }\n\n    // Deselect when clicking truly-outside the UI + outside any anchor/artifact.\n    if (isInUI(t)) return;\n    for (const mark of state.anchorMarks.values()) {\n      const target = mark.targetEl || mark.el;\n      if (target && (target === t || (target.contains && target.contains(t)))) return;\n    }\n    setActiveComment(null);\n    const sel = window.getSelection();\n    if (sel && sel.toString().trim() === '' && sel.rangeCount > 0) sel.removeAllRanges();\n  });\n\n  // ========== Copy as Markdown ==========\n  function htmlToMarkdown(root) {\n    function walk(node, ctx) {\n      if (node.nodeType === Node.TEXT_NODE) {\n        const t = node.nodeValue;\n        if (ctx.inPre) return t;\n        return t.replace(/\\s+/g, ' ');\n      }\n      if (node.nodeType !== Node.ELEMENT_NODE) return '';\n      if (node.classList && (\n        node.classList.contains('tdoc-bar') ||\n        node.classList.contains('tdoc-popup') ||\n        node.classList.contains('tdoc-margin-comment') ||\n        node.classList.contains('tdoc-modal-bg') ||\n        node.classList.contains('tdoc-element-outline') ||\n        node.classList.contains('tdoc-hover-outline') ||\n        node.id === 'tdoc-comment-layer'\n      )) return '';\n      const tag = node.tagName.toLowerCase();\n      const kids = () => Array.from(node.childNodes).map(c => walk(c, ctx)).join('');\n      switch (tag) {\n        case 'h1': return '\\n\\n# ' + kids().trim() + '\\n\\n';\n        case 'h2': return '\\n\\n## ' + kids().trim() + '\\n\\n';\n        case 'h3': return '\\n\\n### ' + kids().trim() + '\\n\\n';\n        case 'h4': return '\\n\\n#### ' + kids().trim() + '\\n\\n';\n        case 'h5': return '\\n\\n##### ' + kids().trim() + '\\n\\n';\n        case 'h6': return '\\n\\n###### ' + kids().trim() + '\\n\\n';\n        case 'p': return '\\n\\n' + kids().trim() + '\\n\\n';\n        case 'br': return '  \\n';\n        case 'hr': return '\\n\\n---\\n\\n';\n        case 'strong': case 'b': return '**' + kids() + '**';\n        case 'em': case 'i': return '*' + kids() + '*';\n        case 'code': return ctx.inPre ? kids() : '`' + kids() + '`';\n        case 'pre': {\n          const c = { ...ctx, inPre: true };\n          const lang = node.querySelector('code')?.className?.match(/language-([\\w-]+)/)?.[1] || '';\n          const inner = Array.from(node.childNodes).map(n => walk(n, c)).join('');\n          return '\\n\\n```' + lang + '\\n' + inner.replace(/\\n$/, '') + '\\n```\\n\\n';\n        }\n        case 'blockquote':\n          return '\\n\\n' + kids().trim().split('\\n').map(l => '> ' + l).join('\\n') + '\\n\\n';\n        case 'ul': {\n          const items = Array.from(node.children).filter(c => c.tagName === 'LI');\n          return '\\n\\n' + items.map(li => '- ' + walk(li, ctx).trim()).join('\\n') + '\\n\\n';\n        }\n        case 'ol': {\n          const items = Array.from(node.children).filter(c => c.tagName === 'LI');\n          return '\\n\\n' + items.map((li, i) => (i + 1) + '. ' + walk(li, ctx).trim()).join('\\n') + '\\n\\n';\n        }\n        case 'li': return kids();\n        case 'a': {\n          const href = node.getAttribute('href') || '';\n          const text = kids().trim();\n          return href ? `[${text}](${href})` : text;\n        }\n        case 'img': {\n          const src = node.getAttribute('src') || '';\n          const alt = node.getAttribute('alt') || '';\n          return `![${alt}](${src})`;\n        }\n        case 'svg': case 'canvas': case 'video': case 'iframe':\n          return `\\n\\n[${tag} embed]\\n\\n`;\n        case 'figure': return '\\n\\n' + kids().trim() + '\\n\\n';\n        case 'figcaption': return '\\n\\n*' + kids().trim() + '*\\n\\n';\n        case 'table': {\n          const rows = Array.from(node.querySelectorAll('tr'));\n          if (!rows.length) return '';\n          const cells = (r) => Array.from(r.children).map(c => walk(c, ctx).trim().replace(/\\|/g, '\\\\|'));\n          const head = cells(rows[0]);\n          const body = rows.slice(1).map(cells);\n          return '\\n\\n| ' + head.join(' | ') + ' |\\n| ' + head.map(() => '---').join(' | ') + ' |\\n' +\n                 body.map(r => '| ' + r.join(' | ') + ' |').join('\\n') + '\\n\\n';\n        }\n        case 'th': case 'td': case 'tr': return kids();\n        default: return kids();\n      }\n    }\n    return walk(root, { inPre: false }).replace(/\\n{3,}/g, '\\n\\n').trim();\n  }\n\n  async function copyText(s) {\n    try { await navigator.clipboard.writeText(s); return true; }\n    catch {\n      const ta = document.createElement('textarea');\n      ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';\n      document.body.appendChild(ta); ta.select();\n      const ok = document.execCommand('copy');\n      ta.remove();\n      return ok;\n    }\n  }\n  function flashCopied(btn) {\n    if (!btn || btn.dataset.flashing === '1') return;\n    btn.dataset.flashing = '1';\n    const orig = btn.innerHTML;\n    const oc = btn.style.color, ob = btn.style.borderColor;\n    btn.innerHTML = `<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"/></svg><span>Copied</span>`;\n    btn.style.color = '#3ecf8e'; btn.style.borderColor = '#3ecf8e';\n    setTimeout(() => {\n      btn.innerHTML = orig; btn.style.color = oc; btn.style.borderColor = ob;\n      btn.dataset.flashing = '0';\n    }, 1200);\n  }\n  function flashToast(msg) {\n    const t = document.createElement('div');\n    t.textContent = msg;\n    t.style.cssText = 'position:fixed;bottom:18px;right:18px;background:#0a0a0a;color:#fff;padding:8px 14px;border-radius:6px;font:12px system-ui;z-index:1000001;opacity:0;transition:opacity 0.15s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.2);';\n    document.body.appendChild(t);\n    requestAnimationFrame(() => { t.style.opacity = '0.95'; });\n    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 1400);\n  }\n  function reactionsToMd(reactions) {\n    if (!reactions) return '';\n    const parts = Object.entries(reactions).filter(([, u]) => u && u.length > 0).map(([e, u]) => `${e} ${u.length}`);\n    return parts.length ? `_reactions: ${parts.join(' · ')}_\\n` : '';\n  }\n  function commentToMd(c) {\n    const who = c.author ? `**@${c.author.login}**` : '*anonymous*';\n    const when = new Date(c.created).toLocaleString();\n    let anchorLine = '';\n    if (c.anchor) {\n      if (c.anchor.kind === 'element' || c.anchor.selector) anchorLine = `> _on ${c.anchor.label || c.anchor.selector}_\\n`;\n      else if (c.anchor.text) anchorLine = `> \"${c.anchor.text.replace(/\\n/g, ' ').slice(0, 200)}\"\\n`;\n    }\n    let md = `${who} — _${when}_\\n${anchorLine}\\n${c.text}\\n${reactionsToMd(c.reactions)}`;\n    if (Array.isArray(c.replies) && c.replies.length) {\n      for (const r of c.replies) {\n        const rwho = r.author ? `**@${r.author.login}**` : '*anonymous*';\n        const rwhen = new Date(r.created).toLocaleString();\n        md += `  ↳ ${rwho} — _${rwhen}_\\n    ${r.text}\\n    ${reactionsToMd(r.reactions)}`;\n      }\n    }\n    return md;\n  }\n\n  window.__tdocCopyDocMd = async function (includeComments) {\n    const clone = document.body.cloneNode(true);\n    clone.querySelectorAll(UI_ALL + ', script, style, noscript').forEach(n => n.remove());\n    let md = htmlToMarkdown(clone);\n    if (includeComments && state.activeComments.length) {\n      md += '\\n\\n---\\n\\n## Comments\\n\\n' + state.activeComments.map(commentToMd).join('\\n---\\n\\n');\n    }\n    const ok = await copyText(md);\n    if (ok) flashCopied(document.getElementById('tdoc-copy-md-btn'));\n    else flashToast('Copy failed');\n  };\n  window.__tdocCopyCommentMd = async function (commentId, srcBtn) {\n    const c = state.activeComments.find(x => x.id === commentId);\n    if (!c) return;\n    const ok = await copyText(commentToMd(c));\n    if (ok && srcBtn) {\n      const origHTML = srcBtn.innerHTML, origColor = srcBtn.style.color;\n      srcBtn.innerHTML = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"/></svg>';\n      srcBtn.style.color = '#3ecf8e';\n      setTimeout(() => { srcBtn.innerHTML = origHTML; srcBtn.style.color = origColor; }, 1200);\n    } else if (!ok) flashToast('Copy failed');\n  };\n\n  // ========== Wire it up ==========\n  refreshComments();\n})();\n";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) },
  });
}
function text(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(init.headers || {}) },
  });
}
function html(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers || {}) },
  });
}

function parseCookie(req) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/tdoc_sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}
async function getSession(env, req) {
  const sid = parseCookie(req);
  if (!sid) return null;
  const raw = await env.META.get(`session:${sid}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { id: sid, ...data };
  } catch { return null; }
}
// The worker owner = the GitHub login configured in TDOC_OWNER at deploy.
// Only that signed-in viewer may see the catalog of hosted docs. Case-
// insensitive; if TDOC_OWNER is unset, nobody is owner (catalog stays
// fully private — safe default).
function isOwnerSession(env, session) {
  const owner = (env.TDOC_OWNER || '').trim().toLowerCase();
  if (!owner || !session || !session.login) return false;
  return session.login.toLowerCase() === owner;
}
// Authorization for mutating a comment/reply: DENY by default. Allow only the
// record's author or the doc owner. Critically, a record with a null/absent
// author (legacy pre-event-log records produced by ensureEventLog) is NOT
// mutable by an arbitrary signed-in user — the previous `if (author && ...)`
// pattern short-circuited to "allow" on null, letting any GitHub session
// delete/re-anchor authorless legacy comments. Same logic for the three
// mutation sites, in one place.
function canMutate(record, session, env) {
  if (isOwnerSession(env, session)) return true;
  const who = record && record.author && record.author.login;
  return !!(who && session && session.login && who === session.login);
}
function rand(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Gated diagnostic logging. The device-flow poll path was instrumented during
// an incident and left noisy console.log calls in production (visible in
// `wrangler tail`). Gate them behind TDOC_DEBUG so they're off by default but
// recoverable. Genuine error branches stay as console.error, unconditionally.
function debug(env, ...args) {
  if (env && env.TDOC_DEBUG) console.log(...args);
}

// Escape `</script>` and HTML comment terminators so a malicious or stray value
// inside the JSON payload can't break out of the surrounding <script> block.
function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
}

// Full HTML escaping for interpolating untrusted strings into markup (text OR
// attribute context). The catalog/index pages previously escaped only `<`,
// leaving `"`/`'`/`&` unprotected in attribute contexts (#33 hardening).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Make an untrusted string safe to interpolate inside an HTML comment (or an
// HTML-comment-delimited marker). Comment text and author logins are
// attacker-controllable (any signed-in user can post a comment), so without
// this a `-->` in a comment would break out of the comment context and inject
// live markup into the fork/export document served on the worker origin.
//
// HTML comments do NOT decode entities, so we can't entity-escape — we must
// neutralize the byte sequences that open/close a comment. We break the `--`
// run (the only thing that can form `-->` or start `<!--`) with a backslash,
// which is unambiguous to a human/agent reader and cannot terminate the
// comment. Applied once, at every interpolation point — escaping as one layer,
// not a per-spot patch.
function forHtmlComment(s) {
  return String(s == null ? '' : s).replace(/--/g, '-\\-');
}

// ─────────────────────────────────────────────────────────────────────────
// Artifact identity (`data-tdoc-aid`)
//
// THE PROBLEM: positional CSS selectors silently drift when /tdoc edit
// restructures HTML. A comment anchored to `div > svg:nth-of-type(1)` will
// resolve to a different artifact in the next version with no indication.
//
// THE FIX: at upload time, the worker stamps every commentable artifact in
// the published HTML with `data-tdoc-aid="<content-hash>"`. The hash is
// derived from the artifact's TAG + NORMALIZED INNER CONTENT (whitespace
// collapsed, existing data-tdoc-* attrs stripped so the hash doesn't
// include itself). The SAME ARTIFACT IN A DIFFERENT VERSION HAS THE SAME
// AID. Comments anchor by aid; resolution is identity-first; drift is
// impossible because the aid is the artifact, not a path through the DOM.
//
// The set of commentable artifacts matches the overlay's COMMENTABLE.
// Includes leaf media + semantic blocks the author signaled are a unit.
// Plus: any element with `data-tdoc-artifact` or a class containing
// `tdoc-artifact` is stamped regardless of tag (the explicit opt-in path).
// NOTE: `article` is intentionally omitted — it's the doc CONTENT ROOT
// in some authoring patterns (per ARTICLE_ROOT_SEL in overlay.js); making
// it commentable would make the whole doc one big artifact. Use `section`
// or `data-tdoc-artifact` to mark sub-blocks instead.
const STAMPABLE_TAGS = [
  'img','svg','canvas','video','pre','figure','iframe',
  'section','aside','blockquote','table','details',
];
// 53-bit string hash (public-domain cyrb53), identical to the one in the
// overlay so identities computed on either side agree.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
// Compute an aid from a raw HTML substring representing one artifact element.
// Strips data-tdoc-* attrs from the open tag (so an aid doesn't include
// itself), strips comments, collapses whitespace inside.
function aidFor(tag, innerHtml, openAttrs) {
  // Keep author-meaningful intrinsics (viewBox / src / alt / aria-label /
  // title) as part of identity — they're what makes a `<svg>` *this* svg.
  const intrinsics = ['viewBox','src','alt','aria-label','title']
    .map(a => {
      const m = new RegExp('\\b' + a + '\\s*=\\s*"([^"]*)"', 'i').exec(openAttrs || '');
      return m ? a + '=' + m[1] : '';
    })
    .filter(Boolean).join('|');
  const norm = (innerHtml || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sdata-tdoc-[\w-]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cyrb53(tag + '|' + intrinsics + '|' + norm);
}
// Elements whose body is raw text (CDATA-like): their content is NOT markup,
// so a `</section>` or `>` inside them must never be treated as a tag. The
// close scanner skips over these element bodies entirely.
const RAW_TEXT_TAGS = ['script', 'style', 'textarea', 'title'];

// Given the index of a `<` that begins an open tag, return the index just past
// its closing `>`, treating `>` inside single/double-quoted attribute values
// as ordinary text. Returns -1 if no terminator is found. This fixes the
// finding where `<img alt="a > b">` (a `>` inside an attribute) made the naive
// `[^>]*>` regex stop early and mis-compute element offsets.
function attrAwareOpenTagEnd(html, lt) {
  let i = lt + 1, quote = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

// From `pos`, return the index just past the closing `>` of the next raw-text
// element body that starts at/after `pos`, if `pos` is right at a raw-text open
// tag; else null. Used to leap over <script>/<style> bodies so their unescaped
// `</section>`-like content can't desync the depth counter.
function skipRawTextBodyAt(html, openTag, attrs, openEnd) {
  if (!RAW_TEXT_TAGS.includes(openTag)) return null;
  if (/\/\s*$/.test(attrs)) return openEnd; // self-closed (rare/invalid) — nothing to skip
  const closeRe = new RegExp(`</${openTag}\\s*>`, 'i');
  closeRe.lastIndex = openEnd;
  const m = closeRe.exec(html.slice(openEnd));
  return m ? openEnd + m.index + m[0].length : html.length;
}

// --- #24 dry-run instrumentation -------------------------------------------
// The hardened stampAids() above fixes real regex bugs (`>` in an attribute,
// `</tag>` inside <script>/<style>). For ORDINARY HTML it produces aids
// identical to the legacy parser; it differs ONLY on the edge-case HTML the
// legacy parser mis-parsed (those inputs are valid HTML but rare). Because `aid`
// is the anchor key for stored comments, we MEASURE the blast radius before
// assuming it's safe: compute the aid SETS with both parsers and report how many
// live comments anchor to an aid the legacy parser produced but the hardened one
// no longer does (set membership — never an index-paired old→new map, which
// could mis-pair when the parsers diverge). This logs only — it never mutates
// (it folds deep copies). (Design: docs/DESIGN-aid-migration.md. Empirically 0
// across current docs.)
function stampAidsLegacy(rawHtml) {
  const headRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let hmatch;
  while ((hmatch = headRe.exec(rawHtml))) {
    headings.push({ end: hmatch.index + hmatch[0].length,
      text: hmatch[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() });
  }
  function nearestHeadingAt(idx) {
    let best = null;
    // Use <= so a heading whose close tag ends exactly at the next
    // element's open (no whitespace between) is still "before" it.
    for (const h of headings) { if (h.end <= idx) best = h.text; else break; }
    return best;
  }
  // Find every open tag of every stampable kind in document order.
  // For non-void tags, find its matching close (same-tag depth count).
  // Collect [openStart, openEnd, closeEnd, tag, attrs, innerHtml] per element.
  const elements = [];
  const seenOpens = new Set();   // dedupe across passes (tag pass + opt-in pass)
  function harvest(openStart, openEnd, tagLower, attrs) {
    if (seenOpens.has(openStart)) return;
    const isVoid = /^(img|iframe)$/i.test(tagLower) || /\/\s*$/.test(attrs);
    let closeEnd = openEnd, innerHtml = '';
    if (!isVoid) {
      const closeRe = new RegExp(`</${tagLower}\\s*>|<${tagLower}\\b[^>]*>`, 'gi');
      closeRe.lastIndex = openEnd;
      let depth = 1, c;
      while ((c = closeRe.exec(rawHtml))) {
        if (c[0][1] === '/') { depth--; if (depth === 0) { closeEnd = c.index + c[0].length; break; } }
        else depth++;
      }
      innerHtml = rawHtml.slice(openEnd, closeEnd - (`</${tagLower}>`.length));
    }
    seenOpens.add(openStart);
    elements.push({ openStart, openEnd, closeEnd, tag: tagLower, attrs, innerHtml, isVoid });
  }
  // Pass 1: every known stampable tag.
  for (const tag of STAMPABLE_TAGS) {
    const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let m;
    while ((m = openRe.exec(rawHtml))) harvest(m.index, m.index + m[0].length, tag, m[1] || '');
  }
  // Pass 2: opt-in markers (any tag with data-tdoc-artifact or class
  // containing `tdoc-artifact`). Authors mark composed cards/widgets this
  // way so they're commentable as a unit.
  const optInRe = /<([a-z][\w-]*)\b([^>]*\b(?:data-tdoc-artifact\b|class\s*=\s*"[^"]*\btdoc-artifact\b[^"]*")[^>]*)>/gi;
  let om;
  while ((om = optInRe.exec(rawHtml))) {
    const tagLower = om[1].toLowerCase();
    harvest(om.index, om.index + om[0].length, tagLower, om[2] || '');
  }
  // Compute aid per element (uses cleaned attrs + inner content with any
  // existing data-tdoc-aid stripped, so re-stamping is idempotent).
  const aids = [];
  for (const e of elements) {
    const cleanedAttrs = e.attrs.replace(/\s+data-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    // For nested commentables we hash the OUTER's content even though it
    // contains an inner commentable — that's correct, "outer artifact" is
    // a different identity than "inner artifact". We just strip any
    // data-tdoc-aid attributes from the inner before hashing so the
    // hash is stable across re-stampings.
    const cleanedInner = e.innerHtml.replace(/\sdata-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    e._cleanedAttrs = cleanedAttrs;
    e._aid = aidFor(e.tag, cleanedInner, cleanedAttrs);
    aids.push({
      aid: e._aid, tag: e.tag,
      head: e.innerHtml.slice(0, 80),
      heading: nearestHeadingAt(e.openStart),
    });
  }
  // Apply stamps in REVERSE order so earlier offsets stay valid as we mutate.
  elements.sort((a, b) => b.openStart - a.openStart);
  let out = rawHtml;
  for (const e of elements) {
    const stampedOpen = e.isVoid
      ? `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}"${/\/\s*$/.test(e.attrs) ? '/' : ''}>`
      : `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}">`;
    out = out.slice(0, e.openStart) + stampedOpen + out.slice(e.openEnd);
  }
  return { html: out, aids };
}

// Returns { changed, affectedComments, samples } describing aid drift between
// the legacy and current parser for this HTML, scoped to comments whose LIVE
// anchor target disappears under the hardened parser. Pure measurement; no
// mutation.
//
// Pairing-free by design: we do NOT try to build an old→new aid map by index
// (the two parsers can emit different element counts/order on exactly the edge-
// case HTML this measures, which would fabricate wrong mappings). Instead we use
// SET MEMBERSHIP, which can't mis-pair:
//   - legacySet = aids the legacy parser produced for this HTML (what stored
//     comments were anchored against).
//   - currentSet = aids the hardened parser produces now.
//   - A comment is "at risk" iff its live element aid is in legacySet but NOT in
//     currentSet — i.e. the fix made its anchor target's aid vanish, so reconcile
//     will have to rebind it. (If the aid is still present, the fix didn't move
//     that comment's target — safe.)
function measureAidDrift(rawHtml, comments) {
  let legacy, current;
  try { legacy = stampAidsLegacy(rawHtml).aids; } catch { return { changed: 0, affectedComments: 0, samples: [] }; }
  try { current = stampAids(rawHtml).aids; } catch { return { changed: 0, affectedComments: 0, samples: [] }; }
  const legacySet = new Set(legacy.map(a => a.aid));
  const currentSet = new Set(current.map(a => a.aid));
  // count of legacy aids that no longer exist under the hardened parser
  let changed = 0;
  for (const aid of legacySet) if (!currentSet.has(aid)) changed++;

  let affected = 0; const samples = [];
  for (const c of (Array.isArray(comments) ? comments : [])) {
    // Use the LIVE folded anchor (after replaying anchor_changed events), not the
    // raw created-event anchor — a comment already re-anchored must not be
    // counted against its stale original aid.
    //
    // CRITICAL: snapshotAt → ensureEventLog backfills eids IN PLACE, so we fold a
    // DEEP COPY. This keeps measureAidDrift strictly read-only — it must never
    // mutate the caller's list (the upload handler diffs before/after and would
    // otherwise persist an incidental eid-backfill from this log-only check).
    let anchor = null;
    try {
      if (Array.isArray(c && c.events)) {
        const copy = JSON.parse(JSON.stringify(c));
        anchor = snapshotAt(copy, Infinity)?.anchor || null;
      } else {
        anchor = c && c.anchor;
      }
    } catch { anchor = c && c.anchor; }
    const aid = anchor && anchor.kind === 'element' ? (anchor.aid || null) : null;
    // At risk iff its target existed under legacy but is gone under the fix.
    if (aid && legacySet.has(aid) && !currentSet.has(aid)) {
      affected++;
      if (samples.length < 5) samples.push({ id: c.id, lostAid: aid });
    }
  }
  return { changed, affectedComments: affected, samples };
}
// ---------------------------------------------------------------------------


// Walk the HTML and stamp `data-tdoc-aid` on every commentable element.
// Returns { html: <stamped>, aids: [{aid, tag, head, heading}] }.
//
// Two-pass design — the previous one-pass version was wrong: when an outer
// commentable (e.g. <figure>) contains an inner one (e.g. <svg>), naive
// regex walking skipped past the inner element's close tag. We now run
// SEPARATE passes per tag, so an svg inside a figure gets stamped just
// like a free-standing svg. Both are valid anchor targets.
function stampAids(rawHtml) {
  const headRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let hmatch;
  while ((hmatch = headRe.exec(rawHtml))) {
    headings.push({ end: hmatch.index + hmatch[0].length,
      text: hmatch[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() });
  }
  function nearestHeadingAt(idx) {
    let best = null;
    // Use <= so a heading whose close tag ends exactly at the next
    // element's open (no whitespace between) is still "before" it.
    for (const h of headings) { if (h.end <= idx) best = h.text; else break; }
    return best;
  }
  // Find every open tag of every stampable kind in document order.
  // For non-void tags, find its matching close (same-tag depth count).
  // Collect [openStart, openEnd, closeEnd, tag, attrs, innerHtml] per element.
  const elements = [];
  const seenOpens = new Set();   // dedupe across passes (tag pass + opt-in pass)
  function harvest(openStart, openEnd, tagLower, attrs) {
    if (seenOpens.has(openStart)) return;
    const isVoid = /^(img|iframe)$/i.test(tagLower) || /\/\s*$/.test(attrs);
    let closeEnd = openEnd, innerHtml = '';
    if (!isVoid) {
      // Depth-count matching open/close tags of THIS tag name, but:
      //  - skip over raw-text element bodies (<script>/<style>/...) so their
      //    unescaped content can't contain a fake close tag, and
      //  - resolve each open tag's end attribute-aware (a `>` inside an
      //    attribute value isn't the tag end).
      const openSameRe = new RegExp(`<${tagLower}\\b`, 'gi');
      const closeSameRe = new RegExp(`</${tagLower}\\s*>`, 'gi');
      const rawOpenRe = new RegExp(`<(${RAW_TEXT_TAGS.join('|')})\\b`, 'gi');
      let depth = 1, scan = openEnd, foundCloseEnd = -1;
      while (scan < rawHtml.length) {
        closeSameRe.lastIndex = scan;
        openSameRe.lastIndex = scan;
        rawOpenRe.lastIndex = scan;
        const mc = closeSameRe.exec(rawHtml);
        const mo = openSameRe.exec(rawHtml);
        const mr = rawOpenRe.exec(rawHtml);
        // pick the earliest of: a close, a nested same-tag open, a raw-text open
        const next = [mc, mo, mr].filter(Boolean).sort((a, b) => a.index - b.index)[0];
        if (!next) break;
        if (next === mr) {
          // leap over the raw-text body so its content can't desync depth
          const rTag = mr[1].toLowerCase();
          const rEnd = attrAwareOpenTagEnd(rawHtml, mr.index);
          if (rEnd < 0) break;
          const skipTo = skipRawTextBodyAt(rawHtml, rTag, rawHtml.slice(mr.index, rEnd), rEnd);
          scan = skipTo != null ? skipTo : rEnd;
          continue;
        }
        if (next === mc) {
          depth--; if (depth === 0) { foundCloseEnd = mc.index + mc[0].length; break; }
          scan = mc.index + mc[0].length;
        } else { // nested same-tag open
          depth++;
          const oEnd = attrAwareOpenTagEnd(rawHtml, mo.index);
          scan = oEnd < 0 ? mo.index + mo[0].length : oEnd;
        }
      }
      if (foundCloseEnd >= 0) closeEnd = foundCloseEnd;
      innerHtml = rawHtml.slice(openEnd, closeEnd - (`</${tagLower}>`.length));
    }
    seenOpens.add(openStart);
    elements.push({ openStart, openEnd, closeEnd, tag: tagLower, attrs, innerHtml, isVoid });
  }
  // Pass 1: every known stampable tag. Find the `<tag\b` start, then resolve
  // the open tag's true end attribute-aware so a `>` inside an attribute value
  // doesn't truncate the attrs (which would corrupt the stamp + the aid).
  for (const tag of STAMPABLE_TAGS) {
    const openRe = new RegExp(`<${tag}\\b`, 'gi');
    let m;
    while ((m = openRe.exec(rawHtml))) {
      const end = attrAwareOpenTagEnd(rawHtml, m.index);
      if (end < 0) continue;
      const attrs = rawHtml.slice(m.index + 1 + tag.length, end - 1);
      harvest(m.index, end, tag, attrs);
    }
  }
  // Pass 2: opt-in markers (any tag with data-tdoc-artifact or class
  // containing `tdoc-artifact`). Authors mark composed cards/widgets this
  // way so they're commentable as a unit. Match the tag name + a quick
  // attribute presence check, then resolve the real end attribute-aware.
  const optInProbe = /<([a-z][\w-]*)\b/gi;
  let om;
  while ((om = optInProbe.exec(rawHtml))) {
    const tagLower = om[1].toLowerCase();
    const end = attrAwareOpenTagEnd(rawHtml, om.index);
    if (end < 0) continue;
    const attrs = rawHtml.slice(om.index + 1 + om[1].length, end - 1);
    if (/\bdata-tdoc-artifact\b/i.test(attrs) || /class\s*=\s*"[^"]*\btdoc-artifact\b[^"]*"/i.test(attrs)) {
      harvest(om.index, end, tagLower, attrs);
    }
  }
  // Compute aid per element (uses cleaned attrs + inner content with any
  // existing data-tdoc-aid stripped, so re-stamping is idempotent).
  const aids = [];
  for (const e of elements) {
    const cleanedAttrs = e.attrs.replace(/\s+data-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    // For nested commentables we hash the OUTER's content even though it
    // contains an inner commentable — that's correct, "outer artifact" is
    // a different identity than "inner artifact". We just strip any
    // data-tdoc-aid attributes from the inner before hashing so the
    // hash is stable across re-stampings.
    const cleanedInner = e.innerHtml.replace(/\sdata-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    e._cleanedAttrs = cleanedAttrs;
    e._aid = aidFor(e.tag, cleanedInner, cleanedAttrs);
    aids.push({
      aid: e._aid, tag: e.tag,
      head: e.innerHtml.slice(0, 80),
      heading: nearestHeadingAt(e.openStart),
    });
  }
  // Apply stamps in REVERSE order so earlier offsets stay valid as we mutate.
  elements.sort((a, b) => b.openStart - a.openStart);
  let out = rawHtml;
  for (const e of elements) {
    const stampedOpen = e.isVoid
      ? `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}"${/\/\s*$/.test(e.attrs) ? '/' : ''}>`
      : `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}">`;
    out = out.slice(0, e.openStart) + stampedOpen + out.slice(e.openEnd);
  }
  return { html: out, aids };
}

// Reconcile open comment anchors against the freshly-stamped artifact set.
// Mutates `comments` in-place (returns it). Behavior:
//   • If the comment's anchor already targets a known aid (either stored
//     in `anchor.aid` or the selector is `[data-tdoc-aid="..."]`), it's
//     authoritative — leave it.
//   • If the comment has a `fingerprint` that matches one aid by content,
//     stamp `anchor.aid = <that aid>` so future resolution is identity-first.
//   • Otherwise (legacy positional selector + no fingerprint), try a
//     best-effort backfill: tag must match and the nearestHeading hint (if
//     present) must match too. Single high-confidence candidate → adopt;
//     ambiguous or missing → mark `anchor.kind = "lost"` so the comment
//     renders unanchored INSTEAD OF SILENTLY POINTING AT THE WRONG ARTIFACT.
// Reconcile anchors at upload time of version V. For each comment that is
// ALIVE at V, look at its snapshot's anchor; if the aid no longer resolves
// in this version's stamped artifacts, attempt to find the right aid by
// fingerprint + heading and APPEND an `anchor_changed` event stamped at V.
// We never mutate older events — older versions keep their own anchors.
//
// Result: per-version anchor mapping is naturally encoded in the event log.
// A comment created on v5 with aid X, then rebound on v7 to aid Y, will
// resolve to X on v5/v6 (via its `created` event) and to Y on v7+ (via the
// new `anchor_changed` event). This replaces aid_history.
function reconcileAnchors(comments, aidsInVersion, V) {
  if (!Array.isArray(comments)) return comments;
  ensureMigrated(comments);
  const byAid = new Map(aidsInVersion.map(a => [a.aid, a]));
  const version = Number(V) || 1;
  const now = new Date().toISOString();

  for (const c of comments) {
    const snap = snapshotAt(c, version);
    if (!snap || snap.deleted) continue;
    const a = snap.anchor;
    // Element anchors can drift; `lost` anchors can RECOVER if the artifact
    // returns in a later version. Both must run through the fingerprint match
    // below. Previously `lost` anchors hit `a.kind !== 'element'` → continue,
    // so once lost they were orphaned forever even when the target came back.
    // (text anchors are resolved client-side, not here.)
    if (!a || (a.kind !== 'element' && a.kind !== 'lost')) continue;

    const knownAid = a.aid
      || (a.selector && /\[data-tdoc-aid="([\w]+)"\]/.exec(a.selector || '')?.[1]);
    // Already valid in this version → nothing to do. (lost anchors have no aid,
    // so they always fall through to the re-bind attempt.)
    if (knownAid && byAid.has(knownAid)) continue;

    // Try fingerprint + heading match against this version's artifacts.
    const fp = a.fingerprint;
    const wantTag = (fp && fp.tag) || (a.label || '').toLowerCase();
    const wantHead = a.fallback && a.fallback.nearestHeading && a.fallback.nearestHeading.text;
    const candidates = aidsInVersion.filter(x =>
      (!wantTag || x.tag === wantTag) &&
      (!wantHead || (x.heading || '').toLowerCase() === wantHead.toLowerCase())
    );
    let newAid = null;
    if (candidates.length === 1) newAid = candidates[0].aid;
    else if (candidates.length === 0) {
      const tagOnly = aidsInVersion.filter(x => !wantTag || x.tag === wantTag);
      if (tagOnly.length === 1) newAid = tagOnly[0].aid;
    }

    if (newAid) {
      // Append the rebind as an event at THIS version. Older folds are
      // unchanged.
      appendEvent(c, {
        kind: 'anchor_changed', at_version: version, at: now, by: 'reconcile',
        reset_status: false,
        anchor: {
          kind: 'element',
          aid: newAid,
          selector: `[data-tdoc-aid="${newAid}"]`,
          label: a.label || (fp && fp.tag) || 'element',
          ...(fp ? { fingerprint: fp } : {}),
          ...(a.fallback ? { fallback: a.fallback } : {}),
        },
      });
    } else if (a.kind !== 'lost') {
      // No confident match AND it wasn't already lost → mark it lost in this
      // version. Older versions keep their valid anchors (they fold to earlier
      // anchor_changed/created events that still resolve). If it was ALREADY
      // lost and still has no candidate, do nothing — re-appending an identical
      // lost event every publish would bloat the log for no benefit.
      appendEvent(c, {
        kind: 'anchor_changed', at_version: version, at: now, by: 'reconcile',
        reset_status: false,
        anchor: {
          kind: 'lost',
          reason: candidates.length > 1 ? 'ambiguous' : 'no_candidate',
          ...(a.label ? { label: a.label } : {}),
          ...(fp ? { fingerprint: fp } : {}),
          ...(a.fallback ? { fallback: a.fallback } : {}),
        },
      });
    }
  }
  return comments;
}

// Inject the overlay boot + an arbitrary cfg into a document. Single source of
// truth for "put window.__TDOC__ + overlay.js before </body>" — used by both
// the published view and the /fork view (which previously re-implemented this
// inline, risking drift).
function injectOverlayCfg(rawHtml, cfg) {
  const inject =
    `<script>window.__TDOC__ = ${safeJsonForScript(cfg)};</script>\n` +
    `<script>${OVERLAY_JS}</script>`;
  if (rawHtml.includes('</body>')) return rawHtml.replace('</body>', `${inject}\n</body>`);
  return rawHtml + inject;
}

function injectOverlay(rawHtml, slug, version, identity, versions, isOwner) {
  return injectOverlayCfg(rawHtml, {
    slug, version,
    identity: identity || null,
    isOwner: !!isOwner,
    authConfigured: true,
    mode: 'published',
    versions: Array.isArray(versions) && versions.length ? versions : [{ n: version }],
  });
}

// Neutral landing page served at `/`. No catalog, no slug list — just
// brand + a link to the open-source project. Docs are link-only.
function landingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lucius</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; min-height: 100vh;
    margin: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; color: #111; background: #fff; gap: 10px; }
  h1 { font-size: 30px; margin: 0; color: #1652f0; }
  p { color: #666; margin: 0; }
  a { color: #1652f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .sub { margin-top: 14px; font-size: 13px; color: #888; }
</style></head><body>
  <h1>lucius</h1>
  <p>Prompt-native, commentable documents.</p>
  <p class="sub">Open a document from its shared link ·
    <a href="https://github.com/serenakeyitan/tdoc">github.com/serenakeyitan/tdoc</a></p>
</body></html>`;
}

async function indexHtml(env, session) {
  // List all `meta:` keys.
  let list = [];
  let cursor;
  do {
    const r = await env.META.list({ prefix: 'meta:', cursor });
    list = list.concat(r.keys);
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);

  const rows = [];
  for (const k of list) {
    const slug = k.name.slice('meta:'.length);
    const metaRaw = await env.META.get(k.name);
    let meta = {};
    try { meta = JSON.parse(metaRaw || '{}'); } catch {}
    const latest = meta.versions?.[meta.versions.length - 1]?.n || 1;
    // Only list docs whose latest version actually exists in R2 — otherwise
    // the index advertises 404s. (We hit this when R2 writes silently failed
    // while KV meta updates succeeded; defense in depth.)
    const exists = await env.DOCS.head(`docs/${slug}/v${latest}/index.html`);
    if (!exists) continue;
    rows.push(`<tr>
      <td><a href="/d/${encodeURIComponent(slug)}/v/${latest}">${escapeHtml(meta.title || slug)}</a></td>
      <td>${escapeHtml(slug)}</td>
      <td>v${latest}</td>
    </tr>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>lucius</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 28px; margin: 0 0 4px; color: #1652f0; }
  .sub { color: #666; margin: 0 0 32px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eee; }
  th { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.04em; }
  a { color: #1652f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 40px 0; text-align: center; }
  .who { color: #888; font-size: 13px; margin: 0 0 32px; }
  .who b { color: #444; font-weight: 600; }
</style></head><body>
<h1>My docs</h1>
<p class="who">Documents hosted on this worker${session && session.login ? ` · signed in as <b>${escapeHtml(session.login)}</b>` : ''}.</p>
${rows.length === 0 ? '<p class="empty">No published docs yet.</p>' :
  `<table><thead><tr><th>Title</th><th>Slug</th><th>Version</th></tr></thead><tbody>${rows.join('')}</tbody></table>`}
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────
// EVENT-LOG COMMENT MODEL (v0.2)
//
// Each comment is stored as { id, author, created_in, created, events: [...] }.
// Events: created, text_edited, anchor_changed, marked_applied, deleted,
//   reaction_added, reaction_removed, reply_added, reply_text_edited,
//   reply_deleted, reply_reaction_added, reply_reaction_removed.
// Every event carries `at_version` and `at` (ISO timestamp).
//
// THE FUNDAMENTAL RULE: every version is a snapshot. Reading a comment "as
// of version N" folds events with at_version <= N. Mutations NEVER overwrite
// past state — they append a new event. Going back to an older version
// shows the comment exactly as it existed then; going forward shows the
// latest state.
//
// Agent emoji (✅🟡❓) is rendered at fold time from marked_applied events,
// not stored as a reaction record. That way the agent verdict is per-version
// just like any other status.

const AGENT_STATUS_EMOJI = { applied: '✅', partial: '🟡', question: '❓' };

function isFiniteVersion(v) {
  return Number.isFinite(v) && v >= 0;
}

// Build a fresh `created` event from a legacy record. Used in lazy migration.
function legacyToEvents(c) {
  const events = [];
  const at = c.created || new Date().toISOString();
  const v = Number(c.version) || 1;
  events.push({
    kind: 'created', at_version: v, at,
    anchor: c.anchor || null,
    text: c.text || '',
  });
  if (c.status === 'applied') {
    events.push({
      kind: 'marked_applied', at_version: Number(c.applied_in) || v, at,
      applied_in: Number(c.applied_in) || v,
      by: 'lucius-agent',
      agent_status: 'applied',
    });
  }
  // Reactions become add events stamped at the comment's create version.
  if (c.reactions && typeof c.reactions === 'object') {
    for (const emoji of Object.keys(c.reactions)) {
      const users = c.reactions[emoji] || [];
      for (const login of users) {
        events.push({ kind: 'reaction_added', at_version: v, at, by: login, emoji });
      }
    }
  }
  // Replies become reply_added events. Each carries its own author + text,
  // and reactions are folded into reply_reaction_added events.
  if (Array.isArray(c.replies)) {
    for (const r of c.replies) {
      events.push({
        kind: 'reply_added', at_version: Number(r.version) || v, at: r.created || at,
        reply: {
          id: r.id, author: r.author || null, text: r.text || '',
          agent_status: r.agent_status || null,
        },
      });
      if (r.reactions && typeof r.reactions === 'object') {
        for (const emoji of Object.keys(r.reactions)) {
          for (const login of (r.reactions[emoji] || [])) {
            events.push({
              kind: 'reply_reaction_added', at_version: Number(r.version) || v,
              at: r.created || at, reply_id: r.id, by: login, emoji,
            });
          }
        }
      }
    }
  }
  return events;
}

// Backfill `eid` on any event that lacks one (legacy records, events built by
// object literals that bypassed appendEvent). Idempotent. Mutates in place;
// returns true if anything changed. This guarantees dedupEvents (the
// convergence point) always has an eid to key on.
function backfillEids(events) {
  let changed = false;
  if (!Array.isArray(events)) return false;
  for (const e of events) { if (e && !e.eid) { e.eid = eventEid(e); changed = true; } }
  return changed;
}

// If a record doesn't have `events[]`, build one in-place. Returns true if
// the record was migrated OR had eids backfilled (caller may want to persist).
function ensureEventLog(c) {
  if (c && Array.isArray(c.events)) return backfillEids(c.events);
  if (!c || !c.id) return false;
  const events = legacyToEvents(c);
  backfillEids(events);
  c.events = events;
  c.created_in = events[0]?.at_version || Number(c.version) || 1;
  // Author + created are immutable identity, keep them at the top level.
  c.author = c.author || (events[0]?.reply ? events[0].reply.author : null) || null;
  c.created = c.created || events[0]?.at || new Date().toISOString();
  return true;
}

// Fold a comment record into its snapshot AS OF version V.
// Returns the flat shape today's overlay already understands:
//   { id, version, author, created, anchor, text, status, applied_in,
//     replies, reactions, deleted, created_in }
// Returns null if the comment did not yet exist at V.
function snapshotAt(c, V) {
  ensureEventLog(c);
  if (!Array.isArray(c.events) || c.events.length === 0) return null;
  const at = isFiniteVersion(V) ? V : Infinity;
  if (c.created_in != null && c.created_in > at) return null;
  // Default snapshot scaffold.
  const snap = {
    id: c.id,
    author: c.author,
    created: c.created,
    created_in: c.created_in,
    version: c.created_in,
    anchor: null,
    text: '',
    status: 'open',
    applied_in: undefined,
    replies: [],
    reactions: {},
    deleted: false,
  };
  // Reply folds keyed by reply id, in insertion order.
  const replyOrder = [];
  const replyById = new Map();
  // Replay events deduped by eid (convergence under concurrent appends — see
  // dedupEvents) and STABLE-SORTED by at_version. The old code replayed in
  // physical append order assuming it was monotonic in version, but
  // anchor_changed/reconcile can append an event stamped at an OLDER version
  // after a newer one (e.g. re-anchoring while viewing an old version, or a
  // republish reconcile), letting a backdated event wrongly win the latest
  // snapshot. Sorting by at_version with a stable tiebreak (original index)
  // makes the fold order-independent of write order.
  const ordered = dedupEvents(c.events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => ((a.e.at_version || 0) - (b.e.at_version || 0)) || (a.i - b.i))
    .map(x => x.e);
  for (const e of ordered) {
    if (!e || !isFiniteVersion(e.at_version) || e.at_version > at) continue;
    switch (e.kind) {
      case 'created':
        snap.anchor = e.anchor || null;
        snap.text = e.text || '';
        break;
      case 'text_edited':
        snap.text = e.text || '';
        break;
      case 'anchor_changed':
        snap.anchor = e.anchor || null;
        // Re-anchor resets the agent verdict (matches prior PATCH behavior).
        if (e.reset_status) { snap.status = 'open'; snap.applied_in = undefined; }
        break;
      case 'marked_applied':
        snap.status = 'applied';
        snap.applied_in = e.applied_in || e.at_version;
        snap._agentVerdict = e.agent_status || 'applied';
        break;
      case 'marked_open':
        snap.status = 'open';
        snap.applied_in = undefined;
        snap._agentVerdict = e.agent_status || null;
        break;
      case 'deleted':
        snap.deleted = true;
        break;
      case 'reaction_added': {
        if (!e.emoji || !e.by) break;
        const u = snap.reactions[e.emoji] || [];
        if (!u.includes(e.by)) u.push(e.by);
        snap.reactions[e.emoji] = u;
        break;
      }
      case 'reaction_removed': {
        if (!e.emoji || !e.by) break;
        const u = snap.reactions[e.emoji] || [];
        const idx = u.indexOf(e.by);
        if (idx >= 0) u.splice(idx, 1);
        if (u.length) snap.reactions[e.emoji] = u; else delete snap.reactions[e.emoji];
        break;
      }
      case 'reply_added': {
        if (!e.reply || !e.reply.id) break;
        const r = {
          id: e.reply.id, parent_id: c.id,
          author: e.reply.author || null,
          text: e.reply.text || '',
          agent_status: e.reply.agent_status || null,
          created: e.at,
          reactions: {},
          deleted: false,
        };
        replyOrder.push(r.id);
        replyById.set(r.id, r);
        break;
      }
      case 'reply_text_edited': {
        const r = replyById.get(e.reply_id);
        if (r) r.text = e.text || '';
        break;
      }
      case 'reply_deleted': {
        const r = replyById.get(e.reply_id);
        if (r) r.deleted = true;
        break;
      }
      case 'reply_reaction_added': {
        const r = replyById.get(e.reply_id);
        if (!r || !e.emoji || !e.by) break;
        const u = r.reactions[e.emoji] || [];
        if (!u.includes(e.by)) u.push(e.by);
        r.reactions[e.emoji] = u;
        break;
      }
      case 'reply_reaction_removed': {
        const r = replyById.get(e.reply_id);
        if (!r || !e.emoji || !e.by) break;
        const u = r.reactions[e.emoji] || [];
        const idx = u.indexOf(e.by);
        if (idx >= 0) u.splice(idx, 1);
        if (u.length) r.reactions[e.emoji] = u; else delete r.reactions[e.emoji];
        break;
      }
    }
  }
  // Apply the agent emoji synthetically so the UI behavior (✅/🟡/❓ on the
  // parent card) matches today without storing it as a real reaction event.
  if (snap._agentVerdict && AGENT_STATUS_EMOJI[snap._agentVerdict]) {
    const emoji = AGENT_STATUS_EMOJI[snap._agentVerdict];
    const u = snap.reactions[emoji] || [];
    if (!u.includes('lucius-agent')) u.push('lucius-agent');
    snap.reactions[emoji] = u;
  }
  delete snap._agentVerdict;
  snap.replies = replyOrder.map(id => replyById.get(id)).filter(r => r && !r.deleted);
  return snap;
}

// Fold the full list at version V, filter out alive comments only.
// `V = Infinity` (or undefined) = latest snapshot, no version filter.
function snapshotList(list, V) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const s = snapshotAt(c, V);
    if (s && !s.deleted) out.push(s);
  }
  return out;
}

// Fold EVERY comment that ever existed across ALL versions, regardless of the
// version it was created in. This is the durable, lossless view used by
// `tdoc-pull` so that pulling never drops comments anchored to an older
// version (snapshotList at latest would hide a comment created on v3 once the
// doc is on v5). Each comment is folded at Infinity (its richest state).
// Deleted comments are still excluded — a delete is an intentional removal,
// not version scoping.
function historyList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const s = snapshotAt(c, Infinity);
    if (s && !s.deleted) out.push(s);
  }
  return out;
}

// Helper used by all mutating endpoints: ensure the list is migrated to the
// event-log shape before we touch it. Returns the (possibly mutated) list.
function ensureMigrated(list) {
  let dirty = false;
  for (const c of list) {
    if (ensureEventLog(c)) dirty = true;
  }
  return dirty;
}

// Append an event to a comment record (auto-creates events[] if missing).
// Stamp a stable event id so the log converges under concurrent appends.
// Cloudflare KV has no atomic compare-and-set (the only true serialization is
// a Durable Object — tracked separately), so two writers can each read, append,
// and write, with last-write-wins clobbering one append. We make that tolerable
// instead of corrupting: every event carries an `eid`, and the fold dedups by
// it (see dedupEvents). Some events are *naturally idempotent* and get a
// DETERMINISTIC eid so a concurrent duplicate collapses to one:
//   reaction_added/removed → reaction:<kind>:<emoji>:<by>   (toggle converges)
//   marked_applied/open/deleted → <kind>:<at_version>       (state, not history)
// One-shot events (created, reply_added, text_edited, anchor_changed) get a
// unique eid so each is preserved.
function eventEid(e) {
  switch (e.kind) {
    case 'reaction_added':
    case 'reaction_removed':
      return `${e.kind}:${e.emoji}:${e.by}`;
    case 'marked_applied':
    case 'marked_open':
    case 'deleted':
      return `${e.kind}:${e.at_version}`;
    default:
      return `${e.kind}:${e.at}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
function appendEvent(c, event) {
  if (!Array.isArray(c.events)) c.events = [];
  if (!event.eid) event.eid = eventEid(event);
  c.events.push(event);
}
// Collapse events sharing an eid, keeping the last occurrence (last write wins
// per-event, which is correct for the deterministic-eid state events and
// harmless for unique-eid history events). Returns a new array in original
// order of first appearance. This is the convergence point: merging two
// concurrently-written logs and folding through dedupEvents yields the same
// result regardless of which write landed last.
function dedupEvents(events) {
  if (!Array.isArray(events)) return [];
  const lastByEid = new Map();
  for (const e of events) { if (e && e.eid) lastByEid.set(e.eid, e); }
  const out = [], emitted = new Set();
  for (const e of events) {
    if (!e) continue;
    const id = e.eid;
    if (id == null) { out.push(e); continue; }
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push(lastByEid.get(id));
  }
  return out;
}

// Permanently collapse each comment's event log to its deduped form. Called at
// publish time so the STORED value stops growing unboundedly toward KV's 25MB
// cap (superseded reaction toggles, duplicate-eid events from concurrent
// writes). This is a no-op for correctness — the read-time fold already dedups
// — it only shrinks what's persisted. Returns true if anything was compacted.
function compactComments(comments) {
  let changed = false;
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    if (!c || !Array.isArray(c.events)) continue;
    backfillEids(c.events);
    const compacted = dedupEvents(c.events);
    if (compacted.length !== c.events.length) { c.events = compacted; changed = true; }
  }
  return changed;
}

// Parse the version query param. Returns Infinity when missing/invalid so
// caller gets the latest snapshot (matches pre-versioned behavior). The
// sentinel string 'all' requests the full cross-version history (used by
// tdoc-pull) so callers can opt out of version scoping entirely.
function parseVersionParam(url) {
  const v = url.searchParams.get('version');
  if (v == null || v === '') return Infinity;
  if (v === 'all') return 'all';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

// ---- GitHub helpers ----

async function ghPost(path, formObj) {
  const body = new URLSearchParams(formObj).toString();
  const r = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tdoc-worker',
    },
    body,
  });
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();
  // GitHub sometimes returns form-encoded even with Accept: application/json
  // (notably the device-flow endpoints). Detect and parse both shapes.
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { error: 'gh_parse', error_description: raw.slice(0, 200) }; }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  if (!Object.keys(out).length) return { error: 'gh_empty', error_description: `status=${r.status} ct=${ct}` };
  return out;
}
async function ghUser(token) {
  const r = await fetch('https://api.github.com/user', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'tdoc-worker',
    },
  });
  return r.json();
}

function requireUploadAuth(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m || !env.TDOC_UPLOAD_TOKEN || m[1] !== env.TDOC_UPLOAD_TOKEN) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

// ===========================================================================
// #34 — Per-slug write serialization via a Durable Object.
//
// PROBLEM: every comment mutation does get(comments:slug) → JSON.parse → mutate
// → put(comments:slug) on a single KV value with no compare-and-set. Two
// concurrent writers each read the same base, append independently, and the
// second put clobbers the first — a lost update, defeating the append-only log.
//
// FIX (Option A — DO owns the writes): all mutations for one slug run INSIDE a
// single Durable Object instance (idFromName(slug)). Cloudflare guarantees a DO
// processes requests single-threaded, so same-slug get→mutate→put can't
// overlap. The race is impossible by construction — no lock, no watchdog, no
// stuck-lock failure mode.
//
// The mutation LOGIC stays in one shared place: applyCommentOp(list, op, ...).
// Endpoints build a serializable `op` descriptor; the DO replays it atomically.
// A KV fallback (when the DO binding is absent) keeps the worker functional
// before/without the migration — same code path, just not serialized.
// ===========================================================================

// Apply one comment operation to the in-memory list. PURE w.r.t. I/O: it only
// mutates `list` and returns { status, body }. Both the DO path and the KV
// fallback call this, so mutation logic is defined exactly once.
//   op = { kind, ... } — see each endpoint for the shape it builds.
function applyCommentOp(list, op) {
  ensureMigrated(list);
  const now = op.at || new Date().toISOString();
  switch (op.kind) {
    case 'create': {
      const entry = {
        id: op.id, author: op.author, created: now, created_in: op.version,
        events: [{ kind: 'created', at_version: op.version, at: now, anchor: op.anchor || null, text: op.text }],
      };
      backfillEids(entry.events);
      list.push(entry);
      return { status: 200, body: snapshotAt(entry, op.version) };
    }
    case 'reply': {
      const parent = list.find(c => c.id === op.parent_id);
      if (!parent) return { status: 404, body: { error: 'parent_not_found' } };
      appendEvent(parent, { kind: 'reply_added', at_version: op.version, at: now,
        reply: { id: op.reply_id, author: op.author, text: op.text, agent_status: null } });
      return { status: 200, body: { id: op.reply_id, parent_id: op.parent_id, author: op.author, text: op.text, created: now, version: op.version } };
    }
    case 'patch_anchor': {
      // Authorization is enforced UPSTREAM in the worker (canMutate, which needs
      // session+env). The DO/applyCommentOp only serializes the write.
      const target = list.find(c => c.id === op.id);
      if (!target) return { status: 404, body: { error: 'not_found' } };
      appendEvent(target, { kind: 'anchor_changed', at_version: op.version, at: now, reset_status: op.reset_status, anchor: op.anchor, by: op.actor && op.actor.login });
      return { status: 200, body: snapshotAt(target, op.version) };
    }
    case 'react': {
      // The add-vs-remove toggle is computed HERE, inside the serialized write,
      // from the authoritative freshly-read list — NOT upstream. Computing it in
      // the worker would reintroduce the exact toggle race #34 fixes (two
      // concurrent toggles both seeing "not reacted" → double add).
      let host = list.find(c => c.id === op.comment_id);
      let isReply = false, replyId = null;
      if (!host) {
        for (const c of list) {
          const reAdded = (c.events || []).find(e => e.kind === 'reply_added' && e.reply?.id === op.comment_id);
          if (reAdded) { host = c; isReply = true; replyId = op.comment_id; break; }
        }
      }
      if (!host) return { status: 404, body: { error: 'not_found' } };
      const snap = snapshotAt(host, op.version);
      if (!snap) return { status: 404, body: { error: 'not_visible_at_version' } };
      const cur = isReply ? (snap.replies.find(r => r.id === replyId)?.reactions || {}) : snap.reactions;
      const had = (cur[op.emoji] || []).includes(op.by);
      const evt = { at_version: op.version, at: now, emoji: op.emoji, by: op.by };
      if (isReply) { evt.kind = had ? 'reply_reaction_removed' : 'reply_reaction_added'; evt.reply_id = replyId; }
      else { evt.kind = had ? 'reaction_removed' : 'reaction_added'; }
      appendEvent(host, evt);
      const fresh = snapshotAt(host, op.version);
      const reactions = isReply ? (fresh.replies.find(r => r.id === replyId)?.reactions || {}) : fresh.reactions;
      return { status: 200, body: { ok: true, reactions } };
    }
    case 'delete': {
      // Authorization enforced upstream (worker resolves target + canMutate
      // before building this op). The DO only serializes the soft-delete write.
      const top = list.find(c => c.id === op.id);
      if (top) {
        appendEvent(top, { kind: 'deleted', at_version: op.version, at: now, by: op.actor.login });
        return { status: 200, body: { ok: true } };
      }
      for (const c of list) {
        ensureEventLog(c);
        const re = (c.events || []).find(e => e.kind === 'reply_added' && e.reply?.id === op.id);
        if (re) {
          appendEvent(c, { kind: 'reply_deleted', at_version: op.version, at: now, reply_id: op.id, by: op.actor.login });
          return { status: 200, body: { ok: true } };
        }
      }
      return { status: 404, body: { error: 'not_found' } };
    }
    case 'raw_events': {
      // pre-built events array to append to a specific comment (agent/reply path)
      const target = list.find(c => c.id === op.id);
      if (!target) return { status: 404, body: { error: 'not_found' } };
      for (const ev of op.events) appendEvent(target, ev);
      return { status: 200, body: op.responseBody || { ok: true } };
    }
    case 'wipe': {
      // Admin: drop ALL comments for the slug. Serialized through the DO so it
      // can't race a concurrent mutation into a nondeterministic final state.
      // Signals the DO to delete the key (handled specially in the DO/fallback).
      return { status: 200, body: { ok: true, deleted: list.length }, __wipe: true };
    }
    case 'publish_merge': {
      // Publish-time: non-destructively merge tdoc-publish's local comments
      // (add by id only if absent — never overwrite/delete worker comments),
      // then reconcile anchors against the new artifact set + compact. Same
      // logic the upload handler used inline; now serialized through the DO.
      let merged = 0;
      if (Array.isArray(op.localComments) && op.localComments.length) {
        const have = new Set(list.map(c => c && c.id).filter(Boolean));
        for (const lc of op.localComments) {
          if (!lc || !lc.id || have.has(lc.id)) continue;
          ensureEventLog(lc);
          list.push(lc);
          have.add(lc.id);
          merged++;
        }
      }
      if (list.length) {
        reconcileAnchors(list, op.aids || [], op.version);
        compactComments(list);
      }
      return { status: 200, body: { mergedComments: merged } };
    }
    default:
      return { status: 400, body: { error: 'unknown_op' } };
  }
}

// Parse a stored comments value defensively. A corrupt KV/DO value (malformed
// JSON, or JSON that isn't an array) must NOT turn every comment operation for
// that slug into a permanent 500 — we log and fall back to an empty list so the
// slug self-heals on the next write. (#33 hardening.)
function safeParseList(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
    console.error('[comments] stored value is not an array — treating as empty');
    return [];
  } catch (e) {
    console.error('[comments] corrupt stored value, treating as empty:', e.message);
    return [];
  }
}

// Run a comment mutation for `slug`, serialized per-slug through the DO. Returns
// { status, body }. `op` must be JSON-serializable.
//
// IMPORTANT: the DO stores the comment list in state.storage (input-gated), NOT
// in KV. Cloudflare's input gates only serialize Durable Object STORAGE
// operations — KV reads/writes inside a DO still interleave across concurrent
// requests, which silently loses updates (the bug a KV-based DO had). With
// state.storage the get→mutate→put is gated and concurrent same-slug writes
// serialize correctly.
async function mutateComments(env, slug, op) {
  if (env.COMMENTS) {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, op }),
    });
    return r.json();
  }
  // Fallback (DO binding absent): direct KV read-modify-write. NOT serialized,
  // but keeps the worker functional without the DO. The DO path is the norm.
  const cKey = `comments:${slug}`;
  const raw = await env.META.get(cKey);
  const list = safeParseList(raw);
  const res = applyCommentOp(list, op);
  if (res.status === 200) {
    if (res.__wipe) await env.META.delete(cKey);
    else await env.META.put(cKey, JSON.stringify(list));
  }
  const { __wipe, ...clean } = res;
  return clean;
}

// Read the comment list for `slug` from the DO (the source of truth). Returns
// the raw list array; callers fold it (snapshotList / historyList). When the DO
// binding is absent, falls back to reading KV directly.
async function readComments(env, slug) {
  if (env.COMMENTS) {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const out = await r.json();
    return Array.isArray(out.list) ? out.list : [];
  }
  const raw = await env.META.get(`comments:${slug}`);
  return safeParseList(raw);
}

// The Durable Object: single-threaded, input-gated owner of one slug's comment
// list. The list lives in state.storage under key 'list'. On first touch it is
// lazily migrated in from the legacy KV value (comments:<slug>) so existing
// comments are preserved with zero data loss; the KV value is left intact as a
// backstop. All same-slug reads/writes funnel through this one instance.
export class CommentsStore {
  constructor(state, env) { this.state = state; this.env = env; }

  // Resolve the list for `slug` from DO storage INSIDE transaction txn, doing
  // the one-time legacy-KV migration on first touch. DO storage is the SOLE
  // source of truth — there is no KV mirror (Codex P2: a post-commit KV mirror
  // can finish out of order and silently lose a committed update, and was never
  // a reliable fallback). Fails CLOSED on a corrupt stored value rather than
  // silently discarding recoverable data (Codex P2: safeParseList-on-write =
  // silent loss): an absent KV value is a genuinely empty doc ([]); a
  // present-but-corrupt one throws so the write is rejected and the bytes are
  // preserved for recovery.
  async _loadInTxn(txn, slug) {
    const list = await txn.get('list');
    if (list === undefined) {
      const raw = await this.env.META.get(`comments:${slug}`);
      if (raw == null) return [];                 // empty doc, not corruption
      let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('legacy_kv_corrupt'); }
      if (!Array.isArray(parsed)) throw new Error('legacy_kv_corrupt');
      return parsed;
    }
    if (!Array.isArray(list)) throw new Error('do_storage_corrupt'); // fail closed
    return list;
  }

  async fetch(req) {
    const u = new URL(req.url);
    let payload;
    try { payload = await req.json(); } catch { return Response.json({ list: [] }); }
    const { slug, op } = payload;

    // READ: resolve inside a transaction so a concurrent first-touch mutation
    // can't commit between a non-transactional get and a write-back (Codex P1:
    // the old _load() seeded KV→DO storage outside any txn, so a read could
    // clobber an already-committed mutation). A first-touch migration is
    // persisted (seeds the canonical store) but only when storage was empty —
    // never an overwrite. On a corrupt value, return [] for DISPLAY only; the
    // stored bytes are left intact.
    if (u.pathname === '/read') {
      let list = [];
      try {
        await this.state.storage.transaction(async (txn) => {
          const empty = (await txn.get('list')) === undefined;
          list = await this._loadInTxn(txn, slug);
          if (empty) await txn.put('list', list);
        });
      } catch { list = []; }
      return Response.json({ list });
    }

    // MUTATE: atomic read-modify-write via state.storage.transaction(). Storage
    // ops inside it are input-gated, so concurrent same-slug mutations
    // serialize. (Prior attempts failed: KV-inside-DO wasn't gated → lost
    // updates; blockConcurrencyWhile around the handler 500'd under load.)
    let out;
    try {
      await this.state.storage.transaction(async (txn) => {
        const list = await this._loadInTxn(txn, slug);
        const res = applyCommentOp(list, op);
        if (res.status === 200) await txn.put('list', res.__wipe ? [] : list);
        out = { res };
      });
    } catch (e) {
      // Corrupt stored value → reject the write, preserve the bytes. 409 so the
      // caller knows it's a recoverable conflict, not a transient 500.
      if (e && /corrupt/.test(e.message || '')) {
        return Response.json({ status: 409, error: 'comments_store_corrupt', message: 'stored comments are corrupt; manual recovery required' });
      }
      throw e;
    }
    const { __wipe, ...clean } = out.res;
    return Response.json(clean);
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p === '/api/ping') return json({ ok: true, service: 'tdoc' });

    // ---- landing (NO public catalog) ----
    // `/` never lists docs. Docs are only reachable via their direct link.
    // A neutral branded page points at the open-source project.
    if (p === '/' && method === 'GET') return html(landingHtml());

    // ---- owner-only doc catalog ----
    // `/me` returns the list of every doc hosted on THIS worker, but only
    // to the configured owner (TDOC_OWNER) when signed in. Everyone else
    // gets redirected to the GitHub repo — no slug enumeration.
    if (p === '/me' && method === 'GET') {
      const s = await getSession(env, req);
      if (!isOwnerSession(env, s)) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://github.com/serenakeyitan/tdoc' },
        });
      }
      return html(await indexHtml(env, s));
    }

    // ---- doc view ----
    const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
    if (docMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr] = docMatch;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/index.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr}`, { status: 404 });
      const raw = await obj.text();
      const session = await getSession(env, req);
      const identity = session ? { login: session.login, avatar_url: session.avatar_url, name: session.name } : null;
      // Pull the full versions array from meta so the bar can render a
      // version picker. Falls back to single-version if meta is missing.
      let versions = null;
      try {
        const metaRaw = await env.META.get(`meta:${slug}`);
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          if (Array.isArray(meta.versions)) versions = meta.versions.map(v => ({ n: v.n, created: v.created || null }));
        }
      } catch {}
      return html(injectOverlay(raw, slug, Number(vStr), identity, versions, isOwnerSession(env, session)));
    }

    // ---- doc export / fork ----
    // /export → forces a file download (Content-Disposition: attachment) unless
    //           ?download=0. Used for "save a copy" links.
    // /fork   → returns the SAME bundled HTML but boots the overlay in
    //           mode:"fork" (read-only renderable view with comments mirrored
    //           from the embedded JSON). No /api calls, no auth, no publish.
    //
    // Both routes return:
    //   1. A leading agent-readable banner (HTML comment) listing every
    //      comment + reply + reaction grouped by anchor.
    //   2. A <script type="application/json" id="tdoc-fork-comments"> block
    //      with the full comments JSON (so agents can parse it reliably).
    //   3. Inline <!--TDOC-COMMENT id--> markers wrapped around each comment's
    //      anchor text so agents can locate the right region for "apply this
    //      comment" requests.
    const exportMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/(export|fork)\/?$/);
    if (exportMatch && method === 'GET') {
      const [, slug, vStr, kind] = exportMatch;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/index.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr}`, { status: 404 });
      let html = await obj.text();

      const rawList = await readComments(env, slug);
      ensureMigrated(rawList);
      // Snapshot the comments AS OF this exported version, then keep the
      // ones that are still actionable (not deleted, not resolved).
      const comments = snapshotList(rawList, Number(vStr));
      const openComments = comments.filter(c => c.status !== 'resolved');

      // 1. Build the agent-readable banner.
      const reactionsText = (rs) => {
        if (!rs) return '';
        const parts = Object.entries(rs).filter(([, u]) => u && u.length > 0)
          .map(([e, u]) => `${forHtmlComment(e)} (${u.length})`); // escape: a reaction value like '-->' must not break out of the HTML comment
        return parts.length ? `    reactions: ${parts.join(', ')}\n` : '';
      };
      let banner = `<!--
  ===== tdoc fork export =====
  slug: ${forHtmlComment(slug)}
  version: ${forHtmlComment(vStr)}
  exported: ${new Date().toISOString()}

  ## How to use this file
  Save it as ~/tdocs/<your-new-slug>/v1/index.html (or anywhere you like).
  Comments below are read-only metadata bundled with the fork. Agents can
  read them to apply changes — say "apply all comments to this doc" and the
  agent will find the anchored regions (marked with TDOC-COMMENT html
  comments inline below) and modify them accordingly.

  ## Comments included in this export
  ${openComments.length} comment(s).
`;
      for (let i = 0; i < openComments.length; i++) {
        const c = openComments[i];
        const who = c.author?.login ? `@${forHtmlComment(c.author.login)}` : 'anonymous';
        const anchor = c.anchor?.kind === 'element'
          ? `(on ${forHtmlComment(c.anchor.label || c.anchor.selector || 'element')})`
          : c.anchor?.text ? `(on text: "${forHtmlComment(c.anchor.text.replace(/"/g, '\\"').slice(0, 120))}")` : '(no anchor)';
        banner += `\n  [${i + 1}] ${who} ${anchor}\n    "${forHtmlComment(c.text.replace(/\n/g, ' '))}"\n${reactionsText(c.reactions)}`;
        if (Array.isArray(c.replies)) {
          for (const r of c.replies) {
            const rWho = r.author?.login ? `@${forHtmlComment(r.author.login)}` : 'anonymous';
            banner += `      ↳ ${rWho}: "${forHtmlComment(r.text.replace(/\n/g, ' '))}"\n${reactionsText(r.reactions).replace(/^/gm, '  ')}`;
          }
        }
      }
      banner += `\n  ===== end tdoc fork export =====\n-->\n`;

      // 2. Embed structured JSON for programmatic parsing.
      const jsonBlock = `<script type="application/json" id="tdoc-fork-comments">${
        safeJsonForScript({ slug, version: Number(vStr), exported: new Date().toISOString(), comments: openComments })
      }</script>\n`;

      // 3. Inline TDOC-COMMENT markers around anchored text. Done with simple
      //    text replacement; if the same text appears multiple times, we mark
      //    only the first occurrence (matches the live anchor behavior).
      for (const c of openComments) {
        if (c.anchor?.kind !== 'text' && !c.anchor?.text) continue;
        const needle = c.anchor.text;
        if (!needle || needle.length < 2) continue;
        const idx = html.indexOf(needle);
        if (idx === -1) continue;
        const replacement = `<!--TDOC-COMMENT id="${forHtmlComment(c.id)}" by="${forHtmlComment(c.author?.login || 'anonymous')}"-->${needle}<!--/TDOC-COMMENT-->`;
        html = html.slice(0, idx) + replacement + html.slice(idx + needle.length);
      }

      // The fork route boots the overlay in read-only "fork" mode so the
      // user can SEE what they just downloaded — comments rendered as cards,
      // anchors highlighted — without any backend.
      let bodyHtml = html;
      if (kind === 'fork') {
        bodyHtml = injectOverlayCfg(bodyHtml, {
          slug, version: Number(vStr), identity: null,
          authConfigured: false, mode: 'fork', originalSlug: slug,
        });
      }

      const finalHtml = banner + jsonBlock + bodyHtml;
      const dl = url.searchParams.get('download');
      // /export defaults to attachment; /fork defaults to inline. Either can be
      // overridden with ?download=1 / ?download=0.
      const defaultAttach = kind === 'export';
      const forceDownload = dl === '1' || (defaultAttach && dl !== '0');
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (forceDownload) headers['Content-Disposition'] = `attachment; filename="${slug}-v${vStr}-fork.html"`;
      return new Response(finalHtml, { status: 200, headers });
    }

    // ---- auth ----
    if (p === '/api/auth/me' && method === 'GET') {
      const s = await getSession(env, req);
      return json({
        identity: s ? { login: s.login, avatar_url: s.avatar_url, name: s.name } : null,
        isOwner: isOwnerSession(env, s),
        authConfigured: true,
      });
    }

    if (p === '/api/auth/device/start' && method === 'POST') {
      try {
        const r = await ghPost('/login/device/code', {
          client_id: env.GITHUB_CLIENT_ID,
          scope: 'read:user',
        });
        if (r.error) return json({ error: r.error, message: r.error_description }, { status: 400 });
        return json({
          device_code: r.device_code,
          user_code: r.user_code,
          verification_uri: r.verification_uri,
          expires_in: r.expires_in,
          interval: r.interval,
        });
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    if (p === '/api/auth/device/poll' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      if (!body.device_code) return json({ error: 'device_code required' }, { status: 400 });
      try {
        const r = await ghPost('/login/oauth/access_token', {
          client_id: env.GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        // Log the response shape (visible in `wrangler tail`) so we can debug
        // the post-approval path that's been hanging on "Waiting…".
        debug(env, '[poll] gh response keys:', Object.keys(r).join(','), 'error:', r.error || 'none', 'has_token:', !!r.access_token);
        // GitHub returns errors *with* a 200 status. Pending states must keep
        // polling; everything else is a real failure surfaced to the user.
        if (r.error === 'authorization_pending' || r.error === 'slow_down') {
          // Pass GitHub's suggested interval back to the client so it can
          // back off when slow_down is signaled (RFC 8628 §3.5).
          return json({ pending: true, error: r.error, interval: Number(r.interval) || null });
        }
        if (r.error) {
          return json({ error: r.error, message: r.error_description || r.error }, { status: 400 });
        }
        if (!r.access_token) return json({ pending: true });
        debug(env, '[poll] got access_token, fetching /user');
        const user = await ghUser(r.access_token);
        debug(env, '[poll] gh /user response keys:', Object.keys(user).join(','), 'login:', user.login || 'none');
        if (!user.login) return json({ error: 'no_user', message: user.message || 'GitHub /user returned no login' }, { status: 500 });
        const sid = rand(24);
        // Store only the identity we actually use. The GitHub access token is
        // intentionally NOT persisted: nothing downstream reads session.token,
        // and keeping a read:user token at rest for 30 days is needless
        // exposure (data minimization).
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
        };
        // 30 day TTL
        await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
        return json(
          { ok: true, identity: { login: user.login, avatar_url: user.avatar_url, name: user.name || user.login } },
          { headers: { 'Set-Cookie': `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}` } }
        );
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      const sid = parseCookie(req);
      if (sid) await env.META.delete(`session:${sid}`);
      return json({ ok: true }, { headers: { 'Set-Cookie': 'tdoc_sid=; Path=/; Max-Age=0' } });
    }

    // ---- comments ----
    if (p === '/api/comments' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      // Read from the DO (source of truth; it lazily migrates from KV on first
      // touch). Migrate-in-memory for this response only — never persist from a
      // read (writes go through the DO).
      const list = await readComments(env, slug);
      ensureMigrated(list);
      const V = parseVersionParam(url);
      // `?version=all` returns every comment across all versions (lossless,
      // used by tdoc-pull). A numeric/absent version returns that version's
      // snapshot (used by the overlay viewing a specific /v/<n>).
      return json(V === 'all' ? historyList(list) : snapshotList(list, V));
    }

    if (p === '/api/comments' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, version, anchor, text: commentText, parent_id } = body;
      if (!slug || !commentText) return json({ error: 'slug and text required' }, { status: 400 });
      const author = { login: s.login, avatar_url: s.avatar_url, name: s.name };
      const created = new Date().toISOString();
      const V = Number(version) || 1;
      // Serialized through the per-slug DO (mutation logic lives once in
      // applyCommentOp). create + reply are both id-stamped here so the
      // response is deterministic regardless of where the write runs.
      const op = parent_id
        ? { kind: 'reply', slug, parent_id, reply_id: `r_${Date.now()}_${rand(4)}`, author, text: commentText, version: V, at: created }
        : { kind: 'create', slug, id: `c_${Date.now()}_${rand(4)}`, author, text: commentText, anchor: anchor || null, version: V, at: created };
      const res = await mutateComments(env, slug, op);
      return json(res.body, { status: res.status });
    }

    // Re-anchor a comment. Only the original author can re-anchor their own
    // comment. Appends an `anchor_changed` event stamped at the current
    // version, so OLDER versions still resolve to the previous anchor.
    if (p === '/api/comments' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, id, anchor, version } = body;
      if (!slug || !id || !anchor) return json({ error: 'slug, id, anchor required' }, { status: 400 });
      // Auth read (canMutate needs session+env): resolve the target up front.
      // The serialized write then runs through the DO. A target deleted between
      // this check and the write is harmless — applyCommentOp returns 404.
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      const target = authList.find(c => c.id === id);
      if (!target) return json({ error: 'not_found' }, { status: 404 });
      if (!canMutate(target, s, env)) return json({ error: 'not_author' }, { status: 403 });
      const V = Number(version) || target.created_in || 1;
      const res = await mutateComments(env, slug, {
        kind: 'patch_anchor', slug, id, anchor, reset_status: true, version: V, actor: { login: s.login },
      });
      return json(res.body, { status: res.status });
    }

    // Admin: wipe ALL comments for a slug (doc owner only — uses the same
    // upload token as /api/upload, so it can be invoked from the publish
    // tooling or an agent that holds the token; the worker's KV is single-
    // tenant so this is safe). Triggered by ?all=1 on DELETE /api/comments.
    if (p === '/api/comments' && method === 'DELETE'
        && url.searchParams.get('all') === '1') {
      const unauth = requireUploadAuth(req, env);
      if (unauth) return unauth;
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      // Serialized wipe (through the DO) so it can't race a concurrent mutation.
      const res = await mutateComments(env, slug, { kind: 'wipe', slug });
      return json(res.body, { status: res.status });
    }
    // Soft-delete: append a `deleted` event at the current version. The
    // record is preserved; older versions still see the comment as it was.
    // Author-only. ?version=N to stamp the delete at a specific version
    // (defaults to Infinity, meaning "delete forward from now" which the
    // overlay supplies as the current view's version).
    if (p === '/api/comments' && method === 'DELETE') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const slug = url.searchParams.get('slug');
      const id = url.searchParams.get('id');
      if (!slug || !id) return json({ error: 'slug and id required' }, { status: 400 });
      const V = parseVersionParam(url);
      const stampVersion = Number.isFinite(V) ? V : 999999;  // "forever" if unspecified
      // Auth read up front (canMutate needs session+env): find the target
      // (top-level OR reply) and verify the actor can delete it. The serialized
      // soft-delete write then runs through the DO; a target removed in between
      // is harmless (applyCommentOp returns 404).
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      let authorized = false;
      const top = authList.find(c => c.id === id);
      if (top) {
        if (!canMutate(top, s, env)) return json({ error: 'not_author' }, { status: 403 });
        authorized = true;
      } else {
        for (const c of authList) {
          ensureEventLog(c);
          const reply = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
          if (reply) {
            if (!canMutate(reply.reply, s, env)) return json({ error: 'not_author' }, { status: 403 });
            authorized = true;
            break;
          }
        }
      }
      if (!authorized) return json({ error: 'not_found' }, { status: 404 });
      const res = await mutateComments(env, slug, {
        kind: 'delete', slug, id, version: stampVersion, actor: { login: s.login },
      });
      return json(res.body, { status: res.status });
    }

    // ---- reactions: toggle emoji on a comment OR reply ----
    // Versioned: appends reaction_added or reaction_removed at the current
    // view's version. ?version=N (or body.version) tags the event so older
    // versions don't see the reaction.
    if (p === '/api/reactions' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, comment_id, emoji, version } = body;
      if (!slug || !comment_id || !emoji) return json({ error: 'slug, comment_id, emoji required' }, { status: 400 });
      if (emoji.length > 8 || emoji.length === 0) return json({ error: 'invalid_emoji' }, { status: 400 });
      const V = Number(version) || 1;
      // No upstream read: the toggle (add vs remove) is decided inside the
      // serialized write so concurrent toggles can't both add. Any signed-in
      // user may react, so there's no author check to do here.
      const res = await mutateComments(env, slug, {
        kind: 'react', slug, comment_id, emoji, by: s.login, version: V,
      });
      return json(res.body, { status: res.status });
    }

    // ---- agent reply (from `tdoc edit` after applying a comment) ----
    // Authenticated with the same upload token as /api/upload — only the doc
    // owner's machine has it, so this can't be spoofed by readers. Posts a
    // reply on the parent comment, attributed to the `lucius-agent` identity.
    // status values: 'applied', 'partial', 'question'. The status appears as
    // a visible badge on the reply and also flips the parent comment's
    // status to 'applied' / 'open' so the dashboard reflects it.
    if (p === '/api/agent/reply' && method === 'POST') {
      const unauth = requireUploadAuth(req, env);
      if (unauth) return unauth;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, parent_id, text: replyText, status: agentStatus, applied_in,
              bind_anchor_aid } = body;
      if (!slug || !parent_id || !replyText) return json({ error: 'slug, parent_id, text required' }, { status: 400 });
      // Resolve parent + its current anchor up front (the optional rebind needs
      // the folded anchor for label/fallback). agent/reply is upload-token-authed
      // (owner-only), so concurrency here is negligible; the serialized write
      // still funnels through the DO so it can't clobber a concurrent user write.
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      const parent = authList.find(c => c.id === parent_id);
      if (!parent) return json({ error: 'parent_not_found' }, { status: 404 });

      const verdict = ['applied', 'partial', 'question'].includes(agentStatus) ? agentStatus : null;
      const V = Number(applied_in) || parent.created_in || 1;
      const now = new Date().toISOString();
      const replyId = `r_${Date.now()}_${rand(4)}`;

      const events = [{
        kind: 'reply_added', at_version: V, at: now,
        reply: { id: replyId, author: { kind: 'agent', login: 'lucius-agent', name: 'lucius-agent', avatar_url: null }, text: replyText, agent_status: verdict },
      }];
      if (verdict === 'applied') {
        events.push({ kind: 'marked_applied', at_version: V, at: now, applied_in: V, by: 'lucius-agent', agent_status: 'applied' });
      } else if (verdict === 'partial' || verdict === 'question') {
        events.push({ kind: 'marked_open', at_version: V, at: now, by: 'lucius-agent', agent_status: verdict });
      }
      if (bind_anchor_aid && typeof bind_anchor_aid === 'string') {
        const cur = snapshotAt(parent, V) || {};
        const fallback = cur.anchor?.fallback;
        const label = cur.anchor?.label || 'svg';
        events.push({
          kind: 'anchor_changed', at_version: V, at: now, by: 'lucius-agent', reset_status: false,
          anchor: { kind: 'element', aid: bind_anchor_aid, selector: `[data-tdoc-aid="${bind_anchor_aid}"]`, label, ...(fallback ? { fallback } : {}) },
        });
      }
      const res = await mutateComments(env, slug, {
        kind: 'raw_events', slug, id: parent_id, events,
        responseBody: { id: replyId, parent_id, text: replyText, author: { kind: 'agent', login: 'lucius-agent', name: 'lucius-agent', avatar_url: null }, agent_status: verdict, created: now, reactions: {} },
      });
      return json(res.body, { status: res.status });
    }

    // ---- admin upload (from `tdoc publish`) ----
    if (p === '/api/upload' && method === 'POST') {
      const unauth = requireUploadAuth(req, env);
      if (unauth) return unauth;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, version, html: doc, meta, comments: localComments } = body;
      if (!slug || !version || !doc) return json({ error: 'slug, version, html required' }, { status: 400 });
      // html must be a string — a non-string doc would throw inside stampAids()
      // and surface as a generic 500 (Codex P3).
      if (typeof doc !== 'string') return json({ error: 'html must be a string' }, { status: 400 });
      // Identity-stamp every commentable artifact with a content-hashed
      // data-tdoc-aid. The SAME artifact in a different version has the
      // SAME aid — so a comment anchored by aid resolves identity-first
      // and cannot drift onto a different artifact.
      const { html: stampedHtml, aids } = stampAids(doc);
      const r2Key = `docs/${slug}/v${version}/index.html`;
      try {
        await env.DOCS.put(r2Key, stampedHtml, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
      } catch (e) {
        console.error('[upload] R2 put failed:', e.message);
        return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
      }
      // Verify the write actually landed before we tell the caller "ok".
      // The previous handler returned ok: true even when the binding was
      // silently dropping writes — leaving us with KV meta but no R2 doc.
      const verify = await env.DOCS.head(r2Key);
      if (!verify) {
        console.error('[upload] R2 write did not persist:', r2Key);
        return json({ error: 'r2_write_lost', message: 'PUT succeeded but the key is not readable. Re-deploy the worker; the R2 binding may be stale.' }, { status: 500 });
      }
      if (meta) await env.META.put(`meta:${slug}`, JSON.stringify(meta));
      // Reconcile existing open comments against the new artifact set:
      // bind by aid where possible; mark lost where the artifact is gone
      // or ambiguous. This is the ENFORCED publish-time invariant — no
      // agent honesty required, no silent re-anchoring to wrong artifacts.
      let mergedLocal = 0;
      try {
        // #24 dry-run (read-only logging): measure how many live comments anchor
        // to an aid the hardened parser changes vs the legacy parser. >0 on a
        // real doc → that doc needs the aid migration in docs/DESIGN-aid-
        // migration.md. Reads its own copy, never mutates. Empirically 0.
        try {
          const drift = measureAidDrift(doc, await readComments(env, slug));
          if (drift.affectedComments > 0) {
            console.warn(`[aid-drift] slug=${slug} v=${version} changedAids=${drift.changed} affectedComments=${drift.affectedComments} samples=${JSON.stringify(drift.samples)} — these anchors will rebind via reconcile; see docs/DESIGN-aid-migration.md`);
          } else {
            console.log(`[aid-drift] slug=${slug} v=${version} changedAids=${drift.changed} affectedComments=0 (safe)`);
          }
        } catch (e) {
          console.error('[aid-drift] measurement failed (non-fatal):', e.message);
        }

        // Serialized merge + reconcile + compact through the per-slug DO. The
        // merge is non-destructive (add-by-id-if-absent; never overwrite/delete
        // worker comments), mirroring tdoc-pull so round-trips converge.
        const res = await mutateComments(env, slug, {
          kind: 'publish_merge', slug, localComments: localComments || [], aids, version,
        });
        mergedLocal = (res.body && res.body.mergedComments) || 0;
      } catch (e) {
        console.error('[upload] comment merge/reconcile failed (non-fatal):', e.message);
      }
      return json({ ok: true, url: `/d/${slug}/v/${version}`, size: verify.size, aids: aids.length, mergedComments: mergedLocal });
    }

    // ---- admin delete ----
    if (p === '/api/doc' && method === 'DELETE') {
      const unauth = requireUploadAuth(req, env);
      if (unauth) return unauth;
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      // delete all R2 versions
      let cursor;
      do {
        const r = await env.DOCS.list({ prefix: `docs/${slug}/`, cursor });
        for (const o of r.objects) await env.DOCS.delete(o.key);
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      await env.META.delete(`meta:${slug}`);
      // Wipe comments through the DO (the canonical store), not just the KV
      // mirror (Codex P1: deleting only KV left DO storage populated, so
      // delete-then-recreate resurrected old comments). The wipe op clears
      // state.storage; the legacy KV value is removed too as cleanup.
      await mutateComments(env, slug, { kind: 'wipe' });
      await env.META.delete(`comments:${slug}`);
      return json({ ok: true });
    }

    return text('Not found', { status: 404 });
  },
};
