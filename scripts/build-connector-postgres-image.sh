#!/usr/bin/env bash
# Build the PostgreSQL-protocol connector image (packages/connector-postgres/README.md).
#
# Builds contracts and the connector first so both dist/ directories exist, then the image with
# the repository root as context and images/connector-postgres/Dockerfile.dockerignore as its
# allowlist (BuildKit reads <Dockerfile>.dockerignore next to the Dockerfile).
#
# Tag: CONNECTOR_POSTGRES_IMAGE when set; otherwise the content-addressed tag from
# scripts/image-tag.mjs (deskmates/connector-postgres:<arch>-<hash12>) plus the alias
# deskmates/connector-postgres:dev. Extra `docker build` arguments go in DOCKER_BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w packages/contracts -w packages/connector-postgres
export DOCKER_BUILDKIT=1
# shellcheck disable=SC2206
EXTRA=(${DOCKER_BUILD_ARGS:-})
if [ -n "${CONNECTOR_POSTGRES_IMAGE:-}" ]; then
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/connector-postgres/Dockerfile -t "$CONNECTOR_POSTGRES_IMAGE" .
  echo "built $CONNECTOR_POSTGRES_IMAGE"
  exit 0
fi
TAG="$(node scripts/image-tag.mjs connector-postgres ${IMAGE_ARCH:+--arch "$IMAGE_ARCH"})"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
else
  docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/connector-postgres/Dockerfile -t "$TAG" .
fi
docker tag "$TAG" deskmates/connector-postgres:dev
echo "built $TAG (also deskmates/connector-postgres:dev)"
