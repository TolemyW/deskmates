#!/bin/bash
# Entry point of the desktop variant (ADR-0048 decision 11). LCU and the upstream application need
# a D-Bus session bus owned by the desktop account (AT-SPI accessibility runs on it). Start one at
# the fixed address the image's DBUS_SESSION_BUS_ADDRESS names, then hand over to the workspace
# image's own entry point, which starts Xvfb, the window manager, noVNC and Chromium unchanged.
set -euo pipefail

mkdir -p /run/deskmates
SOCKET="${DBUS_SESSION_BUS_ADDRESS#unix:path=}"
rm -f "$SOCKET"
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --nofork --nopidfile \
  >/tmp/deskmates-dbus-session.log 2>&1 &

exec /usr/local/bin/deskmates-entry "$@"
