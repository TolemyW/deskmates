# ADR-0031: Schema baseline reset

Date: 2026-10-13
Status: Accepted (owner, 2026-10-13)
Source: owner decisions of 2026-10-13 (wipe the Testbox stable deployment at the next upgrade;
improve the schema at the same time), issue #116 (workspace roles, private audience, message
board), issue #54 and the owner's request for an audit record. Evidence and the target schema are
in the [schema review](../design/schema-review-2026-10-13.md).

## Context

The Gateway schema is 54 forward-only migrations (`0001` to `0056`), 1,836 lines with 86
`ALTER TABLE` statements and 12 table rebuilds. ADR-0030 keeps every shipped migration name forever
because the name is its identity in deployed databases and backups. That rule protects data that
is carried forward. The owner has decided that no data is carried forward: the only long-lived
deployment is wiped at the next upgrade, and no other database is supported.

The accumulated history has costs the review documents: nullable scoping columns guarded by
triggers because `ALTER TABLE` cannot add `NOT NULL`; enum `CHECK`s that force table rebuilds with
foreign keys off; relational links in JSON; 109 of 122 references without an `ON DELETE` rule, so
permanent delete names 48 tables by hand; and runs and approvals that reach their workspace only
through joins. Two pieces of upcoming work need new structure: per-workspace roles with a
protected root account, private conversations and a message board (#116), and an audit record of
approval decisions and workspace configuration changes.

## Decisions

1. **One baseline replaces the legacy migrations.** `packages/gateway/migrations/0001-*.sql` to
   `0056-*.sql` are deleted and replaced by one file named per ADR-0030,
   `YYYYMMDDHHmm-baseline.sql`, which creates the target schema directly. This is a one-time
   exception to ADR-0030 decision 2, allowed only because the owner wipes the only deployment and
   supports no other database. `scripts/check-migration-order.mjs` permits the deletions only in
   the change that adds a file ending in `-baseline.sql`, and only for names in the legacy
   `NNNN-` form. Once merged, the baseline is a shipped migration like any other: never edited or
   renamed; later changes are new timestamped migrations.
2. **A database from before the baseline is refused, never wiped.** At open, before applying
   anything, the loader refuses a database whose `schema_migrations` holds any legacy `NNNN-` name,
   with a message that names the condition ("created before the schema baseline; this release
   starts only on an empty database; restore it with the release that wrote it") and changes
   nothing on disk. A database that has tables but no `schema_migrations` is refused the same way.
   The Gateway never deletes, moves or recreates a database file on its own.
3. **Upgrade, rollback and restore across the reset.** The wipe is an operator step: stop the old
   release, remove (or move aside) its database, workspace containers, volumes and networks, start
   the new release on an empty path. A backup with the old release is optional; for the Testbox
   stable deployment the owner chose to keep none. Rollback is the previous release with its own
   backup, where one exists. An old release refuses a baseline
   database through its existing "migrated by a newer Gateway" rule. `restoreDatabase` checks the
   manifest's migration list before it moves the current database aside, and refuses a pre-baseline
   or newer backup without touching the target. `GATEWAY_SECRETS_KEY` keeps its value.
4. **Foreign-key-off migrations declare themselves.** The central `FOREIGN_KEYS_OFF` list in
   `db/migrate.ts` is removed (the baseline needs none). A future migration that must rebuild a
   referenced table states it on its first line, `-- deskmates:foreign-keys-off`, and the loader keeps
   today's behaviour for it: enforcement off, `foreign_key_check` before commit, setting restored.
5. **Schema conventions.** Every table in the baseline and every later migration follows these:
   entity ids `<prefix>_<32 hex>` from `newId()`, append-only logs an integer `seq`; timestamps
   ISO-8601 UTC text with milliseconds; booleans `INTEGER` with `CHECK (x IN (0, 1))`; actor
   attribution `*_by` text labels, but a column that authorizes is a foreign key to `users`; JSON
   only for documents read whole, with `json_valid`, never for a field used in `WHERE`, `JOIN` or
   `ORDER BY` and never for a list of ids; a closed state machine is a `CHECK`, an open vocabulary
   is a lookup table referenced by foreign key; every index matches a query shape in the code and
   none duplicates a `UNIQUE` constraint.
6. **Workspace scope is one column and deletes cascade.** Every workspace-owned row carries
   `workspace_id NOT NULL` with `ON DELETE CASCADE`, including `runs`, `approvals`,
   `approval_rules`, `cost_alert_rules`, `cost_alerts` and `memory_suggestions`. A child that must
   stay in its parent's workspace uses a composite foreign key to `(workspace_id, id)` instead of a
   trigger. No default tenant is filled in by a trigger. Permanent delete removes the workspace
   row and lets cascades do the rest; immutable history keeps its guard triggers and the existing
   `permanent_delete_context` escape.
7. **Identity and workspace membership are separate (#116 foundation).** `users` and
   `user_logins` are the account; `workspace_memberships(workspace_id, user_id, role, status,
   auth_version)` holds a role in `owner | admin | member | guest` per workspace. Roles are checked
   per workspace, not per tenant. The creator of a workspace becomes its Owner in the same
   transaction that creates it. Invitations name a workspace and a role other than Owner.
8. **One protected root account.** `users.is_protected = 1` marks exactly one account (partial
   unique index), identified by its immutable id and that flag, never by a login name, email or
   SSO claim. Triggers make the flag unchangeable, keep the account from being disabled, insert it
   as Owner of every new workspace, and refuse any change of its membership away from active
   Owner. Because the root is Owner everywhere, a workspace can never lose its last Owner. On an
   empty database the Gateway creates it with login `admin`, password `admin` and
   `local_credentials.must_change = 1`; until the password is changed, the session may use only the
   change-password route. The root does not override private audience (decision 9).
9. **Private audience on conversations.** `threads.private_to_user_id` (a foreign key to `users`)
   makes a chat thread readable only by that person, whatever their or anyone else's role, the
   root included. The audience is read from the thread for its messages, runs, approvals, events,
   usage details and live updates; it is not copied onto child rows. Aggregate usage and cost stay
   visible to workspace managers. `threads.opened_by` replaces `side_chat_actor`.
10. **Workspace message board.** `board_posts` (author, body, `visible | withdrawn | hidden`
    state, version, a client request id for duplicate submissions) and the immutable
    `board_post_versions` (every edit, withdrawal and moderator hide, with who and when) are
    visible to current members of the workspace. A post never creates a run, task, approval or
    learned-memory candidate. Moderation rights belong to the #116 role matrix, not the schema.
11. **Audit record.** `audit_events` is append-only (no update, no delete): tenant, workspace,
    time, actor label and user id, action from the `audit_actions` lookup, target kind and id,
    `before_json` and `after_json`, optional run id and reason. A row is written in the same
    transaction as every approval decision (person or bot) and every workspace-level configuration
    change: egress policy and allowlist, approval rules and auto-approval settings, memberships,
    roles and invitations, budget and cost rules, bot configuration, connections, service
    principals, archive, restore and purge. Personal preferences, profile, avatar and password are
    not audited. Before and after values never contain a secret, token, cookie or message body.
    `lifecycle_audit` is folded into it.
12. **Foundation timing.** The audit and #116 tables are part of the baseline file only if their
    code merges before the baseline is merged; otherwise they are the first timestamped migrations
    after it. Either way they merge before the release that performs the wipe, so the deployment
    starts on the complete schema.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | The migrations directory holds no legacy file; an empty database migrates to the target schema; the check script accepts the baseline change and still refuses any other deletion or rename | T0 `db/migrate.test.ts` "applies the baseline to an empty database"; T0 `scripts/check-migration-order.test.mjs` "allows legacy deletions only beside a baseline", "still refuses deleting a timestamped migration" | legacy migration files on `main` after the baseline merge (target 0) |
| 2 | A database holding `0001-init.sql` in `schema_migrations`, or tables without `schema_migrations`, throws the pre-baseline message and its file bytes are unchanged | T0 `db/migrate.test.ts` "refuses a pre-baseline database without touching it", "refuses an unversioned non-empty database" | Gateway starts on a pre-baseline database (target 0); databases wiped by the Gateway (target 0) |
| 3 | Restoring a pre-baseline or newer backup throws before the target is moved; restoring a baseline backup works and revokes credentials as today | T1 `db/backup.test.ts` "refuses a pre-baseline backup and leaves the target in place", "restores a baseline backup" | restores that leave no database at the target path (target 0) |
| 4 | A test migration with the header runs with foreign keys off and is checked; one without the header runs with them on | T0 `db/migrate.test.ts` "honours the foreign-keys-off header" | migrations listed in a central loader list (target 0) |
| 5 | A schema lint over `sqlite_master` and `pragma table_info` finds no `*_at` column that is not text, no boolean without its check, no `*_json` without `json_valid`, no foreign key column without a leading index, no index duplicating a unique constraint | T0 `db/schema-conventions.test.ts` | convention violations in the migrated schema (target 0) |
| 6 | Every table with `workspace_id` has it `NOT NULL` with a cascading foreign key; deleting a populated workspace leaves no row of it in any table; a run whose thread is in another workspace is refused by the composite key | T0 `db/schema-conventions.test.ts` "workspace scope"; T1 `workspaces/trash-lifecycle.test.ts` "permanent delete leaves no orphan in any table" | orphan rows after purge (target 0); tables named in purge code (target 0) |
| 7 | One user holds different roles in two workspaces and each check uses the selected workspace; creating a workspace writes the creator's Owner row atomically; an invitation cannot carry Owner | T1 `auth/workspace-memberships.test.ts` | cross-workspace role leaks (target 0) |
| 8 | A second protected row, clearing the flag, disabling the root, demoting or removing its membership all fail in SQL; a new workspace has the root as Owner; a user registered or renamed as `admin` gains nothing; the root's first session reaches only the change-password route | T1 `auth/protected-root.test.ts` | root demotions or removals accepted (target 0) |
| 9 | Another member, Admin, Owner and the root get not-found for a private thread's messages, runs, approvals, events and stream frames; its creator reads them; workspace totals still include its usage | T1 `threads/private-audience.test.ts` | private bodies disclosed to anyone but the creator (target 0) |
| 10 | Edit, withdraw and hide each add a version row; version rows cannot be updated; a post that mentions a bot creates no run; a repeated client request id returns the first post | T1 `board/board-posts.test.ts` | runs created by board posts (target 0) |
| 11 | Each listed change and each approval decision writes exactly one audit row in its own transaction, with actor, workspace, target and before/after; a preference change writes none; an update or delete of an audit row fails; no audit value matches the secret-redaction corpus | T1 `audit/audit-log.test.ts`; T0 `db/schema-conventions.test.ts` "audit is append-only" | audited changes without a row (target 0); secrets found in audit values (target 0) |
| 12 | The wipe release's schema equals the baseline plus every later migration, and includes the audit and membership tables | T0 `db/migrate.test.ts` "the release schema contains the foundation tables" | releases deployed without the foundation tables (target 0) |

## Alternatives considered

- **Keep the 54 migrations and add more.** No data needs them, and every scoping fix would be
  another rebuild with foreign keys off. Rejected because the wipe makes the reset free.
- **Squash but keep the legacy names as no-ops.** Keeps the names valid in old databases, but
  those databases are not supported, and a no-op migration cannot make an old schema match the new
  one. Refusal is honest; pretending to be compatible is not.
- **Auto-wipe an incompatible database.** Destroys data on a configuration mistake (a wrong path,
  an old backup). The Gateway refuses and the operator decides.
- **Copy the audience onto every child row.** Faster filters, but two sources of truth for a
  security property. The thread is the only source; child rows join to it.
- **Per-vocabulary `CHECK` plus a code list.** Simpler, but every new event kind rebuilds
  `run_events`. A lookup table makes it an insert.

## Consequences

- ADR-0030 decision 2 stays in force after this one-time exception; the exception does not apply
  to any later migration.
- Tests that exercise upgrades from legacy migrations (ten files, listed in the review) are deleted
  or rewritten as baseline invariants. Upgrade-path evidence recorded in earlier ADRs and design
  documents stays as history.
- ADR-0022 needs an amendment for #116 that replaces tenant roles with workspace roles and
  amendment 1 A7 ("the side chat marker is not an audience") with decision 9; this ADR supplies
  the schema, that amendment the permission matrix.
- `AGENTS.md` and `packages/gateway/README.md` mention the baseline and the conventions when the
  implementation merges.
- The protected root with a well-known default password is exposed until its first login; the
  deployment runbook must change it before the Gateway is reachable by others.

## Owner answers (2026-10-13)

The questions the review raised were answered by the owner before implementation:

- Q1: `tenants` stays as the one installation domain, without tenant roles. There is no stored
  entitlement: a person may create a workspace when they are Owner or Admin of at least one
  workspace, or are the root; the creator becomes its Owner.
- Q2: tenant SSO configuration and service principals are managed by the root only. Shared
  Knowledge documents are published by an Owner or Admin of a workspace.
- Q3: cost alert rules are per workspace.
- Q4: audit rows survive a workspace purge, with the workspace id as plain text.
- Q5: private audience is for people only; a service principal's side chat stays visible to the
  workspace.
- Q6: the root is created on an empty database with login `admin`, password `admin` and a forced
  change at first sign-in (decision 8).
- Q7: the one-time exception to ADR-0030 decision 2 (decision 1) is confirmed; the owner wipes the
  only deployment, with no backup kept.
