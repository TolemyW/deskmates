# Gateway schema review before the baseline reset

Date: 2026-10-13
Status: review and proposal; no code or migration changed
Decision record: [ADR-0031](../adr/0031-schema-baseline-reset.md) (Proposed)

## Why now

The owner will wipe the only long-lived deployment (Testbox stable) at the next upgrade and asked to
improve the schema at the same time. No database is carried forward, so the 54 legacy migrations
(`0001` to `0056`, 1,836 lines, 86 `ALTER TABLE`, 12 table rebuilds) can become one baseline. This
review lists what the baseline should fix and what it should add as a foundation for exactly two
pieces of upcoming work: per-workspace roles (#116) and an audit table (#54 and the owner's request).
Other features add their own timestamped migration later.

## Method

- Applied every migration with the Gateway's own loader (`applyMigrations`) to an empty database
  and dumped `sqlite_master`. The dump is `tmp/schema-current.sql` in the review worktree (gitignored):
  69 regular tables, 2 FTS5 tables (8 shadow tables), 54 indexes, 31 triggers.
- For every table and every column, counted the non-test files under `packages/gateway/src` that
  name it (word match). Every table is used; one column is never named (below).
- Grepped the query modules for `json_extract`/`json_each` and for `WHERE` patterns, and ran
  `EXPLAIN QUERY PLAN` on the real query shapes found.

Counts and file names below are from commit `1fb0192c`.

## Findings

### F1. Leftovers of `ALTER TABLE ADD COLUMN`

SQLite cannot add a `NOT NULL` column without a default, so scoping and attribution columns added
later are nullable and guarded by triggers or by nothing:

| Column | Today | Guard |
|---|---|---|
| `workspaces.tenant_id` | nullable | `workspaces_default_tenant` trigger silently writes `'tnt_default'`; `workspaces_tenant_fixed` |
| `knowledge_docs.tenant_id`, `knowledge_proposals.tenant_id` | nullable | `*_tenant_required`, `*_tenant_fixed` triggers |
| `cost_alert_rules.tenant_id`, `cost_alerts.tenant_id` | nullable | `*_tenant_required` triggers |
| `approvals.bot_id`, `thread_id`, `message_id`, `rule_id`, `created_at`, `kind` | nullable, no FK | `approvals_same_run_bot` for `bot_id` only |
| `approval_rules.created_by`, `created_at` | nullable | none |
| `connectors.workspace_id`, `created_at` | nullable | none; `registry.ts` always writes both |
| `memory_suggestions.workspace_id` | nullable | `ownership.ts` falls back with `COALESCE(s.workspace_id, b.workspace_id)` |

`approvals.kind` NULL means "derive from the action" (migration 0026 comment): a tri-state that the
baseline can replace with `NOT NULL` plus a `CHECK`. The default-tenant trigger makes a missing
tenant succeed silently, the opposite of fail-closed. Seven triggers exist only because of `ALTER`.

### F2. Dead and misnamed columns

- `memory_suggestions.applied_version`: named by no source file. Dead.
- `bots.legacy_memory_body` is the live body of the bot's hand-written `MEMORY.md`
  (`bots/bots.ts` 155-192), not a legacy value. Rename to `memory_body`.
- `threads.side_chat_actor` is the only per-person marker on a thread; #116 turns it into an
  audience (F8), so its name and meaning change.
- `connectors.public_url` is a boolean without the `CHECK (x IN (0, 1))` every other boolean has.

No dead table was found: each of the 69 is read or written by at least one non-test module.

### F3. Enum `CHECK`s that grow force table rebuilds

Adding one value to a `CHECK` list means rebuilding the table. That is why five migrations run with
foreign keys off (`FOREIGN_KEYS_OFF` in `db/migrate.ts`: 0020, 0030, 0035, 0047, 0050) and why
`runs`, `run_events`, `run_usage`, `secrets`, `service_principals` and `tenant_invitations` are
quoted (`CREATE TABLE "runs"`) in the dump. Growing vocabularies today: `run_events.kind` (18 values),
`runs.trigger_kind` (5), `runs.status` (11), `secrets.owner_kind` (5). Closed state machines
(`tasks.status`, `approvals.decision`) are fine as `CHECK`s.

### F4. Relational data in JSON, and JSON queried by field

| Where | What the code does | Evidence |
|---|---|---|
| `tasks.thread_ids_json`, `tasks.run_ids_json` | many-to-many links queried with `json_each` | `tasks/tasks.ts` 100, 321-323 |
| `tasks.artifacts_json` | joined to `runs` on `$.runId` | `files/file-collection.ts` 69-73 |
| `runs.config_json` `$.runType` | filter in 7 queries | `memory/consolidation.ts` 178-262, `memory/entries.ts` 420, `skills/authoring.ts` 59-64 |
| `runs.config_json` `$.continuationExpiresAt` | expiry scan | `ledger/runs.ts` 374 |
| `runs.resume_payload_json` `$.approvalId` | join key to `approvals` | `ledger/runs.ts` 103 |
| `run_events.payload_json` `$.source` | sub-kind of `log` events, filtered in 6 queries | `ledger/usage.ts`, `ledger/usage-receipts.ts`, `workspaces/browser-retention.ts` |
| `bots.connectors_json` | list of connector ids; no FK, survives connector deletion | `bots/bots.ts` |

`runs.config_json` must stay (AGENTS.md: every run records its full knob configuration), but a
field the Gateway filters or joins on belongs in a column. `bots.message_allowlist_json`,
`bots.cron_json`, `thread_messages.mentions_json` and `attachments_json` are read whole and can stay
JSON for now.

### F5. Foreign keys and delete behaviour

- Missing FKs: `thread_messages.run_id`, `browser_locks.holder_run_id`, `cost_alerts.rule_id`,
  `approvals.{bot_id, thread_id, message_id, rule_id}`, and the JSON links in F4.
- Polymorphic references by design: `runs.trigger_ref`, `secrets.owner_id`. Acceptable; keep them
  typed by their `*_kind` column.
- `ON DELETE` is set on 13 of 122 references and absent on the rest. Permanent delete therefore walks the
  tables by hand: `workspaces/trash-lifecycle.ts` (382 lines) has 48 `remove`/`clear` calls naming
  tables, plus a `hasTable` probe. Every new workspace-owned table must be added there, a shared
  append point of the kind issue #53 removes.
- Actor attribution is a free-text label (`user:<id>`, `service:<id>`, `bot:<id>`, `human:web`,
  `web`) in more than 20 columns with 13 different names: `by`, `created_by`, `decided_by`, `approved_by`,
  `reviewed_by`, `accepted_by`, `delivered_by`, `acknowledged_by`, `archived_by`, `disabled_by`,
  `deleted_by`, `pinned_by`, `actor_id`. A label is right for history (it survives account
  deletion and names non-user actors), but the name should be uniform.

### F6. Indexes against actual queries

`EXPLAIN QUERY PLAN` on query shapes that exist in the code:

| Query (file) | Plan today | Fix |
|---|---|---|
| `threads WHERE workspace_id = ?` (`threads/threads.ts` 192, thread lists) | `SCAN threads` | `threads(workspace_id, updated_at)` |
| `thread_messages WHERE run_id = ?` (`threads/messages.ts` 199) | `SCAN thread_messages` | `thread_messages(run_id)` |
| `bot_sessions WHERE thread_id = ?` | `SCAN` | `bot_sessions(thread_id)` |
| `thread_members` by `bot_id` (`threads/direct-messages.ts` 66) | `SCAN` | `thread_members(bot_id)` |
| `skill_assignments` by `bot_id` (`skills/skill-store.ts` 174) | `SCAN` | `skill_assignments(bot_id)` |
| `incoming_handoffs WHERE run_id = ?` (purge) | `SCAN` | `incoming_handoffs(run_id)` |
| runs of a workspace, newest first | per-bot search plus `TEMP B-TREE FOR ORDER BY` | `runs.workspace_id` + `runs(workspace_id, created_at)` |

Redundant: `thread_pins_workspace_order (workspace_id, position)` duplicates the autoindex of
`UNIQUE (workspace_id, position)`. `knowledge_proposals_status (status, created_at)` is unused:
every proposal query filters by `tenant_id` first (`knowledge/knowledge.ts` 132-159) and
`knowledge_proposals_tenant` serves them.

### F7. Scoping: tenant-owned rows and the coming workspace scope

`tenancy/ownership.ts` resolves each of 16 owned kinds to a tenant with one SQL statement. The
chains are long because the scoping column is missing on hot tables: an approval goes
`approvals -> runs -> bots -> workspaces` (three joins); a run goes `runs -> bots -> workspaces`.
Cost alert rules and alerts carry `tenant_id` only, and a rule with `bot_id IS NULL` belongs to no
workspace. Knowledge documents and proposals are tenant-wide by design.

Once roles are per workspace (#116), every authorization check needs the workspace, not the tenant.
Rows that must answer "which workspace?" in one hop: `runs`, `approvals`, `approval_rules`,
`cost_alert_rules`, `cost_alerts`, `memory_suggestions` and the new tables. Tenant-wide rows
(Knowledge, tenant SSO, service principals) need an explicit rule for who may manage them once no
tenant-level Owner/Admin exists (owner question Q2).

### F8. The role model must move from tenant to workspace (#116)

Today (`packages/contracts/src/auth.ts`): `TenantRole = owner | admin | member` in
`tenant_memberships`, invitations carry a tenant role (`admin | member`), service principals carry
`admin | member` (ADR-0022 amendment 1 A10), `users.platform_role` marks a maintainer, and the first
Owner is created by `bootstrapOwner` (`auth/auth-service.ts` 678). Amendment 1 A7 says a Member sees
everything in the tenant and "the side chat marker is not an audience".

#116 needs: identity separate from membership; a role per (workspace, person) in
`owner | admin | member | guest`; a protected root account identified by id plus an explicit flag,
Owner of every workspace, never demoted or removed; the creator becoming Owner of a new workspace;
a private audience on a conversation readable only by its creator; a workspace message board with
edit, withdraw, moderator-hide and history. None of these has a column today. `tenant_memberships`
has the right shape (`status`, `auth_version` for live revocation) at the wrong scope.

A useful consequence: when the protected root is Owner of every workspace by construction, "the last
Owner leaves" cannot happen, and the last-Owner race checks become a trigger on one row.

### F9. Conventions that are already consistent

- Timestamps are ISO-8601 UTC text with milliseconds everywhere (`nowIso()`, and `strftime` with
  `%f` in migration 0028); lexical comparison works. Keep it; add a test, not a type change.
- Text ids are `<prefix>_<32 hex>` from `newId()` (26 prefixes). Exceptions: `knowledge/knowledge.ts`
  builds `kp_`/`kb_` ids inline, `tnt_default` is a literal, OIDC provider ids are operator slugs,
  and append-only logs use `INTEGER PRIMARY KEY AUTOINCREMENT`. Prefix lengths vary (`ws` to
  `welcome`); harmless, not worth a rename.
- Booleans are `INTEGER` 0/1 with a `CHECK`, except `connectors.public_url` (F2).
- Secrets: only hashes (`token_hash`, `state_hash`), Argon2id (`local_credentials`) and AES-GCM
  blobs (`secrets.encrypted_blob`). No plaintext password, cookie or model key. Keep.

### F10. Migration plumbing that the reset touches

- `applyMigrations` reports an unknown applied name as "migrated by a newer Gateway". A pre-baseline
  database would get that misleading message.
- `restoreDatabase` (`db/backup.ts` 98-159) moves the current database aside before `openDatabase`
  migrates the restored copy; if the copy is refused, the operator is left with no database at the
  target path. The manifest already lists the applied migrations, so the check can run first.
- `scripts/check-migration-order.mjs` fails any branch that deletes a migration on `main`
  (ADR-0030 decision 2); the baseline PR needs a one-time, explicit exception.
- Ten test files name legacy migrations (`auth/migration-0028.test.ts`, `migration-0049`,
  `migration-0055`, `tenancy/migration-0029-0032.test.ts`, `tenancy/migration-failure.test.ts`,
  `tasks/tasks.test.ts`, `api/member-onboarding.test.ts`, `api/tenancy-p4.test.ts`,
  `db/migrate.test.ts`, `scripts/check-migration-order.test.mjs`); they test upgrade paths that no
  longer exist and must be rewritten as baseline invariants or deleted.

## Proposed target schema

Notation: `PK`, `FK -> t (on delete)`, `U` unique, `IX` index, `C` check. Unchanged tables are listed
by name only. Tier A is the foundation the two features need; tier B is cleanup the baseline does
because a wipe makes it free; tier C is deferred.

### Conventions (apply to every table, now and in later migrations)

1. Ids: entity rows `TEXT PRIMARY KEY` `<prefix>_<32 hex>` from `newId()`; append-only logs
   `seq INTEGER PRIMARY KEY AUTOINCREMENT`; link tables a composite primary key.
2. Time: `*_at TEXT` ISO-8601 UTC with milliseconds; durations `*_seconds INTEGER`.
3. Booleans: `INTEGER NOT NULL DEFAULT 0 CHECK (x IN (0, 1))`, named as a predicate (`is_protected`,
   `must_change`).
4. Actors: `*_by TEXT` holding the actor label; a column that authorizes (audience, membership)
   is a real FK to `users(id)`.
5. JSON: `*_json TEXT` with `CHECK (json_valid(x))`, only for documents read whole. A field used in
   `WHERE`, `JOIN` or `ORDER BY` is a column; a list of ids is a link table.
6. Enums: a closed state machine is a `CHECK`; an open vocabulary is a `*_kinds` lookup table
   referenced by FK, so adding a value is one `INSERT` and never a rebuild.
7. Scope: every workspace-owned row has `workspace_id NOT NULL`, FK `ON DELETE CASCADE`; a child
   that must stay in its parent's workspace uses a composite FK to `(workspace_id, id)` instead of a
   trigger.
8. Delete: owned children `CASCADE`; optional cross-references `SET NULL`; append-only immutable
   history keeps its guard trigger with the existing `permanent_delete_context` escape.
9. Indexes: one per query shape found in code, leading with the scoping column; no duplicate of a
   `UNIQUE` autoindex.

### Tier A: identity, membership, audience, board, audit

```
users                 + is_protected INT C(0,1)  -- the root; UNIQUE partial IX (is_protected) WHERE is_protected = 1
                      trigger: is_protected never changes; a protected user is never disabled
local_credentials     + must_change INT C(0,1)   -- set for the root's default password
tenant_memberships    tenant_id, user_id PK; status; auth_version; + can_create_workspaces INT C(0,1)
                      - role                      -- Q1: installation entitlement replaces the tenant role
workspace_memberships workspace_id FK->workspaces(CASCADE), user_id FK->users; PK(workspace_id,user_id)
                      role C(owner|admin|member|guest); status C(active|removed);
                      auth_version INT>0; created_by, created_at, updated_at; IX(user_id, status)
                      trigger after insert on workspaces: insert the protected user as owner
                      trigger: the protected user's row is never updated off owner/active and never
                      deleted outside permanent_delete_context
invitations           (was tenant_invitations) + workspace_id FK(CASCADE); role C(admin|member|guest);
                      rest unchanged (token_hash, target_kind, expiry, consumed/revoked)
threads               + opened_by TEXT (actor label; replaces side_chat_actor)
                      + private_to_user_id FK->users  -- NULL = workspace audience; set = only this person
                      C(private_to_user_id IS NULL OR kind = 'chat'); IX(workspace_id, updated_at)
board_posts           id 'bpo_'; workspace_id FK(CASCADE); author_user_id FK->users; body;
                      state C(visible|withdrawn|hidden); version INT; client_request_id;
                      created_at, updated_at; U(workspace_id, author_user_id, client_request_id);
                      IX(workspace_id, state, created_at DESC)
board_post_versions   post_id FK->board_posts(CASCADE), version; PK(post_id,version); body; state;
                      changed_by_user_id FK->users; changed_at; reason; immutable trigger
audit_events          seq PK autoinc; tenant_id FK; workspace_id TEXT (no FK, survives purge: Q4);
                      occurred_at; actor TEXT; actor_user_id TEXT; action FK->audit_actions;
                      target_kind, target_id; before_json, after_json C(json_valid); run_id TEXT;
                      reason; IX(workspace_id, seq), IX(target_kind, target_id, seq), IX(actor_user_id, seq)
                      triggers: no UPDATE, no DELETE
audit_actions         action PK  -- seeded: approval.decide, approval_rule.create/delete,
                      egress.policy_set, egress.rule_add/remove, membership.add/role/remove,
                      invitation.create/revoke, workspace.create/archive/restore/purge,
                      bot.create/config/archive/restore/purge, cost_rule.create/delete,
                      service_principal.create/role/disable, connection.create/revoke
```

Audit rules: written in the same transaction as the change; one row per approval decision (human or
bot) and per workspace-level configuration change; personal preferences (`users.preferences_json`,
avatar, password) are not audited; `before_json`/`after_json` hold configuration values, never a
secret, token, cookie or message body (redacted by the writer and checked by a test).
`lifecycle_audit` is folded in (`workspace.archive` etc.) and dropped.

Audience rule: a private thread's runs, approvals, events, usage rows and SSE frames are visible
only to `private_to_user_id`; aggregates (usage, cost totals) stay visible to workspace managers.
The audience is read from `threads` through the run's `thread_id`; it is not copied onto child rows.

### Tier B: cleanup the baseline does

```
workspaces            tenant_id NOT NULL (no default trigger); drop workspaces_default_tenant
runs                  + workspace_id NOT NULL, composite FKs (workspace_id,bot_id)->bots,
                        (workspace_id,thread_id)->threads; drop runs_same_workspace trigger
                      + run_type TEXT, + continuation_expires_at, + resume_approval_id FK->approvals
                      trigger_kind FK->run_trigger_kinds; IX(workspace_id, created_at)
run_events            kind FK->run_event_kinds; + source TEXT; IX(run_id, kind, source)
approvals             + workspace_id NOT NULL; bot_id NOT NULL FK; thread_id FK; message_id FK;
                      rule_id FK(SET NULL); created_at NOT NULL; kind NOT NULL C(tool|egress|continuation);
                      IX(workspace_id, decision, created_at); drop approvals_same_run_bot
approval_rules        + workspace_id NOT NULL; created_by, created_at NOT NULL
cost_alert_rules      tenant_id -> workspace_id NOT NULL (Q3); drop *_tenant_required triggers
cost_alerts           tenant_id -> workspace_id NOT NULL; rule_id FK
knowledge_docs        tenant_id NOT NULL; drop *_tenant_required triggers
knowledge_proposals   tenant_id NOT NULL; drop knowledge_proposals_status index
memory_suggestions    workspace_id NOT NULL; drop applied_version
connectors            workspace_id, created_at NOT NULL; public_url C(0,1)
bots                  legacy_memory_body -> memory_body
thread_messages       run_id FK(SET NULL); IX(run_id)
browser_locks         holder_run_id FK(CASCADE)
tasks                 drop thread_ids_json, run_ids_json, artifacts_json
task_threads          task_id FK(CASCADE), thread_id FK(CASCADE); PK; IX(thread_id)
task_runs             task_id FK(CASCADE), run_id FK(CASCADE); PK; IX(run_id)
task_artifacts        task_id FK(CASCADE), ordinal; PK; run_id FK(SET NULL); path; label; ref
run_trigger_kinds, run_event_kinds   lookup tables (convention 6)
indexes               + bot_sessions(thread_id), thread_members(bot_id), skill_assignments(bot_id),
                        incoming_handoffs(run_id); drop thread_pins_workspace_order
all workspace-owned   FK ON DELETE CASCADE from workspaces down; trash purge deletes the root row
```

The `tasks` delivery `CHECK` that requires a non-empty artifact list moves to the store (a `CHECK`
cannot count rows of another table); `tasks.test.ts` keeps proving it.

### Tier C: deferred

`bots.connectors_json` to a `bot_connectors` link table; `bots.cron_json` to a schedule table;
message attachments to a table; folding `private_chats` into `threads`; renaming id prefixes;
removing the tenant layer altogether (Q1).

### Table count

| | Regular tables | FTS5 |
|---|---|---|
| Today | 69 | 2 |
| Tier A | +5 (`workspace_memberships`, `board_posts`, `board_post_versions`, `audit_events`, `audit_actions`), -1 (`lifecycle_audit`); `tenant_invitations` renamed | |
| Tier B | +5 (`task_threads`, `task_runs`, `task_artifacts`, `run_trigger_kinds`, `run_event_kinds`) | |
| Target | 78 | 2 |

Triggers drop from 31 to about 22: seven `ALTER`-era guards and two same-workspace triggers go,
three to four protected-root and immutability triggers come.

## Code impact

| Area | Files | Change | Rough size |
|---|---|---|---|
| Loader, backup, CI check | `db/migrate.ts`, `db/backup.ts`, `scripts/check-migration-order.mjs` | legacy refusal, manifest pre-check, one-time baseline exception; drop `FOREIGN_KEYS_OFF` | 150 lines + tests |
| Baseline SQL | `migrations/<ts>-baseline.sql` | written from the dump plus tiers A/B | about 1,000 lines |
| Migration tests | 10 files in F10 | delete upgrade tests, add baseline invariants | -1,500 / +300 |
| Purge | `workspaces/trash-lifecycle.ts` | 48 hand-written deletes become cascade | -200 |
| Run scoping | `ledger/runs.ts`, `scheduler/*`, `tenancy/ownership.ts`, `memory/consolidation.ts`, `memory/entries.ts`, `skills/authoring.ts` | write `workspace_id`, `run_type`, `continuation_expires_at`, `resume_approval_id`; shorter owner SQL | 300 |
| Events | `ledger/events.ts`, `ledger/usage.ts`, `ledger/usage-receipts.ts`, `workspaces/browser-retention.ts` | write and filter `source` | 150 |
| Tasks | `tasks/tasks.ts`, `files/file-collection.ts` | link tables | 250 |
| Approvals, cost | `approvals/*`, `ledger/cost-alerts.ts`, `test-support/tenants.ts` | workspace column, NOT NULL kind | 200 |
| Audit | new `audit/audit-log.ts` plus about 15 writer call sites | table, writer, redaction | 500 incl. tests |
| #116 schema foundation | `auth/user-store.ts`, `auth/auth-service.ts`, `auth/invitations.ts`, `auth/session-store.ts`, contracts `auth.ts` | memberships per workspace, protected root, `must_change` | 800-1,200; the #116 route, SSE and UI work is separate |

Total for this proposal, excluding the #116 product work: roughly 3,500 changed lines in about 35
files, three PRs.

## Implementation order

1. **Baseline PR** (ADR-0031 decisions 1-4 and tier B): baseline file, legacy refusal, restore
   pre-check, CI exception, rewritten migration tests, tier-B store changes. Behaviour stays the
   same; T0/T1 and the T2 suite pass on an empty database.
2. **Audit PR**: `audit_events`, `audit_actions`, the writer and its call sites. If merged before
   the baseline PR, it is part of the baseline file; afterwards it is the first timestamped migration.
3. **#116 foundation PR**, after the ADR-0022 amendment for #116 settles Q1 to Q3:
   `workspace_memberships`, protected root and forced password change, workspace invitations,
   thread audience, board tables, with their stores and tests. Same rule: inside the baseline only
   if it merges before the baseline is frozen, otherwise timestamped migrations.
4. **Wipe release**: the stable deployment is backed up once, stopped, its database moved aside,
   and the new release starts on an empty database (ADR-0031 decision 3).

## Open questions for the owner

- **Q1. Tenant layer.** Keep `tenants` as a single installation domain with `tenant_memberships`
  reduced to account status plus a `can_create_workspaces` entitlement (recommended: smallest code
  change, SSO policy stays where it is), or remove tenants entirely (larger change, touches
  `tenancy/*`, SSO and the tenant header).
- **Q2. Tenant-wide resources.** Who manages Knowledge, tenant SSO and service principals once
  there is no tenant Owner/Admin: the protected root only (recommended), or any workspace Owner.
- **Q3. Cost alert rules per workspace.** A tenant-wide rule (`bot_id IS NULL`) becomes a
  workspace rule (recommended; matches per-workspace budgets in #61).
- **Q4. Audit after purge.** Keep audit rows after a workspace is permanently deleted, with the
  workspace id as plain text (recommended), or delete them with the workspace like
  `lifecycle_audit` today.
- **Q5. Service principal side chats.** Private audience is for people only; a service principal's
  side chat stays workspace-visible (recommended), or principals get a private audience too.
- **Q6. Root bootstrap.** The Gateway creates the protected `admin` account on an empty database
  with password `admin` and `must_change = 1`, replacing `bootstrapOwner`; until the password is
  changed only the change-password route works. Confirm, or require an initial password from
  `.env` instead.
