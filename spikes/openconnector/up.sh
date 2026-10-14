#!/bin/sh
# Start OpenConnector the way a deployment would (published image pinned by digest, SQLite state on a
# volume, encryption key and admin token set) on an internal Docker network with no egress, next to a
# mock Gitea and a tcpdump that records every packet the runtime's network namespace sends.
set -eu
. "$(dirname "$0")/env.sh"

mkdir -p "$OUT_DIR"

if [ ! -f "$SECRETS_FILE" ]; then
  umask 077
  {
    echo "OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -base64 32)"
    echo "OOMOL_CONNECT_ADMIN_TOKEN=$(openssl rand -hex 24)"
  } > "$SECRETS_FILE"
fi

docker image inspect "$TCPDUMP_IMAGE" >/dev/null 2>&1 || \
  printf 'FROM alpine:3.20\nRUN apk add --no-cache tcpdump\n' | docker build -t "$TCPDUMP_IMAGE" -

docker network inspect "$OC_NET" >/dev/null 2>&1 || docker network create --internal "$OC_NET"
docker volume create "$OC_VOLUME" >/dev/null

# Network namespace holder; the runtime is reachable as oc-spike-runtime through its alias.
docker run -d --name "$OC_NETNS" --network "$OC_NET" --network-alias "$OC_RUNTIME" alpine:3.20 sleep infinity

# Capture starts before the runtime so startup traffic, if any, is recorded.
docker run -d --name "$OC_CAPTURE" --network "container:$OC_NETNS" \
  -v "$OUT_DIR:/out" "$TCPDUMP_IMAGE" tcpdump -i any -n -U -w /out/runtime-netns.pcap
sleep 2

docker run -d --name "$OC_MOCK" --network "$OC_NET" --network-alias gitea.spike.internal \
  -v "$SPIKE_DIR:/spike:ro" "$NODE_IMAGE" node /spike/mock-gitea.mjs

docker run -d --name "$OC_RUNTIME" --network "container:$OC_NETNS" \
  -v "$OC_VOLUME:/app/data" \
  --env-file "$SECRETS_FILE" \
  -e OOMOL_CONNECT_ORIGIN="$OC_ORIGIN" \
  -e OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true \
  -e OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=slack,googledrive \
  -e OOMOL_CONNECT_BLOCKED_PROXIES='*' \
  -e OOMOL_CONNECT_LOG_LEVEL=debug \
  "$OC_IMAGE"

echo "waiting for health"
for i in $(seq 1 60); do
  if docker run --rm --network "$OC_NET" "$NODE_IMAGE" \
    node -e "fetch('$OC_BASE/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo "healthy after ${i}s"
    break
  fi
  sleep 1
done

docker image inspect "$OC_IMAGE" --format '{{json .RepoDigests}} {{json .Config.Labels}}' > "$OUT_DIR/image.json"
docker inspect "$OC_RUNTIME" --format '{{json .Config.Env}}' \
  | sed -E 's/(ENCRYPTION_KEY|ADMIN_TOKEN)=[^"]*/\1=<redacted>/g' > "$OUT_DIR/runtime-env.json"
