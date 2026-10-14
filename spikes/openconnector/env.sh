# Shared names for the OpenConnector spike. Sourced by up.sh, probe.sh and down.sh.
# Every name starts with `oc-spike-`, never `deskmates-`, so no Deskmates cleanup can select it.

# ghcr.io/oomol-lab/open-connector:v1.7.0 (== :latest on 2026-09-29), revision 4505aed0.
OC_IMAGE="ghcr.io/oomol-lab/open-connector@sha256:55b1c424b454451d61e34ea6e2f540e625569d8f4c31cc4c5ec8052dadda4c9b"
NODE_IMAGE="node:22-alpine"
TCPDUMP_IMAGE="oc-spike-tcpdump:local"

OC_NET="oc-spike-internal"          # docker network create --internal: no route off the host
OC_NETNS="oc-spike-netns"           # holds the network namespace the runtime and tcpdump share
OC_RUNTIME="oc-spike-runtime"
OC_CAPTURE="oc-spike-capture"
OC_MOCK="oc-spike-mock"
OC_VOLUME="oc-spike-data"

# The public origin a Deskmates deployment would give the runtime: the Gateway's origin plus a mount
# prefix it reverse-proxies to the runtime. Nothing listens on this host; it only shapes
# redirect URIs, guide examples and transit-file URLs, and forces every request to carry the prefix.
OC_ORIGIN="https://deskmates-gateway.example.test/integration-runtime"
OC_BASE="http://oc-spike-runtime:3000/integration-runtime"

SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SPIKE_DIR/out"
# Throwaway admin token and encryption key; kept outside the git tree.
SECRETS_FILE="/tmp/oc-spike-secrets.env"
