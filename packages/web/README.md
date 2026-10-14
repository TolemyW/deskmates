# @deskmates/web

The operator UI, React + Vite. It signs people in, shows chats, contacts, runs, approvals, tasks
and the shared computer, and builds a standalone demo (`demo.html`) on an in-browser mock Gateway.

Rules:

- **Talks only to the Gateway** operator HTTP/SSE API
  ([`packages/gateway/docs/http-api.md`](../gateway/docs/http-api.md)) and the same-origin
  `/api/desktop-stream` WebSocket. It never fetches from a third party.
- **Imports only `@deskmates/contracts` and `@deskmates/ui`** among Deskmates packages (ADR-0025).
  Shared components belong in `@deskmates/ui`; application data, status mappings and API calls stay
  here.
- Every word a person reads comes from the message catalogs ([Languages](docs/languages.md)).
- Role checks in screens are presentation only; the Gateway refuses whatever a screen offers
  wrongly.
- Tests are colocated and run in jsdom with `fetch` and `EventSource` doubles, never a real
  Gateway.

## Source layout

Each product area is a folder `src/features/<feature>/` that owns its files:

- `route.ts`: adds its routes to the open `RouteMap` (`declare module "../../app/routes.js"`) and
  exports `routes = defineRoutes({...})`: the guide page of each route it owns (`screens`), its
  first-segment parsers, legacy redirects (`canonicalHref`) and role redirects (`shown`); plus
  its href helpers. A route module must not import a screen: screens import `router.ts`, which
  loads every `route.ts`.
- `feature.tsx`: `feature = defineFeature(routes, {...})` with its navigation entry (group,
  order, icon, label, href, active, visible, badge), an optional drawer, and
  `render(route, ctx)`.
- `api.ts`, where the feature has Gateway endpoints: `XxxApi` and `createXxxApi(transport)`, with
  a wire golden in `api.golden.test.ts` and `__golden__/api.golden.txt`.
- `demo.ts`: the feature's mock-Gateway routes, seed and `state.store`, with a golden in
  `__snapshots__/demo.golden.jsonl`.
- `messages/<locale>.json` and `messages/index.ts`: its strings, by key prefix.
- `<feature>.css`: its styles.
- `route.test.ts`, `feature.test.tsx`: its pins.

Route modules, features, demo modules and stylesheets are discovered with `import.meta.glob`,
so adding a screen or changing a feature edits only that folder. A brand-new feature adds at
most its sorted lines in `src/api/client.ts` (the `ApiClient` composition) and one in
`src/i18n/message-fragment-list.ts`.

Outside the features:

- `src/app/`: the shell: bootstrap, sign-in, invitation, shell and navigation, the route
  registry (`routes.ts`, `route-registry.ts`), the feature registry (`feature.ts`,
  `features.ts`), shell styles (`shell.css`) and shell messages (`messages/`).
- `src/platform/http-transport.ts`: the one HTTP transport every Gateway client sends through;
  feature APIs never call `fetch`. `src/api/` holds the client composition, the SSE
  subscription, the session clients and API-only shapes.
- `src/i18n/`: catalog assembly, locale choice and shared strings (`common/`).
- `src/demo/`: the mock Gateway: shared state, request router, the scripted team and the core
  seed.
- `src/styles/`: the stylesheet entry; `app.css` declares the single cascade layer order, then
  shell and feature stylesheets load by path, then `typography.css`.
- `src/components/`, `src/lib/` and `src/state/`: shared parts. A screen part with no owning
  feature, used by several (the resource page heading), lives in `src/components/`.

Screens and their tests live in the feature that owns them (`features/<feature>/<screen>.tsx`).
A part another feature also shows stays with the feature whose concept it is and is imported
from there: the approval card from `approvals`, the file preview and path links from `files`,
desktop cards from `computer`, learned memory from `knowledge`, the egress picker and workspace
switcher from `workspaces`. The shell's first-run guide is in `src/app/`. Tests that cover
several screens at once (role gates, empty states) sit beside the `app-*` tests in `src/`. There
is no `src/screens/`.

For changes that must not move what the operator sees, compare before and after with
`scripts/ui-fingerprint.mjs` ([scripts/README.md](scripts/README.md)).

## Commands

```
npm run dev:gateway                    # from the repository root; operator listener 8081
npm run dev:web                        # Vite on WEB_PORT, proxies /api, /auth and /hooks
npm run typecheck -w packages/web
npm test -w packages/web
npm run build -w packages/web          # static bundle in dist/
DESKMATES_DEMO=1 npm run build -w packages/web   # standalone demo in dist-demo/
```

Running against a local Gateway, the demo team and screenshots are in
[M0](docs/m0-foundation.md) and [Interaction upgrade](docs/interaction-upgrade-2026-10-03.md).

## Topics

Each feature documents itself in its own file under `docs/`. A new feature adds a file
`docs/<topic>.md` (kebab-case) and one line to this list, in its sorted place; it does not add
a section to this README.

- [Application design preview](docs/application-design-preview.md): HeroUI theme, typography tokens
- [Approvals (M1)](docs/approvals.md)
- [B5: knowledge and memory](docs/knowledge-and-memory.md)
- [Browser takeover (M1)](docs/takeover.md)
- [Bundled operator manual (issue #28)](docs/operator-manual.md)
- [Chat details and presentation summaries](docs/chat-details-and-approval-summaries.md)
- [Chat feedback update (2026-10-11)](docs/chat-feedback-2026-10-11.md)
- [Desktop workbench (ADR-0008)](docs/desktop-workbench.md)
- [Group threads (M2)](docs/group-threads.md)
- [Integrations (ADR-0013)](docs/integrations.md)
- [Interaction development update (2026-09-30)](docs/interaction-update-2026-09-30.md)
- [Interaction upgrade (2026-10-03)](docs/interaction-upgrade-2026-10-03.md): messaging-app shape, demo
- [Languages (issue #23)](docs/languages.md)
- [M0: thread chat, run replay, sign-in and roles](docs/m0-foundation.md)
- [Operator-maintained tasks (ADR-0021)](docs/task-management.md)
- [Owned component library (ADR-0025)](docs/component-library.md)
- [Private-chat collaboration reminders (ADR-0024)](docs/private-chat-reminders.md)
- [Product-managed chat channels (issue #43)](docs/channels.md)
- [Reload drafts and authorized receipt identities (#73/#75)](docs/reload-drafts-and-receipt-identities.md)
- [Responsive detail panes](docs/responsive-detail-panes.md)
- [Roadmap](docs/roadmap.md): bot management
- [Web interaction closeout: management and screen recovery](docs/management-and-screen-recovery.md)
