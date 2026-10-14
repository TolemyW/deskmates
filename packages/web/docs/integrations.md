# Integrations (ADR-0013)

`#/integrations` (`src/features/integrations/integrations.tsx`) renders its Featured section only from providers
the configured runtime reports plus the built-in PostgreSQL connector. It never invents a
coming-soon card. The complete live catalog remains reachable through search, category filters and
paging; cards distinguish Connected, Available and Needs admin using the current role. Bundled
logos are release-local under `public/integration-logos/`; `manifest.json` records the source and
license of every asset, and unknown providers use a letter tile.

The catalog supports adopt and unadopt, and one workspace's connections support revoke. "Connect
with OAuth" asks the Gateway to start a grant for the chosen workspace, service and connection
name, then opens the returned authorization URL in a new tab with `noopener`: the provider sends
that tab to the Gateway's `/api/integrations/oauth/callback`, not back into the app, so refresh the
list after consenting. The API-key form posts the key once and clears it; no Gateway response
carries a key back. Without a configured runtime the screen says so and offers nothing.
