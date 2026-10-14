# Connectors (ADR-0012)

The Gateway is the only caller of a connector. `src/connectors/` holds the registry
(`registry.ts`), stored validations (`validations.ts`), authoritative receipts (`receipts.ts`)
and the proxy (`connector-proxy.ts`); `src/secrets/secrets-store.ts` encrypts values it must read
back with `GATEWAY_SECRETS_KEY` (AES-256-GCM). Migration `0016` extends the 0001 `connectors`
table with its workspace and a `secret_id`; the URL and credential live only in `secrets`, so a
database dump holds neither. Without a secrets key, registration is 400.

Operator routes: `POST /api/connectors {workspaceId, name, url, credential?, kind?, publicUrl?}`
(201 `{connector}`), `GET /api/connectors?workspaceId=&offset=&limit=` (one page, oldest first, 25 a page, with `total`, #113), `GET /api/connectors/:id`. No response
carries the URL or credential. A URL marked `publicUrl` must name a public host
(`isPublicHostname`, name-level only); an unmarked URL may be private, reachable because the
Gateway calls it. Registration never changes the workspace's egress allowlist.

Run routes under `/internal/runs/:runId/connectors/:connector/` (`:connector` is an id or a name
in the run's workspace): `POST describe`, `POST validate {submission}`, `POST submit
{validationId, contentHash, idempotencyKey?}`, `GET status/:receiptId`, `GET receipt/:receiptId`,
and `GET validations/:validationId`, which the PreToolUse hook reads to tier a submit by the stored
effect class. These sit in their own scope: a missing or dead token is 401, another run's valid
token 403, another workspace's connector 403.

The Gateway hashes every submission (`sha256(canonicalJson)`), forwards it with the credential
as a Bearer header and stores the connector's verdict with `expiresAt = now + TTL`
(`CONNECTOR_VALIDATION_TTL_SECONDS`, default 900, recorded in `runs.config_json` with
`connectorVersion: 1`). A submit is refused with a typed 409 when the validation is missing,
belongs to another connector, names another hash, has expired or found errors. A repeat with the
same connector, hash and idempotency key (default: the validation id) returns the stored receipt
and the connector is not called; concurrent repeats share one call. Receipts are one header row
plus one immutable row per connector version; triggers refuse UPDATE and DELETE. `status` and
`receipt` append a version when the connector reports a newer one and always answer from the
Gateway's record.

Every connector call writes a `tool_call` / `tool_result` pair to the run's ledger with
`source: "connector_proxy"`, the connector id and name, the bot id and, for submit, validation id,
content hash, idempotency key, receipt id and `duplicate`. `tool_result` carries the raw result
or the typed error. These are Gateway-authored and sit alongside the sidecar's own SDK-derived
tool events for the same call.
