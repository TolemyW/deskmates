#!/bin/sh
# Run probe.mjs, then measure.mjs, in a throwaway node container on the spike's internal network.
set -eu
. "$(dirname "$0")/env.sh"

docker run --rm --network "$OC_NET" \
  --env-file "$SECRETS_FILE" \
  -e OC_BASE="$OC_BASE" -e OUT_DIR=/out \
  -v "$SPIKE_DIR:/spike:ro" -v "$OUT_DIR:/out" \
  -w /spike "$NODE_IMAGE" sh -c "${1:-node probe.mjs && node measure.mjs}"
