# The base is pinned to the tag's multi-architecture index digest (read on 2026-10-19 from the
# Docker Hub mirrors mirror.gcr.io and public.ecr.aws, which agreed), so a new base is a change
# here that scripts/image-tag.mjs sees, never a silent rebuild drift.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

COPY images/egress/egress-policy.mjs /opt/deskmates/egress-policy.mjs
COPY images/egress/doh-lookup.mjs /opt/deskmates/doh-lookup.mjs
COPY images/egress/host-target.mjs /opt/deskmates/host-target.mjs
COPY images/egress/lan-grants.mjs /opt/deskmates/lan-grants.mjs
COPY images/egress/egress-probe.mjs /opt/deskmates/egress-probe.mjs
COPY images/egress/app-relay.mjs /opt/deskmates/app-relay.mjs
COPY images/egress/screen-relay.mjs /opt/deskmates/screen-relay.mjs
COPY images/egress/private-expiry.mjs /opt/deskmates/private-expiry.mjs
COPY images/egress/socket-guard.mjs /opt/deskmates/socket-guard.mjs
COPY images/egress/egress-proxy.mjs /opt/deskmates/egress-proxy.mjs

RUN mkdir -p /run/deskmates-egress \
 && chown -R node:node /run/deskmates-egress /opt/deskmates

USER node
EXPOSE 3128 6080 6081 6082 6083 6084 6085 6086 6090
ENTRYPOINT ["node", "/opt/deskmates/egress-proxy.mjs"]
