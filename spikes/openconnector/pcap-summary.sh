#!/bin/sh
# Summarise out/runtime-netns.pcap: every DNS name the runtime's network namespace asked for and every
# TCP connection it opened. Run on the host; tcpdump runs in the spike's tcpdump image.
set -eu
. "$(dirname "$0")/env.sh"

docker run --rm -v "$OUT_DIR:/out" -v "$SPIKE_DIR:/spike:ro" "$TCPDUMP_IMAGE" sh /spike/pcap-summary.inner.sh \
  | tee "$OUT_DIR/pcap-summary.txt"
