#!/usr/bin/env bash
# WebAI Bridge - one-click setup for macOS / Linux
# Usage: bash setup.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "============================================================"
echo "  WebAI Bridge Setup"
echo "  Install directory: $ROOT"
echo "============================================================"
echo

have() { command -v "$1" >/dev/null 2>&1; }

node_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo ""; }

# ---------- [1/4] Node.js ----------
echo "[1/4] Checking Node.js..."
NM="$(node_major)"
if [ -z "$NM" ] || [ "$NM" -lt 20 ] 2>/dev/null; then
  echo "      Node.js 20+ not found. Trying automatic install..."
  if have brew; then
    printf "      Install Node.js via Homebrew now? [y/N] "
    read -r ans
    case "$ans" in
      y|Y) brew install node && NM="$(node_major)" ;;
    esac
  elif have apt-get; then
    printf "      Install Node.js 20 via NodeSource (needs sudo)? [y/N] "
    read -r ans
    case "$ans" in
      y|Y)
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
          && sudo apt-get install -y nodejs \
          && NM="$(node_major)"
        ;;
    esac
  elif have dnf; then
    printf "      Install Node.js via dnf (needs sudo)? [y/N] "
    read -r ans
    case "$ans" in
      y|Y) sudo dnf install -y nodejs npm && NM="$(node_major)" ;;
    esac
  elif have pacman; then
    printf "      Install Node.js via pacman (needs sudo)? [y/N] "
    read -r ans
    case "$ans" in
      y|Y) sudo pacman -S --noconfirm nodejs npm && NM="$(node_major)" ;;
    esac
  fi
  if [ -z "$NM" ] || [ "$NM" -lt 20 ] 2>/dev/null; then
    echo
    echo "  [ERROR] Node.js 20+ is required but was not found."
    echo "  Install it manually, then re-run this setup:"
    echo "    - macOS:           brew install node   (or https://nodejs.org/)"
    echo "    - Debian/Ubuntu:   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "    - Fedora/RHEL:     sudo dnf install nodejs npm"
    echo "    - Arch:            sudo pacman -S nodejs npm"
    exit 1
  fi
fi
echo "      OK: Node.js v$NM.x"
echo

# ---------- [2/4] Dependencies ----------
echo "[2/4] Installing dependencies (npm install, project-local only)..."
if ! have npm; then
  echo "  [ERROR] npm not found even though Node.js is installed."
  exit 1
fi
if ! npm install --no-audit --no-fund; then
  echo "  [ERROR] npm install failed. Check your network/proxy, then run 'npm install' in $ROOT manually."
  exit 1
fi
echo "      OK: dependencies installed."
echo

# ---------- [3/4] Browser check ----------
echo "[3/4] Checking browser (Edge preferred, Chrome/Chromium fallback)..."
BROWSER_FOUND=""
for p in \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  /usr/bin/microsoft-edge /usr/bin/microsoft-edge-stable /usr/bin/microsoft-edge-beta \
  /usr/bin/google-chrome /usr/bin/google-chrome-stable \
  /usr/bin/chromium /usr/bin/chromium-browser
do
  if [ -x "$p" ]; then BROWSER_FOUND="$p"; break; fi
done
if [ -n "$BROWSER_FOUND" ]; then
  echo "      OK: $BROWSER_FOUND"
else
  echo "      [WARN] No Edge/Chrome/Chromium found in default locations."
  echo "      WebAI Bridge drives a local Chromium-family browser via CDP."
  echo "      Install Microsoft Edge: https://www.microsoft.com/edge/download"
  echo "      (or set \"browser.executablePath\" in config/backends.json)"
fi
echo

# ---------- [4/4] Environment (webai on PATH + WEBAI_HOME) ----------
echo "[4/4] Configuring environment (webai command + WEBAI_HOME)..."
chmod +x "$ROOT/bin/webai" 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/bin/webai" "$HOME/.local/bin/webai"

MARK_BEGIN="# >>> webai-bridge >>>"
MARK_END="# <<< webai-bridge <<<"

strip_block() {
  # Remove any previous webai-bridge block (keeps the block fresh if the install dir moved)
  [ -f "$1" ] || return 0
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 ~ b { skip = 1; next }
    $0 ~ e { skip = 0; next }
    !skip' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

add_block() {
  strip_block "$1"
  {
    echo ""
    echo "$MARK_BEGIN"
    echo "export WEBAI_HOME=\"$ROOT\""
    echo "case \":\$PATH:\" in *\":\$HOME/.local/bin:\"*) ;; *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;; esac"
    echo "$MARK_END"
  } >> "$1"
  echo "      Updated: $1"
}

WROTE=0
if [ -f "$HOME/.zshrc" ]; then add_block "$HOME/.zshrc"; WROTE=1; fi
if [ -f "$HOME/.bashrc" ]; then add_block "$HOME/.bashrc"; WROTE=1; fi
if [ "$WROTE" -eq 0 ]; then add_block "$HOME/.bashrc"; fi
if [ -f "$HOME/.profile" ]; then add_block "$HOME/.profile"; fi

# ---------- Verification ----------
if ! "$ROOT/node_modules/.bin/tsx" --version >/dev/null 2>&1; then
  echo "  [ERROR] Runtime verification failed. Try 'npm install' in $ROOT."
  exit 1
fi
echo "      OK: runtime (tsx) is working."
echo

echo "============================================================"
echo "  Setup finished successfully!"
echo
echo "  Next steps:"
echo "    1. Open a NEW terminal, or reload your shell config:"
echo "         source ~/.zshrc    (zsh)   /   source ~/.bashrc   (bash)"
echo "    2. Run:  webai"
echo "       (first run opens a dedicated browser window; log in once)"
echo "    3. One-shot tasks:  webai ci \"your task here\""
echo
echo "  To remove this installation later, run: bash uninstall.sh"
echo "============================================================"
