---
name: lucius-setup
description: Guided setup, repair, publishing, sharing and updates for the lucius canvas app. Use when the user says "set up lucius", "install lucius", "lucius isn't working", "fix lucius", "publish my lucius doc", "share / invite someone", "update lucius", or "uninstall lucius". Drives scripts/doctor and never reports success without verification.
---

# lucius setup operator

You are guiding a human through installing, repairing, publishing, sharing,
or updating lucius. Everything is script-driven and verifiable — never
assume a step worked; check.

## Locate the install first

The lucius source root (scripts + skill + worker) is, in order of likelihood:
1. `~/.lucius/src` — installed via the one-line installer
2. the current directory, if it's a lucius git clone (has `scripts/doctor`)

Set `ROOT` accordingly. The CLI is `$ROOT/skill/lucius` (also symlinked at
`~/.claude/skills/lucius/lucius`). If neither exists, this is a fresh
machine → "First-time install" below.

## The one loop that rules everything

```bash
"$ROOT/scripts/doctor"        # JSON: deps, app_running, skill/mcp/publish, missing_steps[]
```

Run it, execute `missing_steps` in order, re-run after every step:
- `kind: install` — run the cmd yourself.
- `kind: run` — long-runner. Installed app: `open /Applications/lucius.app`.
  Source checkout: `npm run tauri dev` in the background (first build takes
  minutes). Either way, poll `curl -s http://127.0.0.1:7317/api/ping` until
  it answers before continuing.
- `kind: optional` (publish) — only if the user wants sharing; see below.
- `kind: check` — Linux prerequisites; install what's missing.

Finish with `"$ROOT/scripts/verify"` — it renders the example artifact into
a `welcome` session. Success is `VERIFY_OK` **and the user confirming they
see "how lucius works" in the app**. `VERIFY_FAIL: <reason>` tells you what
to fix; loop until OK.

## First-time install (empty machine)

- macOS, fastest: `curl -fsSL https://raw.githubusercontent.com/berkantay/lucius/main/install.sh | sh`
  — installs the app, this skill, the canvas skill, and MCP. Then run the
  doctor loop above.
- Any OS, from source: `git clone https://github.com/berkantay/lucius && cd lucius`
  then follow the doctor loop (SETUP.md in the repo is the same algorithm).

## Publishing setup (Cloudflare — the user's own account)

Preconditions: `wrangler` (`npm i -g wrangler`) and a free Cloudflare account.

1. TELL THE USER FIRST: "this opens a browser to log in to Cloudflare" —
   then run `"$ROOT/skill/lucius" setup` and wait through the interactive
   login if needed.
2. It provisions THEIR worker (`lucius.<their-subdomain>.workers.dev`), R2
   bucket, KV, upload token → `~/.lucius/published.json`.
3. Verify: `"$ROOT/skill/lucius" -p welcome publish` prints a URL; curl it
   for HTTP 200. Tell the user the in-app cloud button now does the same.

## Sharing & invitations (walk the user through it)

The mental model to explain: **the app has no accounts. Invites gate the
published page; viewers sign in with GitHub there, not in the app.**

1. Publish the project (cloud button in the app, or CLI as above).
2. Make it invite-only: in the cloud dialog flip **Private** and add GitHub
   usernames — or `"$ROOT/skill/lucius" -p <project> share --private --add <username>`.
3. Send the URL. Tell the user what the invitee experiences: a lucius gate
   page → "Sign in with GitHub" → device code → doc opens if invited.
4. Comments made on the page flow back into the app within ~60s (badge in
   the header). The agent replies with
   `"$ROOT/skill/lucius" -p <project> reply <comment-id> "<what changed>" applied`.
5. Verify the gate actually gates: `curl -s <url>` (no cookies) must show
   "This doc is private" when private is on.

## Update lucius

- Installer-based (`~/.lucius/src`, no .git): re-run the installer one-liner —
  it replaces the app and source atomically; data (sessions DB) is untouched.
- Git clone: `git pull`, then `npm install && npm run tauri build` (or dev).
- After either: doctor loop → verify.

## Uninstall

`rm -rf /Applications/lucius.app ~/.claude/skills/lucius ~/.claude/skills/lucius-setup ~/.lucius`
plus `claude mcp remove --scope user lucius`. The data dir
(`~/Library/Application Support/ai.glorya.lucius` or
`~/.local/share/ai.glorya.lucius`) holds their sessions — ask before
deleting it. Their Cloudflare worker keeps published docs until they run
`wrangler delete lucius` themselves.

## Reporting style

End every run with: the final doctor JSON one-liner (ready / missing), what
you changed, and the one thing the user should see on screen right now.
Never say "should work" — say what you verified.
