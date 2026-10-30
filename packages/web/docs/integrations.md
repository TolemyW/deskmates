# Connections › Apps (ADR-0013)

Since 2026-10-22 this is the **Apps** tab of Connections, `#/connections/apps`
(`src/features/integrations/apps-tab.tsx`); `#/integrations` redirects there. The runtime's
catalog can hold hundreds of providers, so the tab follows the "Apps at scale" rules of
[the Connections redesign](../../../docs/design/connections-redesign-2026-10-22.md): **In use**
first (from the workspace-wide `liveByService` counts, with the paged accounts behind a
disclosure), a search over every provider, then `listedApps`: only adopted, not yet connected
providers unless searching or the maintainer includes the rest in the Tune view, featured first
(`FEATURED_SERVICES`), then A to Z, 24 at a time with Show more. Category chips show counts and hide
empty categories. Each card has at most one action for the viewer's role; an unadopted provider
says "Needs the maintainer" instead of showing an Adopt button others cannot use. It never invents
a coming-soon card. Bundled logos are release-local under `public/integration-logos/`;
`manifest.json` records the source and license of every asset, and unknown providers use a letter
tile.

The catalog supports adopt and unadopt, and one workspace's connections support revoke. "Connect
with OAuth" asks the Gateway to start a grant for the chosen workspace, service and connection
name, then opens the returned authorization URL in a new tab with `noopener`: the provider sends
that tab to the Gateway's `/api/integrations/oauth/callback`, not back into the app, so refresh the
list after consenting. The API-key form posts the key once and clears it; no Gateway response
carries a key back. Without a configured runtime the screen says so and offers nothing.
