#!/usr/bin/env bash
# Build the Grafana image (images/grafana/README.md, ADR-0046 decision 6): the pinned official
# image plus the SQLite datasource plugin. The build needs the registries once; the container
# downloads nothing when it runs.
#
# Tag: GRAFANA_IMAGE when set; otherwise the content-addressed tag from scripts/image-tag.mjs
# (deskmates/grafana:<arch>-<hash12>) plus the alias deskmates/grafana:dev unless
# GRAFANA_NO_DEV_ALIAS=1 (stable.sh sets it: no moving alias on a shared daemon). Extra
# `docker build` arguments go in DOCKER_BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2206
EXTRA=(${DOCKER_BUILD_ARGS:-})
if [ -n "${GRAFANA_IMAGE:-}" ]; then
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/grafana/Dockerfile -t "$GRAFANA_IMAGE" images/grafana
  echo "built $GRAFANA_IMAGE"
  exit 0
fi
TAG="$(node scripts/image-tag.mjs grafana ${IMAGE_ARCH:+--arch "$IMAGE_ARCH"})"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
else
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/grafana/Dockerfile -t "$TAG" images/grafana
fi
if [ "${GRAFANA_NO_DEV_ALIAS:-}" = "1" ]; then
  echo "built $TAG"
else
  docker tag "$TAG" deskmates/grafana:dev
  echo "built $TAG (also deskmates/grafana:dev)"
fi
