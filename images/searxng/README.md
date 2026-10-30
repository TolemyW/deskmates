# SearXNG image

The search service behind the `web_search` tool (ADR-0049 decision 14): the official SearXNG
image, pinned to an exact release and index digest, with `settings.yml` copied in. The settings
turn JSON output on (the Gateway asks for `format=json`), switch the limiter, the image proxy and
metrics off, and bind to `127.0.0.1`: the Gateway's search proxy on the same host is the only
client, and no workspace container can reach the instance.

The secret key is not in the image. `scripts/stable/stable.sh searxng init` writes a random one
into `<stable root>/searxng/env` (0600); `start` passes that file with `--env-file`, runs one
container on the host network on `SEARCH_PORT` (default 18710) and mounts
`<stable root>/searxng/cache` as `/var/cache/searxng`. The Gateway then needs
`SEARCH_URL=http://127.0.0.1:18710` in `shared/.env`.

Engines are SearXNG's defaults. Which public engines a query reaches, and so where query text
goes, is the operator's choice of the instance's settings, outside Deskmates.

Not verified on Docker when this was written: the image was not built or started on the authoring
host. `images/searxng/dockerfile.test.mjs` checks the pin and the settings without Docker.
