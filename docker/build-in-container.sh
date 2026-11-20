#!/usr/bin/env bash
# Runs INSIDE the builder container. Usage: bufy-build-in-container linux|windows [x64 arm64 ...]
# /src  = repository (read-only)
# /work = scratch copy (node_modules cached on a volume, one volume per target)
# /out  = artifacts
set -euo pipefail

TARGET="${1:?target required: linux|windows}"
shift || true
ARCHES=("$@")

case "$TARGET" in
  linux)   [ ${#ARCHES[@]} -gt 0 ] || ARCHES=(x64 arm64) ;;
  windows) [ ${#ARCHES[@]} -gt 0 ] || ARCHES=(x64) ;;
  *) echo "unknown target $TARGET" >&2; exit 2 ;;
esac

log() { printf '\n==> %s\n' "$*"; }

log "Syncing sources into /work"
# `P` protects the cached node_modules and the build outputs from --delete
rsync -a --delete \
  --filter='P /node_modules/' --filter='P /dist/' --filter='P /release/' \
  --exclude='/node_modules/' --exclude='/dist/' --exclude='/release/' --exclude='/.git/' --exclude='/e2e/node_modules/' \
  /src/ /work/
cd /work

# webpack.config.base.js asks git for the commit hash; point it at the (read-only) repository
export GIT_DIR=/src/.git GIT_WORK_TREE=/work
git config --global --add safe.directory /src || true
git config --global --add safe.directory /work || true

LOCK_HASH="$(sha256sum package-lock.json patches/* | sha256sum | cut -d' ' -f1)"
if [ ! -f node_modules/.bufy-lock-hash ] || [ "$(cat node_modules/.bufy-lock-hash)" != "$LOCK_HASH" ]; then
  log "Installing dependencies (npm ci --ignore-scripts)"
  npm ci --ignore-scripts
  # postinstall is skipped on purpose: electron-builder rebuilds natives per target arch while packaging
  # and Electron itself is downloaded per target by electron-builder.
  npx patch-package
  echo "$LOCK_HASH" > node_modules/.bufy-lock-hash
else
  log "node_modules up to date (lockfile + patches unchanged)"
fi

log "Building app bundle (webpack, production)"
rm -rf dist
npm run build-prod

mkdir -p /out
EB="npx electron-builder --config electron-builder.bufy.ts --publish=never"

if [ "$TARGET" = "linux" ]; then
  for arch in "${ARCHES[@]}"; do
    log "Packaging linux-$arch"
    case "$arch" in
      x64)   CCPREFIX=x86_64-linux-gnu ;;
      arm64) CCPREFIX=aarch64-linux-gnu ;;
      *) echo "unsupported linux arch $arch" >&2; exit 2 ;;
    esac
    CC="${CCPREFIX}-gcc" CXX="${CCPREFIX}-g++" $EB --linux deb rpm appimage tar.gz "--$arch"
  done
else
  # node-gyp cannot cross-compile, so @electron/rebuild is skipped for Windows and the add-ons are provided here:
  #  - registry-js: N-API prebuild for win32 from its GitHub releases
  #  - koffi: @koromix/koffi-win32-<arch> is fetched by scripts/beforepack.js (upstream)
  #  - uiohook-napi: ships win32 prebuilds in the npm package
  #  - windows-focus-assist: MSVC-only source add-on, cannot be built here (app falls back, see docs/bufy/BUILD.md)
  #  - cf-prefs, macos-notification-state: macOS-only
  for arch in "${ARCHES[@]}"; do
    log "Packaging win32-$arch"
    rm -rf node_modules/registry-js/build
    (cd node_modules/registry-js && node ../prebuild-install/bin.js --runtime napi --target 3 --platform win32 --arch "$arch" --force)
    test -f node_modules/registry-js/build/Release/registry.node
    $EB --win nsis zip "--$arch" --config.npmRebuild=false
  done
  rm -rf node_modules/registry-js/build   # do not leave a win32 binary in the cached linux-facing tree
fi

log "Collecting artifacts"
find release -maxdepth 2 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.tar.gz' -o -name '*.exe' -o -name '*.zip' \) \
  ! -path '*/win-unpacked/*' ! -path '*/linux-*unpacked/*' -print -exec cp -f {} /out/ \;

if [ -n "${HOST_UID:-}" ]; then
  chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" /out
fi
