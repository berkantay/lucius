#!/bin/sh
# lucius installer — end users, no git required:
#   curl -fsSL https://raw.githubusercontent.com/berkantay/lucius/main/install.sh | sh
#
# Installs: the app (latest GitHub release) into /Applications, the Claude Code
# skill + CLI into ~/.claude/skills/lucius (backed by ~/.lucius/src so the
# publish worker ships too), and the MCP registration if the claude CLI exists.
set -eu

REPO="berkantay/lucius"
LUCIUS_HOME="$HOME/.lucius"

say() { printf '\033[1m[lucius]\033[0m %s\n' "$1"; }

if [ "$(uname)" != "Darwin" ]; then
  say "prebuilt bundles are macOS-only for now — on Linux, clone the repo and follow SETUP.md (your coding agent can do it: 'clone github.com/$REPO and follow SETUP.md')."
  exit 1
fi

# ---- 1 · the app -----------------------------------------------------------
say "looking up the latest release…"
DMG_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | grep -o 'https://[^"]*')"
if [ -z "$DMG_URL" ]; then
  say "no release bundle found — falling back to source setup: clone the repo and follow SETUP.md."
  exit 1
fi
say "downloading $(basename "$DMG_URL")…"
TMP_DMG="$(mktemp -t lucius).dmg"
curl -fsSL -o "$TMP_DMG" "$DMG_URL"
MNT="$(hdiutil attach "$TMP_DMG" -nobrowse | grep -o '/Volumes/.*' | head -1)"
[ -d "$MNT/lucius.app" ] || { say "unexpected dmg layout"; hdiutil detach "$MNT" -quiet || true; exit 1; }
rm -rf /Applications/lucius.app
cp -R "$MNT/lucius.app" /Applications/
hdiutil detach "$MNT" -quiet || true
rm -f "$TMP_DMG"
# unsigned build: clear quarantine so Gatekeeper allows launch
xattr -dr com.apple.quarantine /Applications/lucius.app 2>/dev/null || true
say "installed /Applications/lucius.app"

# ---- 2 · skill + CLI + worker source --------------------------------------
say "installing the Claude Code skill + CLI…"
mkdir -p "$LUCIUS_HOME"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$LUCIUS_HOME"
rm -rf "$LUCIUS_HOME/src"
mv "$LUCIUS_HOME/lucius-main" "$LUCIUS_HOME/src"
mkdir -p "$HOME/.claude/skills"
ln -sfn "$LUCIUS_HOME/src/skill" "$HOME/.claude/skills/lucius"
say "skill -> ~/.claude/skills/lucius (CLI: ~/.claude/skills/lucius/lucius)"

# ---- 3 · MCP ---------------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  claude mcp add --transport http --scope user lucius http://127.0.0.1:7317/mcp >/dev/null 2>&1 \
    && say "MCP server registered for Claude Code" \
    || say "MCP registration skipped (already present?)"
else
  say "claude CLI not found — later, run: claude mcp add --transport http --scope user lucius http://127.0.0.1:7317/mcp"
fi

say "done. Open the app:  open /Applications/lucius.app"
say "then tell Claude Code: 'put a one-pager about X on the lucius canvas'"
say "optional publishing/sharing: ~/.claude/skills/lucius/lucius setup"
