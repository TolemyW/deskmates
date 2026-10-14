#!/usr/bin/env bash
# Re-run the S0 verification. Requires: Docker daemon, and for test-a the model gateway env vars.
#   ANTHROPIC_BASE_URL=https://...   ANTHROPIC_AUTH_TOKEN=...   SPIKE_MODEL=glm-5.3   npm run spike:s0
set -euo pipefail
cd "$(dirname "$0")/../spikes/s0"
[ -d node_modules ] || npm install
mkdir -p work-b work-gw
echo "== test-b: defer + resume =="
SPIKE_WORK=$PWD/work-b node test-b/step1-defer.mjs >/dev/null && SPIKE_WORK=$PWD/work-b node test-b/step2-resume.mjs | grep -E '"resultText"|"l2_exists_after_resume"'
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  echo "== test-a: SDK through gateway ($SPIKE_MODEL) =="
  SPIKE_WORK=$PWD/work-gw node test-a/run-endpoint.mjs | grep -E '"subtype"|"text"|"marker_written"|"cache_read_input_tokens"'
else
  echo "== test-a skipped (set ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / SPIKE_MODEL) =="
fi
echo "== test-c: shared browser (docker) =="
docker build -q -t s0-shared-browser test-c >/dev/null && docker run --rm --shm-size=1g s0-shared-browser 2>&1 | grep -E '^(PASS|FAIL)'
