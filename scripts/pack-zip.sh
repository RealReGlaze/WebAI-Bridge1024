#!/usr/bin/env bash
# Build the distributable zip for end users:  bash scripts/pack-zip.sh
# Excludes node_modules/.runtime/.git/dist - users get them via `npm install` in setup.sh.
set -euo pipefail

# Get project root directory
# Use pwd -W (MSYS/Cygwin) to hand Node.js a Windows-style path (E:/...), because
# Node.js treats a leading "/e/..." as a POSIX absolute path and cannot find the file.
if root_win="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -W 2>/dev/null)"; then
  root="$root_win"
else
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

if [ ! -f "$root/package.json" ]; then
  echo "[pack] ERROR: package.json not found at: $root/package.json" >&2
  echo "[pack] Please run this script from the project root or scripts directory." >&2
  exit 1
fi

ver="$(node -p "require('$root/package.json').version")"
name="webai-bridge-$ver"

mkdir -p "$root/dist"
rm -f "$root/dist/$name.zip"

cd "$root"
if ! command -v zip >/dev/null 2>&1; then
  # Fallback for Windows / Git Bash: bsdtar (ships with Windows 10+, at
  # C:\Windows\System32\tar.exe) can write zip archives via `tar -a -cf x.zip` and
  # stores entry names with '/', unlike PowerShell 5.1's Compress-Archive.
  # Git Bash's own /usr/bin/tar shadows it on PATH, so call the system one directly.
  bsdtar=""
  for c in "$(cygpath -u 'C:\Windows\System32\tar.exe' 2>/dev/null || echo '')" \
           "$(command -v bsdtar 2>/dev/null || true)" \
           "$(command -v tar 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" --version 2>/dev/null | grep -qi bsdtar; then
      bsdtar="$c"; break
    fi
  done
  if [ -z "$bsdtar" ]; then
    echo "[pack] 'zip' not found. Install it first (e.g. apt install zip / brew install zip), or run this on Windows where bsdtar is available." >&2
    exit 1
  fi
  "$bsdtar" -a -cf "dist/$name.zip" \
    --exclude node_modules \
    --exclude .runtime \
    --exclude .git \
    --exclude dist \
    . || { echo "[pack] bsdtar failed" >&2; exit 1; }
  echo "Created: $root/dist/$name.zip"
  exit 0
fi

zip -r "dist/$name.zip" . \
  -x "node_modules/*" \
  -x ".runtime/*" \
  -x ".git/*" \
  -x "dist/*" \
  -x "*.DS_Store" \
  -x "dist/$name.zip"

echo "Created: $root/dist/$name.zip"
