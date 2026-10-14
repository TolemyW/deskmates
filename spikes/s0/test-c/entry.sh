#!/bin/bash
set -e
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
# single headed Chromium, persistent profile, CDP on 9222
CHROME=$(node -e "console.log(require('playwright').chromium.executablePath())")
mkdir -p /profile
"$CHROME" --no-sandbox --disable-gpu --remote-debugging-port=9222 --user-data-dir=/profile \
  --no-first-run --window-size=1280,800 about:blank >/tmp/chrome.log 2>&1 &
sleep 3
node /app/test.mjs
