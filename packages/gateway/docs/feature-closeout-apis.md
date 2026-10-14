# M1/M2 feature closeout operator APIs

- `GET /api/costs`: UTC run-creation date, bot and model filters; known/partial/unknown cost totals
  and days over the whole range, never rows (#113).
- `GET /api/costs/rows?cursor=&limit=` (same filters): the Activity rows, one keyset page at a time
  (`day DESC, botName, botId, model`), ten a page, at most 100, with the row count (#113).
- `GET /api/costs/ranking?by=&metric=&offset=&limit=`: one ranking page (ADR-0032), ten by default.
- Cost alerts (ADR-0018): `cost_alert_rules` and `cost_alerts` (migration `0024`), evaluated in
  `RunLifecycle.ended` right after `UsageStore.record`, inside the same transaction, through the
  cost report's own window query; at most one alert per `(rule, UTC window)`. A firing writes the
  alert row, a `cost_alert` run event on the crossing run and a `cost_alert` SSE frame. Rules are
  operator data, not run knobs, and nothing about scheduling reads them.
- Channel plugins (ADR-0017 amendment 1): `CHANNEL_PLUGIN_MANIFEST` names the release-bundled,
  fully hashed manifest produced by `packages/channels`; the Gateway verifies every listed module
  before dynamically importing its versioned `ChannelPlugin` entry point. There is no runtime
  download or provider import/branch. `GET /api/channels` exposes the generic catalog and load
  failures; workspace routes under `/api/workspaces/:id/channels` connect, list and command one
  connection per plugin; `/api/channel-webhooks/:workspaceId/:pluginId` passes the untouched body
  to the plugin. Secret fields live only in the encrypted Secrets Store. Non-secret connection
  state is migration `0053`; private runtime files use `CHANNEL_STATE_DIR` (default
  `./data/channels`). A plugin failure degrades that channel without stopping ordinary Gateway
  routes.
- `GET/PATCH /api/bots/:id/soul` and `GET /api/bots/:id/soul/export`: the Gateway owns the
  canonical SOUL body (ADR-0011 A5). New bots can be configured while their workspace is stopped;
  older bots first import their physical file when the workspace is available. SHA-256 versions
  guard edits. A changed body invalidates that bot's sessions; its active or parked run blocks an
  edit until it finishes. The canonical body is delivered again at the next run boundary.
- `GET /api/memory-suggestions`, `POST /api/memory-suggestions/:id/review`: sourced, explicit
  apply/reject review. A completed run creates suggestions, never silently edits memory.
- Knowledge/proposal listing supports bounded cursors; `GET /api/knowledge/:id/history`
  reads immutable versions; `POST /api/knowledge/versions/cleanup` removes unreferenced files.
- `GET /api/workspaces/:id` includes `capacity` with actual in-flight attempts, configured
  limit and capacity-waiting run IDs. The cap includes a parked process until its exec exits.
- Run-token-only browser retention routes issue workspace-scoped cleanup candidates and audit
  exact closes. Policy defaults retain 20 fresh completed tabs for at most 24 hours.

All operator routes remain inside operator authentication. See
`docs/runbooks/m1-m2-feature-closeout-test-handoff-2026-09-23.md` for independent integration tests.
