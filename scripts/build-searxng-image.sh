#!/usr/bin/env bash
# Build the SearXNG image (images/searxng/README.md, ADR-0049 decision 14): the pinned official
# image plus Deskmates' settings.yml. The build needs the registry once; the container queries
# only the search engines its settings name.
#
# Tag: SEARXNG_IMAGE when set; otherwise the content-addressed tag from scripts/image-tag.mjs
# (deskmates/searxng:<arch>-<hash12>) plus the alias deskmates/searxng:dev unless
# SEARXNG_NO_DEV_ALIAS=1 (stable.sh sets it: no moving alias on a shared daemon). Extra
# `docker build` arguments go in DOCKER_BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2206
EXTRA=(${DOCKER_BUILD_ARGS:-})
if [ -n "${SEARXNG_IMAGE:-}" ]; then
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/searxng/Dockerfile -t "$SEARXNG_IMAGE" images/searxng
  echo "built $SEARXNG_IMAGE"
  exit 0
fi
TAG="$(node scripts/image-tag.mjs searxng ${IMAGE_ARCH:+--arch "$IMAGE_ARCH"})"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
else
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/searxng/Dockerfile -t "$TAG" images/searxng
fi
if [ "${SEARXNG_NO_DEV_ALIAS:-}" = "1" ]; then
  echo "built $TAG"
else
  docker tag "$TAG" deskmates/searxng:dev
  echo "built $TAG (also deskmates/searxng:dev)"
fi
