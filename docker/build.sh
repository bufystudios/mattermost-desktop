#!/usr/bin/env bash
# Bufy fork: build unsigned Linux and/or Windows packages in a pinned container.
#
#   ./docker/build.sh linux|windows|all [--arch x64,arm64] [--engine docker|podman] [--no-cache]
#
# Artifacts land in ./release/bufy/ . Works with Docker and (rootless) Podman.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="$REPO/release/bufy"
IMAGE="bufy-desktop-builder"

TARGET="${1:-}"
shift || true
ARCHES=""
ENGINE=""
NO_CACHE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCHES="${2//,/ }"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in linux|windows|all) ;; *) echo "usage: $0 linux|windows|all [--arch x64,arm64] [--engine docker|podman]" >&2; exit 2 ;; esac

if [ -z "$ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then ENGINE=docker; elif command -v podman >/dev/null 2>&1; then ENGINE=podman; else echo "need docker or podman" >&2; exit 1; fi
fi
# `docker` may be a podman shim (as on the Fedora dev box)
IS_PODMAN=0
if "$ENGINE" --version 2>/dev/null | grep -qi podman; then IS_PODMAN=1; fi

mkdir -p "$OUT"

echo "==> Building builder image ($ENGINE)"
"$ENGINE" build $NO_CACHE -t "$IMAGE" "$HERE"

RUN_ARGS=(--rm -v "$REPO":/src:ro -v "$OUT":/out)
if [ "$IS_PODMAN" = 1 ]; then
  # rootless podman: container root == invoking user, so artifacts are owned by you; :Z for SELinux hosts
  RUN_ARGS=(--rm -v "$REPO":/src:ro,Z -v "$OUT":/out:Z)
else
  # real Docker: the container runs as root; it chowns the artifacts back to the invoking user at the end
  RUN_ARGS+=(-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)")
fi

run_target() {
  local t="$1"; shift
  echo "==> Packaging $t ${ARCHES:+($ARCHES)}"
  # one cache volume (downloads) shared, one work volume (node_modules + build output) per target
  "$ENGINE" run "${RUN_ARGS[@]}" \
    -v bufy-builder-cache:/cache \
    -v "bufy-builder-work-$t":/work \
    "$IMAGE" "$t" $ARCHES
}

case "$TARGET" in
  linux) run_target linux ;;
  windows) run_target windows ;;
  all) run_target linux; run_target windows ;;
esac

echo
echo "==> Done. Artifacts in $OUT:"
ls -lh "$OUT"
