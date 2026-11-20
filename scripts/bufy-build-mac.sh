#!/usr/bin/env bash
# Bufy fork: build the macOS app natively on a Mac (unsigned, ad-hoc signed so it launches).
#
#   ./scripts/bufy-build-mac.sh [arm64|x64|universal]     (default: the Mac's own architecture)
#
# Output: release/bufy/mattermost-desktop-bufy-<version>-bufy.<N>-mac-<arch>.zip (+ .dmg when hdiutil works)
# Why not Docker: macOS packaging needs codesign/hdiutil and the macOS SDK; native modules must be built on macOS.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script must run on macOS. (Linux/Windows packages: ./docker/build.sh)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x64|x86_64) ARCH=x64 ;;
  universal) ;;
  *) echo "usage: $0 [arm64|x64|universal]" >&2; exit 2 ;;
esac

command -v node >/dev/null || { echo "Node.js >= 24 is required (see .nvmrc)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node >= 24 required, found $(node -v). Try: nvm install" >&2; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Xcode command line tools required: xcode-select --install" >&2; exit 1; }

echo "==> Installing dependencies"
npm ci

echo "==> Building app bundle"
npm run build-prod

echo "==> Packaging ($ARCH, unsigned)"
rm -rf release/mac*
# `dir` target = just the .app; we sign it ourselves, then zip/dmg it
if [ "$ARCH" = universal ]; then ARCH_FLAG=(--universal); else ARCH_FLAG=("--$ARCH"); fi
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.bufy.ts --mac dir "${ARCH_FLAG[@]}" --publish=never

APP="$(find release -maxdepth 3 -name 'Mattermost.app' -type d | head -1)"
[ -n "$APP" ] || { echo "Mattermost.app not found in release/" >&2; exit 1; }

echo "==> Ad-hoc signing $APP"
# Required on Apple Silicon: unsigned arm64 code does not run. Ad-hoc != notarized; Gatekeeper still asks once.
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

VERSION="$(node -p "require('./package.json').version")"
OUT="release/bufy"
mkdir -p "$OUT"
BUFY_BUILD="$(sed -n "s/^const BUFY_BUILD = '\\(.*\\)';/\\1/p" electron-builder.bufy.ts)"
[ -n "$BUFY_BUILD" ] || { echo "BUFY_BUILD not found in electron-builder.bufy.ts" >&2; exit 1; }
BASE="$OUT/mattermost-desktop-bufy-$VERSION-bufy.$BUFY_BUILD-mac-$ARCH"
rm -f "$BASE.zip" "$BASE.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$BASE.zip"
if hdiutil create -volname "Mattermost (Bufy)" -srcfolder "$APP" -ov -format UDZO "$BASE.dmg" >/dev/null 2>&1; then
  echo "dmg: $BASE.dmg"
fi

echo
echo "Done: $BASE.zip"
cat <<'MSG'

First launch (the app is not notarized):
  1. Unzip, drag Mattermost.app to /Applications (replaces the stock app in place; data stays).
  2. Right-click the app > Open > Open  — or: System Settings > Privacy & Security > "Open Anyway".
     Terminal alternative:  xattr -dr com.apple.quarantine /Applications/Mattermost.app
  3. Grant Accessibility (push-to-talk) and Screen Recording (screen share) when asked.
     Ad-hoc signed builds get a new identity on every rebuild, so macOS may ask for the permissions again after an update
     (remove the old entry with the "-" button in Privacy & Security, then re-add the app).
MSG
