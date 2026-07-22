# lucius

**The canvas your AI pair draws on.** lucius is a desktop app where Claude Code
(or any agent) publishes rich, self-contained HTML one-pagers — architecture
diagrams, product briefs, interactive explainers, brainstorm artifacts — while
you steer by voice or chat. Every push is an immutable version. Scrub the
history, point at any element, publish to the web, and collect comments from
your team.

Built live, by pairing with Claude, in one day — and designed so the pairing
loop is the product.

## What it does

- **A canvas driven by your agent.** Claude renders complete HTML/CSS/JS/SVG
  documents into the app over a local API — interactive diagrams with
  click-to-inspect, animated data flows, tdoc-style card explainers.
- **Versions, not edits.** Every iteration is an immutable snapshot in SQLite.
  The left rail is a timeline; "go live" snaps back to the latest.
- **Projects as tabs.** Independent workspaces (own versions, own comments) —
  one per topic, one per brainstorm.
- **Point at things.** Select mode: click any element in the artifact and the
  agent can read exactly what you're pointing at (CSS selector + text) and
  drop comments anchored to it.
- **Publish & collect comments.** One click publishes all versions of a
  project to *your own* Cloudflare Worker + R2 (free tier). Viewers sign in
  with GitHub, highlight text or any diagram, and comment; comments flow back
  into the app automatically.
- **MCP + CLI + skill.** The app embeds an MCP server (`http://127.0.0.1:7317/mcp`)
  with tools for render/comment/selection/focus, a `lucius` CLI, and a Claude
  Code skill that encodes the artifact quality bar (truth rules, motion,
  document/canvas modes).

## Install

**End users (macOS):**

```bash
curl -fsSL https://raw.githubusercontent.com/berkantay/lucius/main/install.sh | sh
```

Installs the app to /Applications, the Claude Code skill + CLI, and the MCP
registration. Then open lucius and tell Claude Code to draw.

**From source — let your coding agent do it.** Tell Claude Code (or
any agent): *"clone github.com/berkantay/lucius and follow SETUP.md"*. The
repo ships an agent runbook ([SETUP.md](SETUP.md)) plus `scripts/doctor`
(machine-readable setup state), and `scripts/verify` (proves the loop by
rendering the example artifact into a welcome session).

### Manual (dev)

Prereqs: Rust, Node 20+, `jq`.

```bash
git clone https://github.com/berkantay/lucius && cd lucius
npm install
npm run tauri dev
```

The app writes `~/Library/Application Support/ai.glorya.lucius/server.json`
(`{port, token}`) on every launch — the CLI and skill read it automatically.

### Claude Code integration

```bash
# skill + CLI
ln -s "$PWD/skill" ~/.claude/skills/lucius

# MCP (fixed port)
claude mcp add --transport http --scope user lucius http://127.0.0.1:7317/mcp
```

Then, in any Claude Code session: *"put a one-pager about X on the canvas"*.

### Publishing (optional, your own Cloudflare)

```bash
./skill/lucius setup   # one-time: wrangler login, R2 bucket, KV, worker deploy
```

Gives you `https://lucius.<your-subdomain>.workers.dev`; the in-app **Publish**
button does the rest. Config lives in `~/.lucius/published.json`.

## Architecture

```
Claude Code ──(CLI / MCP, bearer token)──▶ control server (Rust, tiny_http)
                                              │  SQLite: projects · versions · comments
                                              │  Tauri events
                                              ▼
                                   app shell (React + Fluid Functionalism)
                                   tabs · version rail · sandboxed iframe canvas
                                              │ select-mode postMessage
                                              ▼
                                   publish ──▶ your Cloudflare Worker + R2
                                              ◀── comment poller (60s)
```

- `src-tauri/` — Rust: store (rusqlite), control server + MCP, publish, poller
- `src/` — React shell on [Fluid Functionalism](https://www.fluidfunctionalism.com) components
- `skill/` — Claude Code skill (SKILL.md) + `lucius` CLI
- `worker/` — the publish/comments worker (vendored from
  [tdoc](https://github.com/serenakeyitan/tdoc), MIT — see `worker/ATTRIBUTION.md`)

### Members & invites

Published docs default to link-visibility. Make one private and invite people
by GitHub username — from the Publish dialog's share section, or:

```bash
./skill/lucius -p myproject share --private --add teammate
```

Uninvited visitors get a branded sign-in gate; invited logins pass straight
through after GitHub sign-in. The agent can also reply to web comments with
status (`lucius reply <comment-id> "done" applied`).

## Roadmap

- **Comment surfaces in-app** — anchored margin comments over the canvas
  (they're already stored + selector-anchored; the UI was deliberately cut
  until it earns its place).
- **A Claude per tab** — spawn a dedicated Claude Code session pinned to a
  project, Orca-style.
- **Packaged builds** — signed .dmg via `tauri build`.
- Own GitHub OAuth app for viewer sign-in (currently tdoc's shared client id).

## License

MIT — see [LICENSE](LICENSE). Worker bundle vendored from tdoc (MIT).
