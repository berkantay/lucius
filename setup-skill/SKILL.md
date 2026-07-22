---
name: lucius-setup
description: The lucius onboarding journey — a guided first-run experience from empty machine to first artifact to published-and-shared, driven step by step by the user's coding agent. Use when the user says "onboard me", "set up lucius", "get started with lucius", "install lucius", or has just installed and doesn't know what to do next. Also handles repair ("lucius isn't working"), updates, and uninstall.
---

# lucius onboarding

You are running the user's first-run journey. It is a guided experience, not
a checklist dump: **one phase at a time, verify each, tell the user what they
should be seeing on screen before moving on.** The journey is re-entrant —
`scripts/doctor` always tells you which phase they're in, so "onboard me"
works whether they have nothing installed or are halfway through.

Locate the install root first: `~/.lucius/src` (installer) or the current
lucius clone (has `scripts/doctor`). Call it `ROOT`. CLI: `$ROOT/skill/lucius`.

## Phase 0 · Assess & greet

Run `"$ROOT/scripts/doctor"` (or note it's missing → truly fresh machine).
Read the JSON and tell the user where they stand in one sentence — e.g.
"you're two steps away from a working canvas" — then start at their phase.

## Phase 1 · Install & first launch

Fresh machine: macOS → `curl -fsSL https://raw.githubusercontent.com/berkantay/lucius/main/install.sh | sh`;
otherwise clone the repo and work from source.

Then drive doctor's `missing_steps` in order, re-running doctor after each:
- `install` steps: run the cmd yourself.
- `run` step: launch the app (`open /Applications/lucius.app`, or background
  `npm run tauri dev` from source — warn that the first build takes minutes).
  Poll `curl -s http://127.0.0.1:7317/api/ping` until it answers.
- Never assume; re-check.

## Phase 2 · The first-artifact moment

1. Run `"$ROOT/scripts/verify"` → must print `VERIFY_OK`. The app now shows a
   `welcome` session rendering "how lucius works".
2. Tell the user to look at the app window and confirm they see it. Point out
   the three things that matter: versions in the left rail, the crosshair
   (point at things), highlight-to-comment on any text.
3. **Make it theirs**: ask what they're working on right now — a system, a
   feature, an idea — then create a session for it and render a real one-pager
   about THEIR topic (read `$ROOT/skill/SKILL.md` and `$ROOT/skill/design.md`
   first; truth and taste rules apply even during onboarding). This is the
   aha moment — don't skip it, don't do a generic demo.

Core onboarding ends here. Ask if they want sharing; if not, jump to
Graduation.

## Phase 3 · Publishing (optional — their own Cloudflare)

1. Needs `wrangler` (`npm i -g wrangler`) and a free Cloudflare account.
2. WARN FIRST: "this opens a browser to log in to Cloudflare", then run
   `"$ROOT/skill/lucius" setup` and wait through the login with them.
3. Publish their topic session: `"$ROOT/skill/lucius" -p <project> publish` →
   send them the URL, confirm it loads (curl 200). Show them the in-app cloud
   button does the same.

## Phase 4 · Invite someone (optional)

Explain the model in one line first: **the app has no logins — invites gate
the published page, where viewers sign in with GitHub.**

1. `"$ROOT/skill/lucius" -p <project> share --private --add <github-username>`
   (or: cloud dialog → Private toggle → invite field).
2. Verify the gate: `curl -s <url>` must show "This doc is private".
3. Tell them what their invitee will experience: gate page → Sign in with
   GitHub → device code → doc opens. Comments made there flow back into the
   app within ~60s (header badge), and you can answer with
   `lucius reply <comment-id> "<what changed>" applied`.

## Phase 5 · Graduation

Close with exactly three things they should remember:
1. In any Claude Code session: *"put a one-pager about X on the lucius canvas"*.
2. Highlight any text on the canvas to comment; the crosshair points at things.
3. The cloud button publishes and invites.

Plus the final doctor one-liner as proof of the finished state.

## Appendix · repair / update / uninstall

- **Repair**: doctor loop until `ready: true`, then verify. Common: app not
  running (relaunch, poll ping), port 7317 taken (server.json in the data dir
  has the fallback port).
- **Update**: installer-based → re-run the install one-liner (data survives);
  git clone → `git pull && npm install`, rebuild. Then doctor + verify.
- **Uninstall**: remove `/Applications/lucius.app`, both skill symlinks,
  `~/.lucius`, and the MCP entry (`claude mcp remove --scope user lucius`).
  The data dir holds their sessions — ASK before deleting. Their Cloudflare
  worker keeps published docs until they run `wrangler delete lucius`.
