#!/bin/bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/../.." && pwd)
: "${WORKSPACE_IMAGE:?set WORKSPACE_IMAGE to a Docker image ID (docker image inspect --format '{{.Id}}' <tag>)}"
node "$REPO_ROOT/acceptance/support/image-id.mjs" "$WORKSPACE_IMAGE" WORKSPACE_IMAGE
IMAGE="$WORKSPACE_IMAGE"
STAMP="${PROBE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
OUT="${PROBE_OUTPUT_ROOT:-$HERE/work-concurrent-$STAMP}"
if [ -e "$OUT" ]; then echo "refusing existing output: $OUT" >&2; exit 2; fi
mkdir -p "$(dirname "$OUT")"
mkdir "$OUT"

containers=()
volumes=()
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
printf '%s\n' "$IMAGE" >"$OUT/image.txt"
printf '%s\n' "$IMAGE_ID" >"$OUT/image-id.txt"
SOURCE_REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD)
printf '%s\n' "$SOURCE_REVISION" >"$OUT/source-revision.txt"
(cd "$HERE" && shasum -a 256 README.md concurrent-probe.mjs entry-with-flags.sh run-concurrent-probe.sh) >"$OUT/probe-sources.sha256"
BUNDLE_SHA=$(shasum -a 256 "$OUT/probe-sources.sha256" | awk '{print $1}')
printf '%s\n' "$BUNDLE_SHA" >"$OUT/probe-bundle.sha256"

run_arm() {
  local arm=$1
  local pattern=$2
  local safe=${STAMP//[^a-zA-Z0-9_.-]/-}
  local container="deskmates-capture-concurrent-${arm}-${safe}"
  local profile="deskmates-capture-concurrent-profile-${arm}-${safe}"
  local work="deskmates-capture-concurrent-work-${arm}-${safe}"
  local arm_out="$OUT/$arm"
  local probe_status=0
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "refusing existing container: $container" >&2; return 2
  fi
  for resource in "$profile" "$work"; do
    if docker volume inspect "$resource" >/dev/null 2>&1; then
      echo "refusing existing volume: $resource" >&2; return 2
    fi
  done
  if [ -e "$arm_out" ]; then echo "refusing existing arm output: $arm_out" >&2; return 2; fi
  mkdir "$arm_out"
  containers+=("$container")
  volumes+=("$profile" "$work")
  docker volume create "$profile" >/dev/null
  docker volume create "$work" >/dev/null
  docker run -d --name "$container" \
    --entrypoint /bin/bash \
    --shm-size=1g --pids-limit=4096 --cap-drop=ALL --security-opt=no-new-privileges \
    -e DESKMATES_EGRESS_ALLOWLIST=localhost \
    -e DESKMATES_EXPERIMENT_CHROME_FLAGS= \
    -v "$profile:/profile" -v "$work:/work" \
    -v "$HERE/entry-with-flags.sh:/experiment-entry.sh:ro" \
    -v "$HERE/concurrent-probe.mjs:/probe.mjs:ro" \
    -v "$arm_out:/probe-output" \
    "$IMAGE" /experiment-entry.sh >"$arm_out/container-id.txt"
  for _ in $(seq 1 300); do
    docker exec "$container" curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
    sleep 0.1
  done
  docker exec "$container" curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >"$arm_out/browser-version.json"
  docker exec "$container" sh -c "pid=\$(pgrep -f 'remote-debugging-port=9222' | head -1); tr '\\0' ' ' </proc/\$pid/cmdline" >"$arm_out/chrome-command.txt"
  docker exec \
    -e PROBE_MODE="$arm" -e PROBE_ROUNDS=8 -e PROBE_CONCURRENCY_PATTERN="$pattern" \
    -e PROBE_INTER_ROUND_IDLE_MS=10000 \
    -e PROBE_OUTPUT_DIR=/probe-output \
    -e PROBE_IMAGE_NAME="$IMAGE" -e PROBE_IMAGE_ID="$IMAGE_ID" \
    -e PROBE_SOURCE_REVISION="$SOURCE_REVISION" -e PROBE_BUNDLE_SHA256="$BUNDLE_SHA" \
    "$container" node /probe.mjs >"$arm_out/stdout.json" 2>"$arm_out/stderr.log" || probe_status=$?
  printf '%s\n' "${probe_status:-0}" >"$arm_out/exit-status.txt"
  docker logs "$container" >"$arm_out/container.log" 2>&1
  docker rm -f "$container" >/dev/null
  containers=("${containers[@]/$container}")
  docker volume rm "$profile" "$work" >/dev/null
  volumes=("${volumes[@]/$profile}")
  volumes=("${volumes[@]/$work}")
  return "${probe_status:-0}"
}

failures=0
run_arm concurrent-natural natural || failures=$((failures + 1))
run_arm concurrent-foreground-steal steal || failures=$((failures + 1))

node --input-type=commonjs - "$OUT" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const arms = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const resultPath = `${root}/${entry.name}/result.json`;
    if (!fs.existsSync(resultPath)) return { mode: entry.name, missingResult: true };
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    return { mode: result.mode, error: result.error, ...result.summary };
  });
fs.writeFileSync(`${root}/summary.json`, `${JSON.stringify({ arms }, null, 2)}\n`);
NODE
echo "$OUT"
exit "$failures"
