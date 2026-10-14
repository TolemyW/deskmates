# The PostgreSQL-protocol connector (packages/connector-postgres): a standalone service the Gateway
# calls over the ADR-0012 contract. Build context is the repository root; the sibling
# Dockerfile.dockerignore admits only what is copied here. scripts/build-connector-postgres-image.sh
# builds contracts and the connector first, so both dist/ directories exist.
#
# Dependencies are installed from the root lockfile at build time (versions pinned there); nothing
# is downloaded when the container runs. npm ci needs every workspace's package.json to see the
# lockfile in sync, so all of them are copied; only the connector's production dependencies are
# installed.

FROM node:22-bookworm-slim AS deps
# better-sqlite3 downloads a prebuilt binary and compiles from source when that fails (seen on
# colima: the GitHub download timed out). The toolchain stays in this stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/deskmates
COPY package.json package-lock.json ./
COPY packages/channels/package.json packages/channels/package.json
COPY packages/channels/deskmates-agent-mcp/package.json packages/channels/deskmates-agent-mcp/package.json
COPY packages/connector-postgres/package.json packages/connector-postgres/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/golden-site/package.json packages/golden-site/package.json
COPY packages/sandbox-docker/package.json packages/sandbox-docker/package.json
COPY packages/sidecar/package.json packages/sidecar/package.json
COPY packages/testkit/package.json packages/testkit/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --omit=dev --workspace @deskmates/connector-postgres --include-workspace-root=false \
      --no-audit --no-fund \
 && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && test -f node_modules/pg/package.json \
 && test -f node_modules/pgsql-ast-parser/package.json

FROM node:22-bookworm-slim
WORKDIR /opt/deskmates
# Build artifacts can be mode 0600/0700 under an operator's restrictive umask.
# Give the runtime user ownership rather than relying on world-readable host modes.
COPY --from=deps --chown=node:node /opt/deskmates/node_modules ./node_modules
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/contracts/dist packages/contracts/dist
COPY --chown=node:node packages/connector-postgres/package.json packages/connector-postgres/package.json
COPY --chown=node:node packages/connector-postgres/dist packages/connector-postgres/dist
COPY --chown=node:node packages/connector-postgres/migrations packages/connector-postgres/migrations

RUN mkdir -p /var/lib/deskmates-connector \
 && chown node:node /var/lib/deskmates-connector

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    CONNECTOR_RECEIPTS_PATH=/var/lib/deskmates-connector/receipts.sqlite

USER node
VOLUME /var/lib/deskmates-connector
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/deskmates/packages/connector-postgres/dist/index.js"]
