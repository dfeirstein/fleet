#!/usr/bin/env bash
# fleet installer — one command, then always current with main automatically.
#
#   curl -fsSL https://raw.githubusercontent.com/dfeirstein/fleet/main/install.sh | bash
#
# Idempotent and safe to re-run: fresh installs clone to ~/.local/share/fleet,
# existing ones fast-forward pull. Then it symlinks `fleet` onto PATH + the skill
# into ~/.claude, and runs `fleet doctor`. After this, `bin/fleet` keeps itself
# current (once/24h on clean main; FLEET_NO_AUTOUPDATE=1 opts out).
#
# Test hooks (no network, throwaway HOME):
#   HOME=$(mktemp -d) FLEET_REPO="file://$PWD" bash install.sh
set -euo pipefail

REPO="${FLEET_REPO:-https://github.com/dfeirstein/fleet.git}"
BRANCH="${FLEET_BRANCH:-main}"
DEST="${FLEET_INSTALL_DIR:-$HOME/.local/share/fleet}"
SKILL_LINK="$HOME/.claude/skills/fleet"

echo "── fleet installer ──"

# ── Prereqs ─────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || { echo "✗ git not found — install git and re-run."; exit 1; }

command -v node >/dev/null 2>&1 || { echo "✗ Node not found — install Node 20+."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then echo "✗ Node $NODE_MAJOR is too old — need 20+."; exit 1; fi
echo "✓ Node $(node -v)"

command -v npm >/dev/null 2>&1 || { echo "✗ npm not found — install npm (ships with Node)."; exit 1; }

if [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ] || command -v cmux >/dev/null 2>&1; then
  echo "✓ cmux found"
else
  echo "⚠ cmux not found — install the cmux app from https://cmux.com (fleet drives it)."
fi
command -v claude >/dev/null 2>&1 || echo "⚠ claude (Claude Code) not found — install it and log into your Pro/Max/Team plan."

# ── Clone (fresh) or fast-forward pull (existing) ───────────────────────────
if [ -d "$DEST/.git" ]; then
  echo "→ existing install at $DEST — fast-forward pull"
  git -C "$DEST" fetch --quiet origin "$BRANCH" || echo "⚠ fetch failed (offline?) — using existing code"
  git -C "$DEST" checkout --quiet "$BRANCH" 2>/dev/null || true
  git -C "$DEST" pull --ff-only --quiet origin "$BRANCH" 2>/dev/null || echo "⚠ could not fast-forward (local changes?) — leaving checkout as-is"
else
  echo "→ cloning fleet → $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DEST"
fi

# ── Deps (no build step — TS runs via tsx) ──────────────────────────────────
echo "→ npm ci"
( cd "$DEST" && npm ci --silent ) || ( cd "$DEST" && npm install --no-audit --no-fund --silent )

# ── Back up a pre-existing REAL skill dir before symlinking over it ──────────
# (a correct symlink is left as-is; a real dir is preserved to a timestamped .bak
#  so re-running never silently destroys a hand-edited skill.)
if [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  BAK="$SKILL_LINK.$(date +%Y%m%d-%H%M%S).bak"
  mv "$SKILL_LINK" "$BAK"
  echo "→ backed up existing skill dir → $BAK"
fi

# ── Link fleet onto PATH + install the skill (idempotent; see src/commands/setup.ts) ──
chmod +x "$DEST/bin/fleet"
echo "→ linking fleet + skill"
FLEET_NO_AUTOUPDATE=1 "$DEST/bin/fleet" setup

echo
echo "── health check ──"
FLEET_NO_AUTOUPDATE=1 "$DEST/bin/fleet" doctor || true

echo
echo "── done ──"
echo "Start:   fleet captain <name>      (e.g. fleet captain Mario)"
echo "Update:  fleet update              (also auto-updates once/24h on clean main)"
echo "(If 'fleet' isn't found, add ~/.local/bin to your PATH and reopen your shell.)"
