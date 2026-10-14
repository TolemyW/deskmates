# Galaxy Ops Console, the golden site. Built and run as its own container so nothing
# under test shares a process, filesystem or dependency tree with it (benchmark §8.1).
# Tag: galaxy-ops-console:<task-set version>. scripts/build-golden-site-image.sh runs
# `npm run build -w packages/golden-site` first, so dist/ exists at build time.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY dist/ ./dist/
COPY fixtures/ ./fixtures/
ENV GOLDEN_SITE_HOST=0.0.0.0 GOLDEN_SITE_PORT=4477
EXPOSE 4477
CMD ["node", "dist/serve.js"]
