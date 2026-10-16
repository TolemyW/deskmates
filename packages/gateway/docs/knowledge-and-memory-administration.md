# B5: reviewed knowledge and memory administration

`/api/knowledge` lists published documents or searches them with `?q=` (FTS5).
`/api/knowledge/proposals` lists pending drafts or accepts `POST {title, body}`.
Lists page on the server (#113): documents and proposals by an opaque `cursor`
(`updated_at`/`created_at DESC, id DESC`, `total` counts the whole list or queue), a search by
`offset` over the rank (`bm25, id`, `total` counts every match). `limit` defaults to 25 and a
value above 100 is refused with 400, never clamped; a cursor of another list or status is
refused too. The run tool's `/internal/.../knowledge/search` keeps its top-five answer.
`POST /api/knowledge/proposals/:id/review` accepts `{decision: "approve" | "reject"}`.
`GET /api/knowledge/:id`, `PATCH {title, body, version}` and `GET .../export` read,
conditionally edit and export published Markdown. All are operator-authenticated.
Approval publishes an immutable Markdown version alongside the Gateway database in `knowledge/`;
the file and directory are synced before the SQLite publication/index transaction commits.
Back up that directory with the database. Unreferenced version files are harmless and currently
retained; direct filesystem edits are not an import mechanism. Review history keeps source run
and reviewer attribution. Knowledge is shared across bots after publication, not workspace-private.

Run-token routes under `/internal/runs/:runId/knowledge` expose only search, approved-document
read and draft submission. The server assigns source-run provenance; no bot review route exists.
Raw FTS expressions are never accepted. Queries are capped at 500 characters, documents at 64 KiB.

`GET /api/bots/:id/memory`, `PATCH {body, expectedVersion}` and `GET .../export` manage only that
bot's `MEMORY.md`. The canonical body is a Gateway column (migration 0019), written with a SHA-256
version check (another edit in between is 409); the sidecar writes it into the bot's home at the
start of every attempt. A live or parked run of the bot does not refuse the write: the answer
carries `appliesFromNextRun: true` and the run's next attempt gets the new body (ADR-0043 decision
3). Every changed body is a numbered version in `bot_rule_versions` with a `bot.update` audit row
holding the hashes and the version number, never the text; `GET /api/bots/:id/rule-versions/memory`
lists them and a restore writes an older one as a new version. Empty content clears memory. This protects operator edits in the single-Gateway
runtime, not against a bot or a manual process modifying the same shared workspace (ADR-0004).
Run-summary memory suggestions remain suggestions; they are not automatically applied.
