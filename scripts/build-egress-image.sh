#!/usr/bin/env bash
# Build the egress proxy image (images/egress/README.md), the workspace network's only way out.
#
# Tag: EGRESS_PROXY_IMAGE when set; otherwise the content-addressed tag from
# scripts/image-tag.mjs (deskmates/egress-proxy:<arch>-<hash12>) plus the alias
# deskmates/egress-proxy:dev. Extra `docker build` arguments go in DOCKER_BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC2206
EXTRA=(${DOCKER_BUILD_ARGS:-})
if [ -n "${EGRESS_PROXY_IMAGE:-}" ]; then
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/egress/Dockerfile -t "$EGRESS_PROXY_IMAGE" .
  echo "built $EGRESS_PROXY_IMAGE"
  exit 0
fi
TAG="$(node scripts/image-tag.mjs egress ${IMAGE_ARCH:+--arch "$IMAGE_ARCH"})"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
else
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/egress/Dockerfile -t "$TAG" .
fi
docker tag "$TAG" deskmates/egress-proxy:dev
echo "built $TAG (also deskmates/egress-proxy:dev)"
