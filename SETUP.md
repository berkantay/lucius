# Setting up lucius

**If you are a coding agent** (Claude Code, Codex, or similar): this file is
your runbook. Follow the algorithm exactly; do not improvise the order.

**If you are a human**: paste this into your agent —
*"clone github.com/berkantay/lucius and follow SETUP.md"* — or run the
Quickstart at the bottom yourself.

## Agent algorithm

1. Run `scripts/doctor` and parse the JSON. It is non-destructive.
2. If `ready` is `true` and `missing_steps` is empty → run `scripts/verify`,
   confirm it prints `VERIFY_OK`, and report done.
3. Otherwise execute `missing_steps` **in order**. For each step:
   - `kind: "install"` — run the `cmd` yourself. Re-run `scripts/doctor`
     after it to confirm the state changed.
   - `kind: "run"` — long-running process. Start it **in the background**
     (`npm run tauri dev` builds Rust on first run: expect several minutes).
     Poll `curl -s http://127.0.0.1:7317/api/ping` until it answers
     `{"app":"lucius","ok":true}` before proceeding.
   - `kind: "optional"` — skip unless the user asked for publishing/sharing.
     `skill/lucius setup` opens a browser for Cloudflare login (`wrangler
     login`) — tell the user before running it, and wait for them if the
     login is interactive.
   - `kind: "check"` — verify the listed packages exist (Linux only); install
     what's missing, then continue.
4. After every step, re-run `scripts/doctor`. Never assume a step worked.
5. Finish with `scripts/verify`. It creates a `welcome` session and renders
   the example artifact — the user's app window should visibly show
   **"how lucius works"**. If it prints `VERIFY_FAIL: <reason>`, fix that
   reason and re-run; do not report success until `VERIFY_OK`.
6. Tell the user: the skill is installed (any Claude Code session can now
   `lucius render …`), the MCP server is registered (new sessions get lucius
   tools natively), and — before authoring any artifact — the skill requires
   reading `skill/design.md` (taste rules) and `skill/SKILL.md` (workflow +
   truth rules).

### Sanity contract

- Control server: `http://127.0.0.1:7317` (fixed; falls back to the port in
  the data dir's `server.json` if 7317 is taken). Bearer token in that same
  file; the CLI handles it — never cache tokens yourself.
- Data dir: `~/Library/Application Support/ai.glorya.lucius` (macOS) or
  `~/.local/share/ai.glorya.lucius` (Linux).
- MCP endpoint: `http://127.0.0.1:7317/mcp` (Streamable HTTP, no auth,
  loopback only).
- Everything the CLI can do: `skill/lucius` with no args prints usage.

## Human quickstart

```bash
git clone https://github.com/berkantay/lucius && cd lucius
npm install
npm run tauri dev          # first build takes a few minutes

# in another terminal:
ln -sfn "$PWD/skill" ~/.claude/skills/lucius
claude mcp add --transport http --scope user lucius http://127.0.0.1:7317/mcp
scripts/verify             # pushes the example artifact into a welcome session
```

Optional publishing/sharing (your own Cloudflare Worker + R2, free tier):

```bash
npm i -g wrangler
skill/lucius setup         # one-time: login, bucket, KV, worker deploy
```

Then in any Claude Code session: *"put a one-pager about X on the lucius canvas."*
