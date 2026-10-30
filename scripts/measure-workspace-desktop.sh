#!/usr/bin/env bash
# Measure what ADR-0048 decision 11 asks before the desktop variant is accepted in use: clean
# uncompressed and compressed growth over the base workspace image, container start time to
# healthy, and idle and active memory. Prints one JSON object; record it under docs/design/ with
# the date, the two image ids and the host's Docker version. Not a default CI check: it needs
# Docker and a locally built variant (scripts/build-workspace-desktop-image.sh).
#
# Usage: scripts/measure-workspace-desktop.sh <base image> <desktop image>
# Active memory is sampled while `lcu doctor` runs inside the desktop container, a bounded,
# model-free load; it is not a measurement of a real desktop task.
set -euo pipefail
BASE="${1:?base image}"
DESKTOP="${2:?desktop image}"
IDLE_SECONDS="${IDLE_SECONDS:-30}"

size() { docker image inspect --format '{{.Size}}' "$1"; }
compressed() { docker save "$1" | gzip -c | wc -c | tr -d ' '; }
mem_bytes() {
  # docker stats prints e.g. "123.4MiB / 7.6GiB"; convert the first figure to bytes.
  docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{print $1}' | awk '
    /KiB$/ { sub(/KiB$/, ""); printf "%d", $0 * 1024; next }
    /MiB$/ { sub(/MiB$/, ""); printf "%d", $0 * 1048576; next }
    /GiB$/ { sub(/GiB$/, ""); printf "%d", $0 * 1073741824; next }
    /B$/   { sub(/B$/, ""); printf "%d", $0; next }'
}
start_healthy() {
  local image="$1" name="$2" t0 status
  t0="$(date +%s.%N)"
  docker run -d --name "$name" \
    -e DESKMATES_VNC_PASSWORD=deadbeef -e DESKMATES_VNC_VIEW_PASSWORD=cafe1234 \
    -e DESKMATES_EGRESS_PROXY=http://127.0.0.1:9 "$image" >/dev/null
  for _ in $(seq 1 240); do
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
      docker logs --tail 80 "$name" >&2
      echo "measure: $image exited before becoming healthy" >&2
      exit 1
    fi
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")"
    [ "$status" = "healthy" ] && break
    sleep 0.5
  done
  [ "$status" = "healthy" ] || { echo "measure: $image did not become healthy" >&2; exit 1; }
  awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }'
}

nonce="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
base_name="deskmates-measure-base-$nonce"
desk_name="deskmates-measure-desktop-$nonce"
trap 'docker rm -f "$base_name" "$desk_name" >/dev/null 2>&1 || true' EXIT

base_size="$(size "$BASE")"; desk_size="$(size "$DESKTOP")"
base_gz="$(compressed "$BASE")"; desk_gz="$(compressed "$DESKTOP")"
base_start="$(start_healthy "$BASE" "$base_name")"
desk_start="$(start_healthy "$DESKTOP" "$desk_name")"
sleep "$IDLE_SECONDS"
base_idle="$(mem_bytes "$base_name")"; desk_idle="$(mem_bytes "$desk_name")"
docker exec "$desk_name" timeout 30 /opt/lcu/current/bin/lcu doctor >/dev/null 2>&1 &
doctor=$!
desk_active=0
while kill -0 "$doctor" 2>/dev/null; do
  sample="$(mem_bytes "$desk_name")"
  [ "${sample:-0}" -gt "$desk_active" ] && desk_active="$sample"
  sleep 0.5
done
wait "$doctor" || true

cat <<JSON
{
  "baseImage": "$(docker image inspect --format '{{.Id}}' "$BASE")",
  "desktopImage": "$(docker image inspect --format '{{.Id}}' "$DESKTOP")",
  "uncompressedBytes": { "base": $base_size, "desktop": $desk_size, "growth": $((desk_size - base_size)) },
  "compressedGzipBytes": { "base": $base_gz, "desktop": $desk_gz, "growth": $((desk_gz - base_gz)) },
  "startToHealthySeconds": { "base": $base_start, "desktop": $desk_start },
  "idleMemoryBytes": { "base": $base_idle, "desktop": $desk_idle, "afterSeconds": $IDLE_SECONDS },
  "activeMemoryBytes": { "desktop": $desk_active, "load": "lcu doctor" }
}
JSON
