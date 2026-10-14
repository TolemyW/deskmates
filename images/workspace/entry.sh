#!/bin/bash
# Workspace container entry point, promoted from spikes/s0/test-c/entry.sh.
# Starts the shared desktop: Xvfb, fluxbox, x11vnc, noVNC, and the ONE headed Chromium every bot
# in this workspace uses (CDP on 127.0.0.1:9222, profile in /profile). No sidecar supervisor in
# M0: the Gateway starts one `deskmates-sidecar run` process per run through `docker exec`.
set -euo pipefail

: "${DISPLAY:=:99}"; export DISPLAY
SCREEN="${DESKMATES_SCREEN:-1280x720x24}"
if [[ "${DESKMATES_DESKTOP_MODE:-}" == "shared-monitors-v1" ]]; then SCREEN=3840x1440x24; fi
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
: "${DESKMATES_VNC_PASSWORD:?DESKMATES_VNC_PASSWORD is required}"
# Classic VNC authentication uses only eight bytes. Requiring the Gateway's exact 8-hex format
# avoids silently truncating two different passwords to the same effective credential.
if ! [[ "$DESKMATES_VNC_PASSWORD" =~ ^[0-9a-fA-F]{8}$ ]]; then
  echo "DESKMATES_VNC_PASSWORD must be exactly 8 hexadecimal characters" >&2
  exit 1
fi
# x11vnc -viewpasswd expects plaintext and requires -passwd; use the documented
# protected passwdfile format so neither password is exposed in process argv.
: "${DESKMATES_VNC_VIEW_PASSWORD:?DESKMATES_VNC_VIEW_PASSWORD is required}"
if ! [[ "$DESKMATES_VNC_VIEW_PASSWORD" =~ ^[0-9a-fA-F]{8}$ ]] || [[ "$DESKMATES_VNC_PASSWORD" == "$DESKMATES_VNC_VIEW_PASSWORD" ]]; then
  echo "a distinct eight-hex view password is required" >&2; exit 1
fi
VNC_PASSWORD_FILE=/run/deskmates/x11vnc.pass
umask 077
printf '%s\n' "$DESKMATES_VNC_PASSWORD" '__BEGIN_VIEWONLY__' "$DESKMATES_VNC_VIEW_PASSWORD" >"$VNC_PASSWORD_FILE"
x11vnc -display "$DISPLAY" -forever -passwdfile "$VNC_PASSWORD_FILE" -shared -localhost -rfbport 5900 >"$LOGDIR/x11vnc.log" 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >"$LOGDIR/novnc.log" 2>&1 &
if [[ "${DESKMATES_DESKTOP_MODE:-}" == "shared-monitors-v1" ]]; then
  for slot in 0 1 2 3 4 5; do
    x=$(( (slot % 3) * 1280 )); y=$(( (slot / 3) * 720 ))
    rfb=$((5901 + slot)); web=$((6081 + slot))
    x11vnc -display "$DISPLAY" -clip "1280x720+$x+$y" -forever -passwdfile "$VNC_PASSWORD_FILE" -shared -localhost -rfbport "$rfb" >"$LOGDIR/screen-$slot.log" 2>&1 &
    websockify --web /usr/share/novnc "0.0.0.0:$web" "127.0.0.1:$rfb" >"$LOGDIR/screen-ws-$slot.log" 2>&1 &
  done
fi

# /opt/deskmates/node_modules links the preinstalled playwright, so resolution works from there.
CHROME=$(cd /opt/deskmates && node -e "console.log(require('playwright').chromium.executablePath())")
# Browser-level egress: every hostname outside the workspace allowlist fails to resolve. This is
# deny-by-default (design v0.3 §3.10) applied where Chromium resolves names, so navigation and
# every phone-home the browser attempts (DoH, safe browsing, component update, connectivity
# probes) fail at once instead of leaving half-open sockets; on colima those sockets starve the
# container's path to the host. The Gateway sets DESKMATES_EGRESS_ALLOWLIST at container creation
# (comma-separated, `host` or `*.host`); the sidecar hook applies the same list per tool call.
# The managed proxy enforces public egress policy. The reserved host.docker.internal
# destination also goes through that proxy (ADR-0009); only loopback bypasses it.
# A `*.x` entry means x and every subdomain of x (contracts `egressAllows`); Chromium's EXCLUDE
# pattern `*.x` does not cover the bare x, so both forms are emitted for it.
RESOLVER_RULES="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE egress-proxy"
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

# /profile outlives containers, and Chromium's profile lock does not: SingletonLock names the
# hostname and pid that held it. After a container is removed without a clean Chromium exit (an
# image upgrade recreates it; an OOM kill; a daemon restart) the next container has a different
# hostname, Chromium reads the lock as "profile in use on another computer", exits 21, and the
# container restarts forever without becoming healthy (Testbox, 2026-09-29). This container runs
# the only Chromium that may use /profile, so any lock found now is stale.
rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket

# Launched by hand, not by Playwright, so Playwright's phone-home suppression is repeated here;
# the managed policy in /etc/chromium/policies/managed/deskmates.json turns off what flags cannot
# (secure-DNS auto-upgrade, safe browsing, metrics). Nothing in the image may phone home.
"$CHROME" --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/profile --no-first-run --no-default-browser-check \
  --host-resolver-rules="$RESOLVER_RULES" \
  --proxy-server="${DESKMATES_EGRESS_PROXY:?DESKMATES_EGRESS_PROXY is required}" \
  --proxy-bypass-list="localhost;127.0.0.1;[::1]" \
  --disable-background-networking --disable-component-update --disable-sync \
  --disable-default-apps --disable-extensions --disable-client-side-phishing-detection \
  --disable-domain-reliability --disable-breakpad --metrics-recording-only --no-pings \
  --safebrowsing-disable-auto-update --disable-search-engine-choice-screen \
  --disable-features=DnsOverHttps,MediaRouter,OptimizationHints,Translate,CertificateTransparencyComponentUpdater,HttpsUpgrades,LensOverlay \
  --window-size=1280,720 --window-position=0,0 \
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
# On `docker stop`, ask Chromium to close normally before any signal. SIGTERM alone lost freshly
# acknowledged cookie/localStorage writes (2026-10-02). Keep the whole shutdown inside the
# provider's ten-second stop window even if CDP or Chromium is stuck. A deliberate stop exits 0.
shutdown() {
  trap '' TERM INT
  node /usr/local/lib/deskmates/close-browser.mjs || true
  for _ in $(seq 1 20); do
    kill -0 "$CHROME_PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "chromium did not exit after graceful close; sending SIGTERM" >&2
    kill -TERM "$CHROME_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$CHROME_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
  if kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "chromium did not exit after SIGTERM; sending SIGKILL" >&2
    kill -KILL "$CHROME_PID" 2>/dev/null || true
  fi
  wait "$CHROME_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
# `|| true` because set -e would abort before the message; a signal makes wait return 128+n.
wait "$CHROME_PID" || CHROME_STATUS=$?
echo "chromium exited (status=${CHROME_STATUS:-0}); exiting so the container restarts" >&2
exit 1
