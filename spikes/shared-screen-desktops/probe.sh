#!/bin/bash
set -euo pipefail
export DISPLAY=:88
Xvfb :88 -screen 0 2560x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep .1; done
fluxbox >/tmp/fluxbox.log 2>&1 &
CHROME=$(cd /opt/deskmates && node -e "console.log(require('playwright').chromium.executablePath())")
"$CHROME" --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --remote-debugging-port=9222 --user-data-dir=/tmp/probe-profile --window-size=1280,800 about:blank >/tmp/chrome.log 2>&1 &
for i in $(seq 1 100); do curl -fs http://localhost:9222/json/version >/dev/null && break; sleep .1; done
printf '%s\n' 'a1b2c3d4' '__BEGIN_VIEWONLY__' 'e5f6a7b8' >/tmp/vnc.pass
x11vnc -display :88 -clip 1280x800+0+0 -passwdfile /tmp/vnc.pass -forever -shared -localhost -rfbport 5901 >/tmp/vnc-a.log 2>&1 &
x11vnc -display :88 -clip 1280x800+1280+0 -passwdfile /tmp/vnc.pass -forever -shared -localhost -rfbport 5902 >/tmp/vnc-b.log 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6081 127.0.0.1:5901 >/tmp/ws-a.log 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6082 127.0.0.1:5902 >/tmp/ws-b.log 2>&1 &
cp /probe/probe.mjs /opt/deskmates/probe.mjs
node /opt/deskmates/probe.mjs &
PROBE_PID=$!
for i in $(seq 1 200); do test -f /evidence/result.json && break; sleep .2; done
test -f /evidence/result.json
import -window root /evidence/desktop.png
wait "$PROBE_PID"
