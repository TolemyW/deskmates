#!/bin/sh
# The whole spike in one go: fresh outputs, start, probe + measure, stop and remove, summarise capture.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$DIR/out"
sh "$DIR/up.sh"
sh "$DIR/probe.sh" || echo "probe failed; tearing down anyway"
sh "$DIR/down.sh"
sh "$DIR/pcap-summary.sh"
