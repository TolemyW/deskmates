#!/bin/bash
# Workspace container entry point, promoted from spikes/s0/test-c/entry.sh.
# Starts the shared desktop: Xvfb, fluxbox, x11vnc, noVNC, and the ONE headed Chromium every bot
# in this workspace uses (CDP on 127.0.0.1:9222, profile in /profile). No sidecar supervisor in
# M0: the Gateway starts one `deskmates-sidecar run` process per run through `docker exec`.
set -euo pipefail

: "${DISPLAY:=:99}"; export DISPLAY
SCREEN="${DESKMATES_SCREEN:-1280x800x24}"
LOGDIR=/tmp/deskmates-logs
mkdir -p "$LOGDIR" /profile /work /run/deskmates

# This script must survive being run twice on the same filesystem: a container restart (see the
# tail of this file) reuses the writable layer, and the previous boot's X lock and socket are
# still there, so Xvfb refuses to start with "Server is already active for display 99". The
# container *is* the display, nothing else owns it, so clear them before starting.
DISPLAY_NUM="${DISPLAY#:}"; DISPLAY_NUM="${DISPLAY_NUM%%.*}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp >"$LOGDIR/xvfb.log" 2>&1 &
for _ in $(seq 1 100); do
  xdotool getdisplaygeometry >/dev/null 2>&1 && break
  sleep 0.1
done
# Without a display Chromium exits at once and the container would spin in a restart loop whose
# logs only mention Chromium. Fail here instead, where the reason is visible.
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  echo "Xvfb did not come up on $DISPLAY:" >&2
  cat "$LOGDIR/xvfb.log" >&2 || true
  exit 1
fi

fluxbox >"$LOGDIR/fluxbox.log" 2>&1 &
# VNC is bound to loopback; only noVNC (websockify) is reachable from outside the container.
x11vnc -display "$DISPLAY" -forever -nopw -shared -localhost -rfbport 5900 >"$LOGDIR/x11vnc.log" 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >"$LOGDIR/novnc.log" 2>&1 &

# /opt/deskmates/node_modules links the preinstalled playwright, so resolution works from there.
CHROME=$(cd /opt/deskmates && node -e "console.log(require('playwright').chromium.executablePath())")
# Browser-level egress: every hostname outside the workspace allowlist fails to resolve. This is
# deny-by-default (design v0.3 §3.10) applied where Chromium resolves names, so navigation and
# every phone-home the browser attempts (DoH, safe browsing, component update, connectivity
# probes) fail at once instead of leaving half-open sockets; on colima those sockets starve the
# container's path to the host. The Gateway sets DESKMATES_EGRESS_ALLOWLIST at container creation
# (comma-separated, `host` or `*.host`); the sidecar hook applies the same list per tool call.
# IP-literal URLs bypass name resolution and are left to the hook. Network-level egress is M1.
# A `*.x` entry means x and every subdomain of x (contracts `egressAllows`); Chromium's EXCLUDE
# pattern `*.x` does not cover the bare x, so both forms are emitted for it.
RESOLVER_RULES="MAP * ~NOTFOUND, EXCLUDE localhost"
IFS=',' read -ra ALLOW <<<"${DESKMATES_EGRESS_ALLOWLIST:-}"
for host in "${ALLOW[@]}"; do
  host="${host// /}"
  [ -n "$host" ] || continue
  RESOLVER_RULES="$RESOLVER_RULES, EXCLUDE $host"
  case "$host" in
    \*.*) RESOLVER_RULES="$RESOLVER_RULES, EXCLUDE ${host#\*.}" ;;
  esac
done
echo "chromium host-resolver-rules: $RESOLVER_RULES"

# Launched by hand, not by Playwright, so Playwright's phone-home suppression is repeated here;
# the managed policy in /etc/chromium/policies/managed/deskmates.json turns off what flags cannot
# (secure-DNS auto-upgrade, safe browsing, metrics). Nothing in the image may phone home.
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
  "${EXPERIMENT_CHROME_FLAGS[@]}" \
  about:blank >"$LOGDIR/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 300); do
  curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
  sleep 0.1
done
echo "deskmates workspace ready: display=$DISPLAY cdp=http://127.0.0.1:9222 novnc=:6080"

# The shared Chromium is what this container is for, so it is the container's lifetime. Waiting on
# every child instead (plain `wait`) kept the container "running" after Chromium died: healthz
# failed forever, the restart policy never fired because PID 1 was still alive, and every bot in
# the workspace lost its browser with nothing to recover it. Exiting non-zero lets the container's
# RestartPolicy (unless-stopped) rebuild the desktop; /profile is a named volume, so cookies and
# logins survive the restart.
#
# On `docker stop` the trap gets in first: Chromium gets a clean SIGTERM so the profile is
# flushed, and we exit 0 — a deliberate stop must not look like a crash.
shutdown() { kill -TERM "$CHROME_PID" 2>/dev/null || true; wait "$CHROME_PID" 2>/dev/null || true; exit 0; }
trap shutdown TERM INT
# `|| true` because set -e would abort before the message; a signal makes wait return 128+n.
wait "$CHROME_PID" || CHROME_STATUS=$?
echo "chromium exited (status=${CHROME_STATUS:-0}); exiting so the container restarts" >&2
exit 1
