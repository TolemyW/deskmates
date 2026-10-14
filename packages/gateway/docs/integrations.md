# Integrations (ADR-0013)

SaaS actions come from an integration runtime (OpenConnector, pinned by image digest) that runs as
its own container on a network only the Gateway reaches. `src/integrations/runtime-adapter.ts` is
the only file that knows its routes and its five meta-tool names; a T0 grep
(`static-boundary.test.ts`) keeps them out of the rest of `packages/`. Nothing is offered to runs
unless `INTEGRATION_RUNTIME_URL` and `INTEGRATION_RUNTIME_ADMIN_TOKEN` are both set; OAuth grants
also need `INTEGRATION_OAUTH_CALLBACK_URL`, the public URL of the callback route below. Runs whose
config carries `integrationVersion: 1` and whose workspace has at least one usable connection get
the five tools; the start request carries only that count.

The runtime has no tenant field (Amendment 1), so migration `0017` is the truth for which
workspace owns which runtime connection. Each workspace has one runtime token, held encrypted in
the Secrets Store (`secrets.owner_kind = 'workspace'`), whose `allowedConnections` and
`allowedActions` the Gateway rewrites whole on every connection or adoption change. An empty grant
list means "every connection" to the runtime, so a workspace left with none has its token revoked.
Runtime connection names are `g<10 hex of sha256(workspaceId)>-<name>`; bots only see `<name>`.
No column holds an API key, OAuth token, client secret or runtime token; an OAuth `state` is kept
only as its sha256.

Operator routes (authenticated): `GET /api/integrations` (`{configured, oauthAvailable,
providers}`), `POST /api/integrations/providers {service, displayName?}` (adopt; checked against
the runtime), `DELETE /api/integrations/providers/:service`, `PUT
/api/integrations/providers/:service/oauth-app {clientId, clientSecret, requestedScopes?}` (sets
our callback as `redirectUri`; the secret goes to the runtime only), `GET
/api/integrations/workspaces/:workspaceId/connections?status=&offset=&limit=` (one page, oldest first, 25 a page, with `total` and the whole workspace's `liveByService` counts, #113), `POST .../connections/api-key {service,
connectionName, apiKey, values?}`, `POST .../connections/oauth/start {service, connectionName}`
(`{authorizationUrl}`, refused when the provider's app does not redirect to our callback), `DELETE
.../connections/:connectionId` (grant first, then the credential), `GET
/api/integrations/actions/overrides`, `PUT /api/integrations/actions/:actionId/override
{lowerableToL1?, neverLowerable?}` (only a catalog `write` may be lowered;
`googledrive.permissions.create` and `.update` are seeded never lowerable).

`GET /api/integrations/oauth/callback` sits on the operator listener outside the Bearer scope,
because the provider redirects a browser to it. The one-time `state` of a grant started here is its
credential: unknown, used or expired is 401 and nothing is forwarded. Otherwise `code` and `state`
go to the runtime, the new connection is recorded for the workspace the state was issued for, and
an HTML page says so.

Run routes under `/internal/runs/:runId/integrations/` (own scope: dead token 401, another run's
403): `GET apps` (adopted providers from the Gateway's table; the runtime's app list is never
forwarded), `GET connections?service=` (the workspace's own, virtual no-auth entries dropped),
`POST search {service, query?, limit?}` (service required, at most 5 results, adopted providers
only), `POST guide {actionId, connectionName?}`, `POST execute {actionId, connectionName?,
input}`, and `GET actions/:actionId/tier?connectionName=`, which the PreToolUse hook reads. A
connection that is not the run's workspace's own is `403 integration_connection_not_allowed`
before the runtime is asked; a provider not adopted is `409 integration_not_adopted`; an
unreachable runtime `503 integration_unavailable`; an unreadable answer `502
integration_protocol`. Every run call writes a `tool_call` / `tool_result` pair with `source:
"integration_proxy"`, the bot, service, action id, connection name, operationType and, for
execute, the runtime's execution id; refusals are attributed too.
