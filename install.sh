#!/usr/bin/env bash
# fleet installer — clone this repo, then run ./install.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "── fleet installer ──"

# Prereqs
command -v node >/dev/null 2>&1 || { echo "✗ Node not found. Install Node 18+ (20+ recommended)."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "✗ Node $NODE_MAJOR is too old — need 18+."; exit 1; fi
echo "✓ Node $(node -v)"

command -v git >/dev/null 2>&1 || { echo "✗ git not found."; exit 1; }

if [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ] || command -v cmux >/dev/null 2>&1; then
  echo "✓ cmux found"
else
  echo "⚠ cmux not found — install the cmux app from https://cmux.com (fleet drives it)."
fi

# Deps (no build step — we run TypeScript via tsx)
echo "→ npm install"
npm install --no-audit --no-fund --silent

# Put fleet on PATH + install the skill
chmod +x bin/fleet
echo "→ linking fleet + skill"
./bin/fleet setup

echo
echo "── done ──"
echo "Verify:  fleet doctor"
echo "Start:   fleet orchestrate <name>      (e.g. fleet orchestrate Mario)"
echo "(If 'fleet' isn't found, add ~/.local/bin to your PATH and reopen your shell.)"
