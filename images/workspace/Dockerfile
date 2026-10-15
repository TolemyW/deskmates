# Deskmates workspace image: one container per group of bots (ADR-0004). It is the base image
# (images/workspace-base: desktop, browser, SDK, MCP, CLI, tools) plus Deskmates's own files. Nothing
# below downloads anything, so it builds offline in seconds wherever the base image is present.
# Build context is the repository root; .dockerignore admits only what is copied here:
#   scripts/build-workspace-image.sh   (builds or reuses the base, then this, content-addressed)
#   docker build --build-arg BASE_IMAGE=<base image> -f images/workspace/Dockerfile .
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
LABEL deskmates.desktop.mode="shared-monitors-v1"

# The sidecar and its only workspace dependency. `dist/` may be empty on a checkout that has not
# built the sidecar yet; the shim fails at run time, the rest of the image still works.
# ESM ignores NODE_PATH, so the globally installed packages are linked into /opt/deskmates/node_modules
# where Node's resolver finds them from /opt/deskmates/sidecar/dist. The global root is wherever the
# base image put Node (/usr/lib/node_modules on the Playwright image), so ask npm rather than guess.
COPY packages/contracts /opt/deskmates/contracts
COPY packages/sidecar /opt/deskmates/sidecar
COPY packages/gateway/starter-skills /opt/deskmates/starter-skills
RUN G="$(npm root -g)" \
 && mkdir -p /opt/deskmates/node_modules/@deskmates /opt/deskmates/node_modules/@anthropic-ai /opt/deskmates/node_modules/@playwright \
 && ln -s /opt/deskmates/contracts /opt/deskmates/node_modules/@deskmates/contracts \
 && ln -s "$G/@anthropic-ai/claude-agent-sdk" /opt/deskmates/node_modules/@anthropic-ai/claude-agent-sdk \
 && ln -s "$G/@playwright/mcp" /opt/deskmates/node_modules/@playwright/mcp \
 && ln -s "$G/@playwright/cli" /opt/deskmates/node_modules/@playwright/cli \
 && ln -s "$G/node-pty" /opt/deskmates/node_modules/node-pty \
 && ln -s "$G/undici" /opt/deskmates/node_modules/undici \
 && ln -s "$G/playwright" /opt/deskmates/node_modules/playwright \
 # The OpenAI Agents SDK runtime (ADR-0042) and the MCP client it attaches the sidecar's tools
 # with; both are preinstalled in the base image like the Claude Agent SDK.
 && mkdir -p /opt/deskmates/node_modules/@openai /opt/deskmates/node_modules/@modelcontextprotocol \
 && ln -s "$G/@openai/agents" /opt/deskmates/node_modules/@openai/agents \
 && ln -s "$G/@modelcontextprotocol/sdk" /opt/deskmates/node_modules/@modelcontextprotocol/sdk \
 # zod is a sidecar dependency (thread tools); npm nests it under the SDK's global install.
 && Z="$G/@anthropic-ai/claude-agent-sdk/node_modules/zod" && { [ -d "$Z" ] || Z="$G/zod"; } \
 && ln -s "$Z" /opt/deskmates/node_modules/zod \
 && test -f /opt/deskmates/node_modules/zod/package.json \
 && test -f /opt/deskmates/node_modules/@openai/agents/package.json \
 && test -f /opt/deskmates/node_modules/@modelcontextprotocol/sdk/package.json \
 && test -f /opt/deskmates/node_modules/playwright/package.json \
 && test -f /opt/deskmates/node_modules/undici/package.json \
 && test -f /opt/deskmates/node_modules/@playwright/mcp/package.json \
 && test -f /opt/deskmates/node_modules/@anthropic-ai/claude-agent-sdk/package.json

COPY images/workspace/patch-mcp-tab-identity.mjs /opt/deskmates/patch-mcp-tab-identity.mjs
RUN node /opt/deskmates/patch-mcp-tab-identity.mjs /opt/deskmates

COPY images/workspace/entry.sh /usr/local/bin/deskmates-entry
COPY images/workspace/close-browser.mjs /usr/local/lib/deskmates/close-browser.mjs
COPY images/workspace/deskmates-sidecar /usr/local/bin/deskmates-sidecar
COPY images/workspace/deskmates-healthz /usr/local/bin/deskmates-healthz
# Managed browser policy: secure-DNS auto-upgrade, safe browsing, metrics and update checks off.
# Chromium reads /etc/chromium/policies/managed; Chrome-branded builds read /etc/opt/chrome.
COPY images/workspace/chromium-policy.json /etc/chromium/policies/managed/deskmates.json
COPY images/workspace/chromium-policy.json /etc/opt/chrome/policies/managed/deskmates.json
RUN chmod 0755 /usr/local/bin/deskmates-entry /usr/local/bin/deskmates-sidecar /usr/local/bin/deskmates-healthz \
 && test -f /opt/deskmates/starter-skills/manifest.json \
 && mkdir -p /profile /work /run/deskmates

ENV DISPLAY=:99 \
    DESKMATES_CDP_URL=http://127.0.0.1:9222 \
    DESKMATES_ENV_FILE=/run/deskmates/env \
    DESKMATES_SCREEN=1280x720x24

# 6080 noVNC (published to the Gateway host), 9222 Chromium CDP (container-local only).
EXPOSE 6080 6081 6082 6083 6084 6085 6086
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/deskmates-healthz"]
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/deskmates-entry"]
