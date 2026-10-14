#!/bin/sh
# Save logs, stop and remove every spike container, the network and the volume. Images stay.
set -u
. "$(dirname "$0")/env.sh"

docker logs "$OC_RUNTIME" > "$OUT_DIR/runtime.log" 2>&1
docker logs "$OC_MOCK" > "$OUT_DIR/mock-gitea.log" 2>&1
docker stop "$OC_CAPTURE" >/dev/null 2>&1
docker rm -f "$OC_RUNTIME" "$OC_CAPTURE" "$OC_MOCK" "$OC_NETNS" >/dev/null 2>&1
docker network rm "$OC_NET" >/dev/null 2>&1
docker volume rm "$OC_VOLUME" >/dev/null 2>&1
rm -f "$SECRETS_FILE"
echo "removed containers, network $OC_NET and volume $OC_VOLUME"
