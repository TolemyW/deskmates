#!/usr/bin/env bash
# Build the optional desktop variant of the workspace image (ADR-0048 decision 11) on this host,
# for this host's use. It is NEVER pushed or published (decision 12): the upstream application's
# terms are not settled. The release workflow and the stable scripts do not call this script.
#
# Inputs, placed by the operator in images/workspace-desktop/inputs/:
#   lcu-<LCU_VERSION>-linux-x64.tar.gz       the LCU release archive
#   chatgpt-<APP_VERSION>-amd64.deb          the upstream desktop application package
# Both are checked against LCU_SHA256 and APP_SHA256 in images/workspace-desktop/pins.env, which
# must be filled first; the build refuses empty checksums.
#
# Base: BASE_IMAGE when set, else the content-addressed workspace tag from scripts/image-tag.mjs
# (build it first with scripts/build-workspace-image.sh). Tag: DESKTOP_IMAGE when set, else
# deskmates/workspace-desktop:<arch>-<hash12>, hashing the base image id, this variant's files and
# the pins. Print the tag; point WORKSPACE_IMAGE at it to use it.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=images/workspace-desktop
# shellcheck disable=SC1091
. "$DIR/pins.env"
for pin in LCU_VERSION LCU_SHA256 APP_VERSION APP_SHA256; do
  if [ -z "${!pin:-}" ]; then
    echo "build-workspace-desktop-image: $pin is empty in $DIR/pins.env; pin it from the file you verified" >&2
    exit 1
  fi
done
LCU_ARCHIVE="lcu-${LCU_VERSION}-linux-x64.tar.gz"
APP_PACKAGE="chatgpt-${APP_VERSION}-amd64.deb"
for input in "$LCU_ARCHIVE" "$APP_PACKAGE"; do
  if [ ! -f "$DIR/inputs/$input" ]; then
    echo "build-workspace-desktop-image: missing $DIR/inputs/$input" >&2
    exit 1
  fi
done
ARCH="${IMAGE_ARCH:-amd64}"
if [ "$ARCH" != "amd64" ]; then
  echo "build-workspace-desktop-image: only the linux-x64 inputs are pinned" >&2
  exit 1
fi
BASE="${BASE_IMAGE:-$(node scripts/image-tag.mjs workspace --arch "$ARCH")}"
BASE_ID="$(docker image inspect --format '{{.Id}}' "$BASE")"
HASH="$(
  {
    echo "$BASE_ID"
    cat "$DIR/Dockerfile" "$DIR/desktop-entry.sh" "$DIR/pins.env"
  } | sha256sum | cut -c1-12
)"
TAG="${DESKTOP_IMAGE:-deskmates/workspace-desktop:${ARCH}-${HASH}}"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
  exit 0
fi
docker build \
  --build-arg "BASE_IMAGE=$BASE" \
  --build-arg "LCU_VERSION=$LCU_VERSION" \
  --build-arg "LCU_SHA256=$LCU_SHA256" \
  --build-arg "APP_VERSION=$APP_VERSION" \
  --build-arg "APP_SHA256=$APP_SHA256" \
  -f "$DIR/Dockerfile" -t "$TAG" "$DIR"
echo "built $TAG (local only; do not push)"
