FROM node:22-bookworm-slim

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
