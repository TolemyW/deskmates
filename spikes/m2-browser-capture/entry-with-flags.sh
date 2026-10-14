#!/bin/bash
# Disposable copy of images/workspace/entry.sh for the capture probe. The only behavior change is
# the experiment-only DESKMATES_EXPERIMENT_CHROME_FLAGS expansion immediately before about:blank.
set -euo pipefail

: "${DISPLAY:=:99}"; export DISPLAY
SCREEN="${DESKMATES_SCREEN:-1280x800x24}"
LOGDIR=/tmp/deskmates-logs
mkdir -p "$LOGDIR" /profile /work /run/deskmates
DISPLAY_NUM="${DISPLAY#:}"; DISPLAY_NUM="${DISPLAY_NUM%%.*}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp >"$LOGDIR/xvfb.log" 2>&1 &
for _ in $(seq 1 100); do xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep 0.1; done
xdotool getdisplaygeometry >/dev/null 2>&1 || { cat "$LOGDIR/xvfb.log" >&2 || true; exit 1; }
fluxbox >"$LOGDIR/fluxbox.log" 2>&1 &
x11vnc -display "$DISPLAY" -forever -nopw -shared -localhost -rfbport 5900 >"$LOGDIR/x11vnc.log" 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >"$LOGDIR/novnc.log" 2>&1 &

CHROME=$(cd /opt/deskmates && node -e "console.log(require('playwright').chromium.executablePath())")
RESOLVER_RULES="MAP * ~NOTFOUND, EXCLUDE localhost"
IFS=',' read -ra ALLOW <<<"${DESKMATES_EGRESS_ALLOWLIST:-}"
for host in "${ALLOW[@]}"; do
  host="${host// /}"; [ -n "$host" ] || continue
  RESOLVER_RULES="$RESOLVER_RULES, EXCLUDE $host"
  case "$host" in \*.*) RESOLVER_RULES="$RESOLVER_RULES, EXCLUDE ${host#\*.}" ;; esac
done
read -r -a EXPERIMENT_CHROME_FLAGS <<<"${DESKMATES_EXPERIMENT_CHROME_FLAGS:-}"
"$CHROME" --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/profile --no-first-run --no-default-browser-check \
  --host-resolver-rules="$RESOLVER_RULES" \
  --disable-background-networking --disable-component-update --disable-sync \
  --disable-default-apps --disable-extensions --disable-client-side-phishing-detection \
  --disable-domain-reliability --disable-breakpad --metrics-recording-only --no-pings \
  --safebrowsing-disable-auto-update --disable-search-engine-choice-screen \
  --disable-features=DnsOverHttps,MediaRouter,OptimizationHints,Translate,CertificateTransparencyComponentUpdater,HttpsUpgrades,LensOverlay \
  --window-size=1280,800 --window-position=0,0 \
  "${EXPERIMENT_CHROME_FLAGS[@]}" about:blank >"$LOGDIR/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 300); do
  curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null
shutdown() { kill -TERM "$CHROME_PID" 2>/dev/null || true; wait "$CHROME_PID" 2>/dev/null || true; exit 0; }
trap shutdown TERM INT
wait "$CHROME_PID" || CHROME_STATUS=$?
exit "${CHROME_STATUS:-1}"
