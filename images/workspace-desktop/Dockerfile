# Optional desktop variant of the workspace image (ADR-0048 decision 11): the content-addressed
# workspace image plus the pinned LCU release and the pinned upstream desktop application, so a
# workspace's bots can be given the opt-in native desktop tools. BUILT LOCALLY ONLY, NEVER
# PUBLISHED (decision 12: the upstream application's terms are not settled). The release workflow
# and the stable scripts never name this directory; `dockerfile.test.mjs` checks that.
#
# Build it with scripts/build-workspace-desktop-image.sh, which checks the pins in pins.env and
# passes them here. The two upstream inputs come from images/workspace-desktop/inputs/ (git
# ignored), placed there by the operator and verified by SHA-256 before anything is installed. The
# application's Debian dependencies come from the package registry at build time; nothing is
# downloaded when a container runs. No capability, device or user-namespace permission is added
# (decision 9): LCU's inner sandbox stays unavailable and no boundary is claimed for it. `xinput`
# is the reader of the display's raw input events the desktop proxy counts per call (amendment 1,
# A5); it records counts only.

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG LCU_VERSION
ARG LCU_SHA256
ARG APP_VERSION
ARG APP_SHA256
ARG LCU_ARCHIVE=lcu-${LCU_VERSION}-linux-x64.tar.gz
ARG APP_PACKAGE=chatgpt-${APP_VERSION}-amd64.deb

COPY inputs/${LCU_ARCHIVE} inputs/${APP_PACKAGE} /tmp/desktop-inputs/
COPY desktop-entry.sh /usr/local/bin/deskmates-desktop-entry

RUN set -eu \
 && test -n "${LCU_SHA256}" && test -n "${APP_SHA256}" \
 && echo "${LCU_SHA256}  /tmp/desktop-inputs/${LCU_ARCHIVE}" | sha256sum -c - \
 && echo "${APP_SHA256}  /tmp/desktop-inputs/${APP_PACKAGE}" | sha256sum -c - \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "/tmp/desktop-inputs/${APP_PACKAGE}" dbus-x11 at-spi2-core xinput \
 && mkdir -p /tmp/desktop-inputs/lcu \
 && tar -xzf "/tmp/desktop-inputs/${LCU_ARCHIVE}" -C /tmp/desktop-inputs/lcu --strip-components=1 \
 && cd /tmp/desktop-inputs/lcu \
 && ./scripts/install.sh --user root --runtime-only --skip-system --existing-app /usr/lib/chatgpt \
 && test -x /opt/lcu/current/bin/lcu \
 && cd / \
 && chmod 0755 /usr/local/bin/deskmates-desktop-entry \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/desktop-inputs

LABEL org.deskmates.capabilities="desktop-lcu-v1" \
      org.deskmates.desktop.lcu-version="${LCU_VERSION}" \
      org.deskmates.desktop.app-version="${APP_VERSION}"

ENV DESKMATES_IMAGE_CAPABILITIES=desktop-lcu-v1 \
    DESKMATES_DESKTOP_LCU_COMMAND=/opt/lcu/current/bin/lcu \
    DESKMATES_DESKTOP_LCU_ARGS="" \
    DESKMATES_DESKTOP_LCU_VERSION=${LCU_VERSION} \
    DESKMATES_DESKTOP_APP_VERSION=${APP_VERSION} \
    DESKMATES_DESKTOP_INPUT_RECORDER="stdbuf -oL xinput test-xi2" \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/deskmates/dbus-session \
    LCU_SESSION_MODE=direct \
    LCU_NO_UPDATE_CHECK=1

ENTRYPOINT ["/usr/local/bin/deskmates-desktop-entry"]
