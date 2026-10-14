# @deskmates/connector-postgres

A standalone connector service implementing the ADR-0012 HTTP contract (`docs/adr/0012-connector-execution-contract.md`) against one PostgreSQL-protocol database: PostgreSQL itself or a compatible server. It replaces the temporary host adapter of the compatibility campaigns: bots submit a batch of SQL cases through the Gateway's connector tools, and this service validates it, executes it and keeps the authoritative per-statement receipt.

## Responsibility

- `POST /describe`: the capabilities document. One operation, `sql_batch`, advertised as `external`; the effect of a single submission is decided by its validation. Limits, the submission schema (a batch: `batch_id`, `cases[]` with `id`, `source`, `adaptation`, `steps[]` of SQL, optional `source_lines` and `expected_source`) and the list of what is not supported.
- `POST /validate`: a dry check that never touches the database. Each step is parsed with `pgsql-ast-parser` and classified. The effect is `read` when every statement is SELECT, WITH ... SELECT, EXPLAIN (EXPLAIN ANALYZE of a read) or SHOW, else `external`. Procedures, transaction control, extensions, COPY, changes to `statement_timeout`, several statements in one step and anything the parser cannot parse are rejected with a field-specific error whose `path` names the step (`cases[1].steps[2]`). The content hash is sha256 of `canonicalJson` from contracts. Validations live in memory for the TTL.
- `POST /submit` `{validationId, contentHash, idempotencyKey}`: refused unless the validation is known (404 `connector_validation_missing`), for the same content hash (409 `connector_hash_mismatch`), younger than the TTL (409 `connector_validation_stale`) and valid (409 `connector_validation_invalid`). Idempotent on `(contentHash, idempotencyKey)`: a repeat returns the existing receipt and executes nothing, even after the validation expired or the service restarted. Without a key, the validation id is the key. The answer is the receipt at version 1, `accepted`; execution is queued.
- Execution: one batch at a time in submit order; cases in order, each on its own connection; steps in order in autocommit mode with the connection's `statement_timeout`, simple query protocol, values kept as the server's text. Each statement records `index`, `sql`, `ok`, `outcome`, `durationMs`, and either `command`, `rowCount`, `columns`, `rows` (capped, `truncated`) or `error: {sqlstate, message}`. A server error (`outcome: "error"`) does not stop the case. A statement timeout (SQLSTATE 57014) is `uncertain` and the case goes on. A connection loss (no SQLSTATE, class 08, 57P01-57P03) or a statement past the client deadline (timeout plus 5 s; the connection is dropped) is `uncertain` and ends the case; the rest are `not_run`. Nothing uncertain is ever retried. Error messages have the DSN and its password redacted.
- Receipt status: `accepted` (v1) → `running` (v2) → `succeeded` when every statement reached a definite outcome (`ok` or `error`), else `failed` (v3). Every status change is a new version. The body carries `versions`, `cases` (per-statement results; outcomes so far while running) and `detail`, a JSON string `{"summary", "cases"}`: the Gateway stores `detail` but not extra body fields, so on terminal versions `detail` is how the results reach the bot through `connector_receipt`.
- `GET /status/:receiptId` (the receipt without `cases`) and `GET /receipt/:receiptId`; 404 `not_found` for an id this connector never issued.
- Receipts live in the service's own SQLite file (`CONNECTOR_RECEIPTS_PATH`, migrations in `migrations/`), append-only: triggers refuse every UPDATE and DELETE. On start, an `accepted` receipt (nothing sent yet) runs; a `running` one is failed without resending anything, its first unrecorded statement `uncertain` and the rest `not_run`.
- `GET /healthz`: liveness, without a token.

## Rules

- Imports `@deskmates/contracts` only. Nothing imports this package; the Gateway reaches it over HTTP as a registered connector, and it is the Gateway's only way to this database (ADR-0012 item 2).
- Every route but `/healthz` requires `Authorization: Bearer $CONNECTOR_TOKEN`. The token and `CONNECTOR_DATABASE_URL` are never logged and never appear in an error message.
- Validation is static. `read` is a classification of the statement text: a user-defined function called from a SELECT can still write; only known side-effecting built-ins (`nextval`, `setval`, `set_config`, advisory locks, `lo_*`, `dblink*`, ...) make a SELECT `external`.
- The parser's PostgreSQL coverage is incomplete (for example `CREATE TABLE AS`, `SELECT INTO`, `IS UNKNOWN` do not parse). Such a statement is rejected at validation with the parser's message, never guessed at.
- No SQL domain rules in the Gateway: parsing and engine rules live here (ADR-0012 alternatives).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONNECTOR_TOKEN` | required | bearer token the Gateway sends (the connector credential in the Gateway Secrets Store) |
| `CONNECTOR_DATABASE_URL` | required | libpq-style URL of the one database |
| `PORT` / `HOST` | `8790` / `0.0.0.0` | listener |
| `CONNECTOR_RECEIPTS_PATH` | `data/connector-postgres-receipts.sqlite` | the service's own append-only receipt store |
| `CONNECTOR_NAME` | `postgres` | name in the capabilities document |
| `CONNECTOR_MAX_CASES_PER_BATCH` | 3 | cases per batch |
| `CONNECTOR_MAX_STATEMENTS_PER_CASE` | 10 | steps per case |
| `CONNECTOR_MAX_STATEMENTS_PER_BATCH` | 20 | steps per batch |
| `CONNECTOR_MAX_RESULT_ROWS` | 200 | rows kept per statement result |
| `CONNECTOR_STATEMENT_TIMEOUT_MS` | 10000 | per-statement `statement_timeout` |
| `CONNECTOR_MAX_STATEMENT_BYTES` | 16384 | bytes per step |
| `CONNECTOR_VALIDATION_TTL_SECONDS` | 900 | how long a validation may be submitted |

The limit defaults follow the host adapter's `submission-contract.json` and ADR-0012's TTL; they are guesses until a live campaign through this connector calibrates them.

## Tests

- T0/T1 (`npm test`): classifier table, limits, hash binding, validation TTL, idempotency, receipt versioning, recovery and the HTTP contract in-process with a scripted database client (`src/test-support/fake-sql.ts`), read back with the same `parseConnector*` functions the Gateway's `ConnectorProxy` applies.
- T2 (`npm run test:container`): `src/service.container.test.ts` starts `postgres:16` in Docker and runs a mixed batch (DDL, INSERT, SELECT, a failing statement, a `pg_sleep` past the timeout), a repeat submit and a restart.

## Known limits

- Result rows are fetched whole and then capped; a statement returning a huge result is bounded only by the statement timeout and memory.
- One batch runs at a time; a long batch delays the next one's `running`.
- `sslmode` and other TLS options come from the DSN and are interpreted by `pg`, not libpq.
