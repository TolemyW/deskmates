# SearXNG for the `web_search` tool (ADR-0049 decision 14): the official image, pinned to an exact
# release and to its multi-architecture index digest (read from Docker Hub on 2026-10-18), with
# Deskmates' settings preinstalled: JSON output on, the limiter and the image proxy off (the
# Gateway is the one trusted client), metrics off, listening on the host's loopback. The secret
# key is not baked in: `scripts/stable/stable.sh searxng start` passes `SEARXNG_SECRET` from the
# state directory. Nothing is downloaded when the container runs beyond the searches themselves.
#
# Build context is this directory; it copies only settings.yml:
#   scripts/build-searxng-image.sh builds it as deskmates/searxng:<arch>-<hash12>
FROM searxng/searxng:2026.10.2-a5659a536@sha256:3ef6b1d68bc981f859bb5e9a5d8c0151a4700bea23a25f36c5f353b7cf4c4de5

COPY settings.yml /etc/searxng/settings.yml

ENV SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
    SEARXNG_BIND_ADDRESS=127.0.0.1 \
    SEARXNG_PORT=18710
