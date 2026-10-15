# Deskmates workspace base image: the Linux desktop, the browser and every preinstalled tool, with
# nothing of Deskmates's own code. images/workspace/Dockerfile builds FROM this and adds only the
# sidecar, contracts and entry scripts (~0.5 MB), which needs no network and takes seconds. The
# base changes only when a pin or the tool list below changes, so a release normally moves the
# app layer alone (docs/runbooks/stable-release.md).
#
# Build context is this directory; it copies nothing:
#   scripts/build-workspace-image.sh builds it on demand as deskmates/workspace-base:<arch>-<hash12>
# Everything a run needs is installed here; nothing downloads at run time (S0: npx inside the
# container timed out, so MCP/CLI/SDK are preinstalled globally).
#
# The four Playwright-family pins below must agree with each other and with AGENTS.md.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

ARG PLAYWRIGHT_VERSION=1.58.2
ARG PLAYWRIGHT_MCP_VERSION=0.0.82
ARG PLAYWRIGHT_CLI_VERSION=0.1.21
ARG AGENT_SDK_VERSION=0.3.278
ARG NODE_PTY_VERSION=1.1.0

ENV DEBIAN_FRONTEND=noninteractive
# An Ubuntu mirror for hosts where the official archive is slow (stable.sh passes APT_MIRROR from
# the deployment's .env, e.g. https://mirrors.tuna.tsinghua.edu.cn/ubuntu). Empty keeps the image's
# own sources, which is what the release workflow builds. Package versions do not depend on it.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
        [ -f "$f" ] && sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" "$f"; \
      done; \
    fi; true
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb fluxbox x11vnc novnc websockify xdotool imagemagick \
    postgresql-client git gh python3 make g++ curl ca-certificates procps \
    poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf vnc.html /usr/share/novnc/index.html

RUN npm install -g --no-fund --no-audit \
    "node-pty@${NODE_PTY_VERSION}" \
    "playwright@${PLAYWRIGHT_VERSION}" \
    "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
    "@anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION}" \
    "@anthropic-ai/claude-agent-sdk-linux-$(node -p process.arch)@${AGENT_SDK_VERSION}" \
 && npm cache clean --force

# npm may omit a failed optional native install while reporting SDK installation success.
# Make the matching CLI required above and prove the SDK can resolve and execute it offline.
RUN node -e 'const {createRequire}=require("node:module"); const {execFileSync}=require("node:child_process"); const root=execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim(); const sdkRequire=createRequire(root+"/@anthropic-ai/claude-agent-sdk/package.json"); const cli=sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-"+process.arch+"/claude"); process.stdout.write(execFileSync(cli,["--version"],{encoding:"utf8",timeout:30000}));'

ARG UNDICI_VERSION=7.29.1
RUN npm install -g --no-fund --no-audit "undici@${UNDICI_VERSION}" \
 && npm cache clean --force
