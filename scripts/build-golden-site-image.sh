#!/usr/bin/env bash
# Build the golden site image. Tag is the task-set version from evals/tasks/deskbench-v1.json.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync("evals/tasks/deskbench-v1.json", "utf8")).site_version')"
TAG="galaxy-ops-console:${VERSION}"
npm run build -w packages/golden-site
docker build -t "$TAG" packages/golden-site
echo "built $TAG"
