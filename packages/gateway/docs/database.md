# Database and migrations

The Gateway keeps its state in one SQLite file (`DATABASE_PATH`), opened in WAL mode with foreign
keys on (`src/db/open.ts`). The schema review behind the current layout is
[schema-review-2026-10-13.md](../../../docs/design/schema-review-2026-10-13.md); the decisions
are [ADR-0030](../../../docs/adr/0030-timestamped-migration-identifiers.md) and
[ADR-0031](../../../docs/adr/0031-schema-baseline-reset.md).

## Migrations

- Files are `migrations/YYYYMMDDHHmm-slug.sql` (UTC authoring time), applied once each in
  filename order inside their own transaction and recorded in `schema_migrations`.
- The first file is the schema baseline. It replaced the legacy `NNNN-` migrations when the only
  long-lived deployment was wiped (ADR-0031 decision 1).
- At open the loader refuses, before applying anything and without changing the file:
  a database created by the legacy migrations or holding tables without `schema_migrations`
  (pre-baseline); a database migrated by a newer Gateway; a pending migration that sorts before
  the newest applied one. It never deletes, moves or recreates a database.
- A migration that rebuilds a table other tables reference starts with the line
  `-- deskmates:foreign-keys-off`; it then runs with enforcement off and must leave
  `foreign_key_check` clean before it commits.
- `scripts/check-migration-order.mjs` runs in CI: a branch's new migrations sort after the
  target's newest, and no merged migration is renamed or deleted (the baseline change was the one
  exception).

## Backup and restore

`backupDatabase` writes a copy plus a manifest (hash, applied migrations, row counts).
`restoreDatabase` checks the manifest first and refuses a pre-baseline backup or one written by
a newer Gateway without moving the current database aside; a restore it accepts revokes every
session, run token, invitation and service-principal token the copy carried.

## Audit record

`audit_events` (ADR-0031 decision 11) is append-only: triggers refuse every update and delete,
and its `workspace_id` has no foreign key, so the record outlives a purged workspace. The writer
is `src/audit/audit-log.ts` (`ctx.audit`); `audit_actions` lists the actions and must equal
`AUDIT_ACTIONS` (`db/schema-conventions.test.ts`).

One row is written in the transaction that makes the change, for:

- every approval decision, by a person, a bot or a stored rule (`ApprovalStore`);
- approval rules created and deleted; egress allowlist replacements, an "allow this site" answer
  included; workspace create, archive, restore and purge;
- bot create, configuration update (model, reasoning, avatar, connectors, allowlist, cron) and
  SOUL edits (version only), archive, restore and purge;
- cost alert rules; connectors, integration connections and channel connections; service
  principals (create, disable, rotate); memberships and invitations.

Channel connect and disconnect are recorded right after the plugin's own commit, because the
plugin connects asynchronously. Personal preferences, profile, avatar and password changes are
not audited. Values are redacted by field name (`secret`, `token`, `password`, `cookie`,
`credential`, `apiKey`, `authorization`, `body`), and connector URLs are never recorded. There is
no API or page yet.

## People, roles and the protected root (issue #116 foundation)

- `users` and `user_logins` are the account; `tenant_memberships` admits an account to the
  installation domain and has no role (ADR-0031 Q1). `workspace_memberships` holds a role per
  workspace: `owner`, `admin`, `member` or `guest` (`src/workspaces/memberships.ts`). Every change
  is audited and bumps its `auth_version`; a workspace never loses its last active Owner.
- Route authorization reads roles per workspace: the guard checks the caller's role in the
  workspace of every identifier a route names; a route naming no workspace uses the caller's
  highest role in any workspace of the tenant (`member` when none is higher). Guest has no
  authority on existing routes yet; the four-role matrix is the #116 lane.
- Creating a workspace makes its creator Owner in the same transaction; doing so needs Admin or
  Owner of some workspace, or the root. Invitations, created accounts and role changes name one
  workspace (`workspaceId`, or the tenant's only active workspace).
- The protected root account is `users.is_protected = 1`, unique, designated at creation and
  never by name. Triggers make it Owner of every existing and new workspace and refuse demoting,
  removing, disabling or re-designating it. On an empty database the Gateway creates it at start
  as login `admin`, password `admin`, with `local_credentials.must_change = 1`: every `/api`
  route answers 403 `password_change_required` until `POST /auth/password` changes it. The CLI's
  `bootstrap-owner` creates it with a chosen login and password before first start instead.
- `threads.private_to_user_id` records a private audience: a person's side chat is readable by
  that person only (service principals' side chats stay shared, owner answer Q5). Enforcement on
  reads and streams is the #116 audience lane.
- `board_posts` and the immutable `board_post_versions` are the workspace message board
  (`src/board/board-store.ts`); no route serves it yet.

## Schema conventions

Every table follows ADR-0031 decision 5; `src/db/schema-conventions.test.ts` checks them over the
migrated schema:

- entity ids `<prefix>_<32 hex>` from `newId()`; append-only logs an integer key;
- timestamps `*_at TEXT`, ISO-8601 UTC with milliseconds;
- booleans `INTEGER` with `CHECK (x IN (0, 1))`;
- `*_json` columns are validated JSON read whole; a field the Gateway filters on is a column
  (`runs.run_type`, `runs.continuation_expires_at`, `runs.resume_approval_id` and
  `run_events.source` are generated columns over the JSON the run already records); a list of ids
  is a link table (`task_threads`, `task_runs`, `task_artifacts`);
- open vocabularies are lookup tables (`run_trigger_kinds`, `run_event_kinds`): adding a value is
  an `INSERT` in a new migration, never a table rebuild;
- every workspace-owned row has `workspace_id NOT NULL` with `ON DELETE CASCADE`; a run's bot and
  thread are tied to its workspace by composite foreign keys. Permanent delete removes the
  workspace or bot row and the cascades remove the rest; immutable history lets the cascade
  through only while `permanent_delete_context` holds a row inside that transaction;
- every foreign key column has an index that leads with it; no index duplicates another.
