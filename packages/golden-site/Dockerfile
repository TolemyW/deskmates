# Galaxy Ops Console, the golden site. Built and run as its own container so nothing
# under test shares a process, filesystem or dependency tree with it (benchmark §8.1).
# Tag: galaxy-ops-console:<task-set version>. scripts/build-golden-site-image.sh runs
# `npm run build -w packages/golden-site` first, so dist/ exists at build time.
# The base is pinned to the tag's multi-architecture index digest (read on 2026-10-19 from the
# Docker Hub mirrors mirror.gcr.io and public.ecr.aws, which agreed), so a rebuild of the same
# task-set version gets the same base; a new base is a reviewed change to this file.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY package.json ./
COPY dist/ ./dist/
COPY fixtures/ ./fixtures/
ENV GOLDEN_SITE_HOST=0.0.0.0 GOLDEN_SITE_PORT=4477
EXPOSE 4477
CMD ["node", "dist/serve.js"]
