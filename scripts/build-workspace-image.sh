#!/usr/bin/env bash
# Build the workspace image in two layers:
#   1. the base (images/workspace-base: desktop, browser, SDK, MCP, CLI, tools; ~3.4 GB, needs the
#      network, rebuilt only when its Dockerfile changes), tagged deskmates/workspace-base:<arch>-<hash12>
#      plus the alias deskmates/workspace-base:dev;
#   2. the app layer (images/workspace: contracts + sidecar dist + entry scripts; ~0.5 MB, offline)
#      FROM that base.
#
# Workspace tag: WORKSPACE_IMAGE when set; otherwise the content-addressed tag from
# scripts/image-tag.mjs (deskmates/workspace:<arch>-<hash12>, which covers the base's hash) plus the
# moving alias deskmates/workspace:dev. An unchanged tree yields the same tags, and an existing tag
# is reused without a build.
#
# Knobs:
#   BASE_IMAGE=<ref or image ID>  use this base instead of the content-addressed one
#   NO_BASE_BUILD=1               fail instead of building a missing base (hosts that cannot reach
#                                 package registries, e.g. Testbox: ship the base there instead)
#   IMAGE_ARCH=amd64|arm64        architecture in the tags (default: the daemon's)
#   DOCKER_BUILD_ARGS             extra `docker build` arguments (e.g. --network host)
set -euo pipefail
cd "$(dirname "$0")/.."
# A failed build used to be a warning, which baked whatever stale dist/ happened to be on disk
# into the image: the container then ran code nobody had compiled from this checkout. Fail loudly
# instead. SKIP_SIDECAR_BUILD=1 is the explicit opt-out for testing an already-built tree.
if [ "${SKIP_SIDECAR_BUILD:-}" != "1" ]; then
  # testkit before sidecar: the sidecar's tests import it, and npm -w runs in declaration order.
  if ! { npm run build -w packages/contracts && npm run build -w packages/testkit &&
    npm run build -w packages/sidecar; }; then
    echo "error: contracts/sidecar build failed; refusing to bake a stale dist/ into the image" >&2
    echo "       fix the build, or set SKIP_SIDECAR_BUILD=1 to use the dist/ already on disk" >&2
    exit 1
  fi
fi
# shellcheck disable=SC2206
EXTRA=(${DOCKER_BUILD_ARGS:-})
ARCH_ARGS=()
[ -n "${IMAGE_ARCH:-}" ] && ARCH_ARGS=(--arch "$IMAGE_ARCH")

BASE="${BASE_IMAGE:-}"
if [ -z "$BASE" ]; then
  BASE="$(node scripts/image-tag.mjs base ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"})"
  if docker image inspect "$BASE" >/dev/null 2>&1; then
    echo "reusing base $BASE"
  elif [ "${NO_BASE_BUILD:-}" = "1" ]; then
    echo "error: base image $BASE is not on this host and NO_BASE_BUILD=1" >&2
    echo "       ship it here (docs/runbooks/stable-release.md) or build it where the network works" >&2
    exit 1
  else
    docker build ${EXTRA[@]+"${EXTRA[@]}"} -f images/workspace-base/Dockerfile -t "$BASE" images/workspace-base
  fi
  docker tag "$BASE" deskmates/workspace-base:dev
elif ! docker image inspect "$BASE" >/dev/null 2>&1; then
  echo "error: BASE_IMAGE $BASE is not on this host" >&2
  exit 1
fi

build_app() { # tag
  docker build ${EXTRA[@]+"${EXTRA[@]}"} --build-arg "BASE_IMAGE=$BASE" \
    -f images/workspace/Dockerfile -t "$1" .
}
if [ -n "${WORKSPACE_IMAGE:-}" ]; then
  build_app "$WORKSPACE_IMAGE"
  echo "built $WORKSPACE_IMAGE"
  exit 0
fi
TAG="$(node scripts/image-tag.mjs workspace ${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"})"
if docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "reusing $TAG (same inputs, already built)"
else
  build_app "$TAG"
fi
docker tag "$TAG" deskmates/workspace:dev
echo "built $TAG (also deskmates/workspace:dev)"
