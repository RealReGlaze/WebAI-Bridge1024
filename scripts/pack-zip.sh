#!/usr/bin/env bash
# Build the distributable zip for end users:  bash scripts/pack-zip.sh
# Excludes node_modules/.runtime/.git/dist - users get them via `npm install` in setup.sh.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ver="$(node -p "require('$root/package.json').version")"
name="webai-bridge-$ver"

mkdir -p "$root/dist"
rm -f "$root/dist/$name.zip"

cd "$root"
if ! command -v zip >/dev/null 2>&1; then
  echo "[pack] 'zip' not found. Install it first (e.g. apt install zip / brew install zip)." >&2
  exit 1
fi

zip -r "dist/$name.zip" . \
  -x "node_modules/*" \
  -x ".runtime/*" \
  -x ".git/*" \
  -x "dist/*" \
  -x "*.DS_Store" \
  -x "dist/$name.zip"

echo "Created: $root/dist/$name.zip"
