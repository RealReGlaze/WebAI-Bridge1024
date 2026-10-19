#!/usr/bin/env bash
# WebAI Bridge - uninstall for macOS / Linux:
# removes the ~/.local/bin/webai symlink and shell profile entries.
# Does NOT delete any files; delete the install folder manually if desired.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Removing WebAI Bridge environment entries..."

if [ -L "$HOME/.local/bin/webai" ]; then
  rm -f "$HOME/.local/bin/webai"
  echo "      Removed: $HOME/.local/bin/webai"
else
  echo "      Symlink not found (already clean): $HOME/.local/bin/webai"
fi

MARK_BEGIN='# >>> webai-bridge >>>'
MARK_END='# <<< webai-bridge <<<'

strip_block() {
  [ -f "$1" ] || return 0
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 ~ b { skip = 1; next }
    $0 ~ e { skip = 0; next }
    !skip' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
  echo "      Cleaned: $1"
}

for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$f" ] && grep -q "webai-bridge" "$f"; then
    strip_block "$f"
  fi
done

echo
echo "Done. The install folder was NOT deleted:"
echo "  $ROOT"
echo "You may delete it manually. Note: browser login profiles live in"
echo "  $ROOT/.runtime/"
echo "and contain no credentials - deleting them just logs you out of the web AIs."
