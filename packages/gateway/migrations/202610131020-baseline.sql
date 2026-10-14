-- Schema baseline (ADR-0031). Replaces the legacy migrations 0001-0056; a database created by
-- them is refused by the loader, never upgraded. Conventions (ADR-0031 decision 5):
--   ids        entity rows `<prefix>_<32 hex>` from newId(); append-only logs an integer key
--   time       `*_at` TEXT, ISO-8601 UTC with milliseconds
--   booleans   INTEGER NOT NULL with CHECK (x IN (0, 1))
--   actors     `*_by` TEXT actor labels (`user:<id>`, `service:<id>`, `bot:<id>`, ...)
--   JSON       `*_json` TEXT read whole; a field the Gateway filters on is a (generated) column
--   enums      closed state machines are CHECKs; open vocabularies are `*_kinds` lookup tables
--   scope      workspace-owned rows carry `workspace_id NOT NULL ... ON DELETE CASCADE`
--   delete     owned children cascade; optional cross-references SET NULL

-- ---------------------------------------------------------------------------------------------
-- Installation domain, accounts and sign-in (ADR-0022)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tenants (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Which login evidence admits a session into this tenant.
  auth_policy          TEXT NOT NULL DEFAULT 'local_or_sso'
                       CHECK (auth_policy IN ('local_or_sso', 'sso_optional', 'sso_required')),
  -- Bumped by a policy change; a grant issued under another version is no longer evidence.
  auth_policy_version  INTEGER NOT NULL DEFAULT 1 CHECK (auth_policy_version > 0),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT INTO tenants (id, name, created_at, updated_at)
VALUES ('tnt_default', 'Default Tenant', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  platform_role     TEXT CHECK (platform_role IN ('maintainer')),
  -- The one protected root account (ADR-0031 decision 8): designated by its id and this flag,
  -- never by a login name. Owner of every workspace; never disabled, demoted or removed.
  is_protected      INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
  preferences_json  TEXT NOT NULL DEFAULT '{}'
                    CHECK (json_valid(preferences_json) AND json_type(preferences_json) = 'object'),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX users_one_protected ON users(is_protected) WHERE is_protected = 1;

CREATE TRIGGER users_protected_fixed BEFORE UPDATE OF is_protected ON users
WHEN NEW.is_protected IS NOT OLD.is_protected AND OLD.is_protected = 1
BEGIN SELECT RAISE(ABORT, 'the protected account stays protected'); END;

CREATE TRIGGER users_protected_designation BEFORE UPDATE OF is_protected ON users
WHEN NEW.is_protected = 1 AND OLD.is_protected = 0
BEGIN SELECT RAISE(ABORT, 'the protected account is designated when it is created'); END;

CREATE TRIGGER users_protected_active BEFORE UPDATE OF status ON users
WHEN OLD.is_protected = 1 AND NEW.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'the protected account cannot be disabled'); END;

CREATE TRIGGER users_protected_no_delete BEFORE DELETE ON users
WHEN OLD.is_protected = 1
BEGIN SELECT RAISE(ABORT, 'the protected account cannot be deleted'); END;

CREATE TABLE user_logins (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  provider        TEXT NOT NULL CHECK (provider IN ('local', 'oidc')),
  issuer          TEXT NOT NULL CHECK (length(issuer) > 0),
  subject         TEXT NOT NULL CHECK (length(subject) > 0),
  email           TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at      TEXT NOT NULL,
  UNIQUE (provider, issuer, subject)
);
CREATE INDEX user_logins_user ON user_logins(user_id);

CREATE TABLE local_credentials (
  login_id       TEXT PRIMARY KEY REFERENCES user_logins(id),
  password_hash  TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  -- Set for a default password (the root's `admin`): the session may only change it.
  must_change    INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  updated_at     TEXT NOT NULL
);

CREATE TABLE user_avatars (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  content_type  TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes         BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 524288),
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  updated_at    TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  id                   TEXT PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id              TEXT NOT NULL REFERENCES users(id),
  login_id             TEXT NOT NULL REFERENCES user_logins(id),
  auth_method          TEXT NOT NULL CHECK (auth_method IN ('local', 'oidc')),
  authenticated_at     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  idle_expires_at      TEXT NOT NULL,
  absolute_expires_at  TEXT NOT NULL,
  revoked_at           TEXT,
  revoked_reason       TEXT,
  idp_sid              TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_login ON auth_sessions(login_id);

-- An account's place in the installation domain (ADR-0031 Q1): no role. Roles are per workspace.
CREATE TABLE tenant_memberships (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  -- Bumped by every status change; grants pinned to an older version stop admitting.
  auth_version  INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user ON tenant_memberships(user_id);

CREATE TABLE oidc_providers (
  id                TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) BETWEEN 1 AND 64),
  display_name      TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  -- Pinned issuer; discovery is fetched from it, never from a request.
  issuer            TEXT NOT NULL UNIQUE,
  client_id         TEXT NOT NULL CHECK (length(client_id) > 0),
  client_secret_id  TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  -- Exact registered redirect URI (the Gateway's /auth/oidc/callback on its public origin).
  redirect_uri      TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT 'openid email profile',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX oidc_providers_secret ON oidc_providers(client_secret_id);

CREATE TABLE tenant_sso_providers (
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  provider_id           TEXT NOT NULL REFERENCES oidc_providers(id),
  -- NULL: no just-in-time accounts. 'member': an unknown subject may join as a Member only.
  jit_role              TEXT CHECK (jit_role IN ('member')),
  max_auth_age_seconds  INTEGER NOT NULL DEFAULT 43200 CHECK (max_auth_age_seconds > 0),
  created_at            TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider_id)
);
CREATE INDEX tenant_sso_providers_provider ON tenant_sso_providers(provider_id);

-- An invitation into one workspace with one role (ADR-0031 decision 7); never an Owner.
CREATE TABLE invitations (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash           TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  role                 TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  -- local_signup: whoever holds the link (target_value null); local_new: a new local account with
  -- this login name; local_user: the existing local account with this login name; oidc_email: a
  -- login at provider_id whose ID token carries this email as verified.
  target_kind          TEXT NOT NULL
                       CHECK (target_kind IN ('local_signup', 'local_new', 'local_user', 'oidc_email')),
  target_value         TEXT CHECK (target_value IS NULL OR length(target_value) BETWEEN 1 AND 320),
  provider_id          TEXT REFERENCES oidc_providers(id),
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  consumed_at          TEXT,
  consumed_by_user_id  TEXT REFERENCES users(id),
  revoked_at           TEXT,
  CHECK ((target_kind = 'oidc_email') = (provider_id IS NOT NULL)),
  CHECK ((target_kind = 'local_signup') = (target_value IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_by_user_id IS NULL))
);
CREATE INDEX invitations_tenant ON invitations(tenant_id);
CREATE INDEX invitations_provider ON invitations(provider_id);
CREATE INDEX invitations_consumer ON invitations(consumed_by_user_id);
CREATE INDEX invitations_workspace ON invitations(workspace_id, created_at, id);

CREATE TABLE oidc_login_transactions (
  -- SHA-256 of the `state` sent to the IdP; the state itself is only in the redirect.
  state_hash            TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  provider_id           TEXT NOT NULL REFERENCES oidc_providers(id),
  purpose               TEXT NOT NULL CHECK (purpose IN ('login', 'link', 'tenant_grant')),
  -- Tenant the flow is for (JIT target, step-up grant); NULL for a plain global sign-in.
  tenant_id             TEXT REFERENCES tenants(id),
  -- Signed-in session that started a link or step-up; NULL for an anonymous sign-in.
  session_id            TEXT REFERENCES auth_sessions(id),
  invitation_id         TEXT REFERENCES invitations(id) ON DELETE CASCADE,
  -- SHA-256 of the browser binding (pre-login cookie, or the session token).
  browser_binding_hash  TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  code_verifier         TEXT NOT NULL,
  nonce                 TEXT NOT NULL,
  return_path           TEXT NOT NULL CHECK (return_path GLOB '/*' AND return_path NOT GLOB '//*'),
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  consumed_at           TEXT
);
CREATE INDEX oidc_login_transactions_expiry ON oidc_login_transactions(expires_at);
CREATE INDEX oidc_login_transactions_provider ON oidc_login_transactions(provider_id);
CREATE INDEX oidc_login_transactions_tenant ON oidc_login_transactions(tenant_id);
CREATE INDEX oidc_login_transactions_session ON oidc_login_transactions(session_id);
CREATE INDEX oidc_login_transactions_invitation ON oidc_login_transactions(invitation_id);

CREATE TABLE oidc_logout_tokens (
  jti_hash     TEXT PRIMARY KEY CHECK (length(jti_hash) = 64),
  provider_id  TEXT NOT NULL REFERENCES oidc_providers(id),
  received_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX oidc_logout_tokens_expiry ON oidc_logout_tokens(expires_at);
CREATE INDEX oidc_logout_tokens_provider ON oidc_logout_tokens(provider_id);

CREATE TABLE tenant_auth_grants (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES auth_sessions(id),
  tenant_id                TEXT NOT NULL REFERENCES tenants(id),
  login_id                 TEXT NOT NULL REFERENCES user_logins(id),
  provider                 TEXT NOT NULL CHECK (provider IN ('local', 'oidc')),
  issuer                   TEXT NOT NULL,
  policy_version           INTEGER NOT NULL,
  membership_auth_version  INTEGER NOT NULL,
  auth_time                TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  revoked_at               TEXT,
  created_at               TEXT NOT NULL,
  idp_sid                  TEXT,
  UNIQUE (session_id, tenant_id)
);
CREATE INDEX tenant_auth_grants_tenant ON tenant_auth_grants(tenant_id);
CREATE INDEX tenant_auth_grants_login ON tenant_auth_grants(login_id);

CREATE TABLE service_principals (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  token_hash       TEXT UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 64),
  token_issued_at  TEXT,
  daily_usd_cap    REAL NOT NULL CHECK (daily_usd_cap > 0),
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  disabled_at      TEXT,
  disabled_by      TEXT,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK ((token_hash IS NULL) = (token_issued_at IS NULL))
);
CREATE INDEX service_principals_tenant ON service_principals(tenant_id);

-- Encrypted secret blobs. `owner_kind`/`owner_id` name the owner; the reference is polymorphic.
CREATE TABLE secrets (
  id              TEXT PRIMARY KEY,
  owner_kind      TEXT NOT NULL
                  CHECK (owner_kind IN ('connector', 'workspace', 'model', 'oidc_provider', 'gateway')),
  owner_id        TEXT NOT NULL,
  encrypted_blob  BLOB NOT NULL,
  rotated_at      TEXT NOT NULL
);
CREATE INDEX secrets_owner ON secrets(owner_kind, owner_id);

CREATE TABLE prices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model               TEXT NOT NULL,
  input_per_m         REAL NOT NULL,
  output_per_m        REAL NOT NULL,
  cache_read_per_m    REAL NOT NULL,
  cache_create_per_m  REAL NOT NULL,
  effective_from      TEXT NOT NULL,
  UNIQUE (model, effective_from)
);

-- ---------------------------------------------------------------------------------------------
-- Workspaces and bots
-- ---------------------------------------------------------------------------------------------

CREATE TABLE workspaces (
  id                             TEXT PRIMARY KEY,
  tenant_id                      TEXT NOT NULL REFERENCES tenants(id),
  name                           TEXT NOT NULL,
  sandbox_provider               TEXT NOT NULL CHECK (sandbox_provider IN ('docker', 'desktop-vm')),
  status                         TEXT NOT NULL CHECK (status IN ('ready', 'needs_login', 'disabled')),
  probe_url                      TEXT,
  probe_rule_json                TEXT CHECK (probe_rule_json IS NULL OR json_valid(probe_rule_json)),
  egress_updated_at              TEXT,
  browser_epoch                  INTEGER NOT NULL DEFAULT 0,
  archived_at                    TEXT,
  archived_by                    TEXT,
  restoration_requirements_json  TEXT
                                 CHECK (restoration_requirements_json IS NULL
                                        OR json_valid(restoration_requirements_json)),
  created_at                     TEXT NOT NULL
);
-- List-order indexes end in their tie-breaker (#113, docs/design/pagination-coverage-2026-10-13.md).
CREATE INDEX workspaces_tenant ON workspaces(tenant_id, archived_at, created_at, id);

CREATE TRIGGER workspaces_tenant_fixed BEFORE UPDATE OF tenant_id ON workspaces
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN SELECT RAISE(ABORT, 'a workspace cannot move between tenants'); END;

-- A person's role in one workspace (ADR-0031 decision 7). Identity is `users`; this is
-- membership. A person may hold different roles in different workspaces.
CREATE TABLE workspace_memberships (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  -- Bumped by every role or status change; capabilities pinned to an older version end.
  auth_version  INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user ON workspace_memberships(user_id, status);
CREATE INDEX workspace_memberships_role ON workspace_memberships(workspace_id, status, role);

-- The protected account is Owner of every workspace: of each new one, and of every existing
-- one when it is created (ADR-0031 decision 8).
CREATE TRIGGER workspaces_protected_owner AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_memberships
    (workspace_id, user_id, role, status, created_by, created_at, updated_at)
  SELECT NEW.id, u.id, 'owner', 'active', 'system:protected', NEW.created_at, NEW.created_at
    FROM users u WHERE u.is_protected = 1;
END;

CREATE TRIGGER users_protected_owner AFTER INSERT ON users
WHEN NEW.is_protected = 1
BEGIN
  INSERT INTO workspace_memberships
    (workspace_id, user_id, role, status, created_by, created_at, updated_at)
  SELECT w.id, NEW.id, 'owner', 'active', 'system:protected', NEW.created_at, NEW.created_at
    FROM workspaces w;
END;

CREATE TRIGGER workspace_memberships_protected_fixed BEFORE UPDATE ON workspace_memberships
WHEN (SELECT is_protected FROM users WHERE id = OLD.user_id) = 1
  AND (NEW.role <> 'owner' OR NEW.status <> 'active' OR NEW.user_id IS NOT OLD.user_id
       OR NEW.workspace_id IS NOT OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'the protected account stays Owner of every workspace'); END;

CREATE TRIGGER workspace_memberships_protected_no_delete BEFORE DELETE ON workspace_memberships
WHEN (SELECT is_protected FROM users WHERE id = OLD.user_id) = 1
  AND NOT EXISTS (SELECT 1 FROM permanent_delete_context)
BEGIN SELECT RAISE(ABORT, 'the protected account stays Owner of every workspace'); END;

-- Workspace message board (ADR-0031 decision 10): explicit, inert posts that every current
-- member of the workspace reads. A post never starts a run.
CREATE TABLE board_posts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_user_id     TEXT NOT NULL REFERENCES users(id),
  body               TEXT NOT NULL CHECK (length(trim(body)) > 0),
  state              TEXT NOT NULL DEFAULT 'visible' CHECK (state IN ('visible', 'withdrawn', 'hidden')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- The client's idempotency key: a repeated submission returns the first post.
  client_request_id  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX board_posts_request
  ON board_posts(workspace_id, author_user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX board_posts_workspace ON board_posts(workspace_id, state, created_at, id);
CREATE INDEX board_posts_author ON board_posts(author_user_id);

CREATE TABLE board_post_versions (
  post_id             TEXT NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL CHECK (version > 0),
  body                TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('visible', 'withdrawn', 'hidden')),
  op                  TEXT NOT NULL CHECK (op IN ('post', 'edit', 'withdraw', 'hide', 'unhide')),
  changed_by_user_id  TEXT NOT NULL REFERENCES users(id),
  changed_at          TEXT NOT NULL,
  reason              TEXT,
  PRIMARY KEY (post_id, version)
);
CREATE INDEX board_post_versions_user ON board_post_versions(changed_by_user_id);

CREATE TRIGGER board_post_versions_immutable BEFORE UPDATE ON board_post_versions
BEGIN SELECT RAISE(ABORT, 'board post versions are immutable'); END;

CREATE TRIGGER board_post_versions_no_delete BEFORE DELETE ON board_post_versions
WHEN NOT EXISTS (SELECT 1 FROM permanent_delete_context)
BEGIN SELECT RAISE(ABORT, 'board post versions are immutable'); END;

-- Set inside a permanent-delete transaction only; immutable-history guards let deletes through
-- while a row is present (ADR-0026). Never holds a row outside that transaction.
CREATE TABLE permanent_delete_context (
  object_id    TEXT NOT NULL,
  object_kind  TEXT NOT NULL CHECK (object_kind IN ('workspace', 'bot')),
  PRIMARY KEY (object_kind, object_id)
);

CREATE TABLE deletion_tombstones (
  object_id    TEXT NOT NULL,
  object_kind  TEXT NOT NULL CHECK (object_kind IN ('workspace', 'bot')),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  deleted_by   TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,
  PRIMARY KEY (object_kind, object_id)
);
CREATE INDEX deletion_tombstones_tenant ON deletion_tombstones(tenant_id);

-- The audit record (ADR-0031 decision 11): every approval decision and every workspace-level
-- configuration change, written in the transaction that makes it. Append-only. `workspace_id`
-- has no foreign key on purpose: the record outlives a purged workspace (owner answer Q4).
CREATE TABLE audit_actions (action TEXT PRIMARY KEY);
INSERT INTO audit_actions (action) VALUES
  ('approval.decide'), ('approval_rule.create'), ('approval_rule.delete'),
  ('bot.archive'), ('bot.create'), ('bot.purge'), ('bot.restore'), ('bot.update'),
  ('channel.connect'), ('channel.disconnect'), ('connector.create'),
  ('cost_rule.create'), ('cost_rule.delete'), ('egress.allowlist_set'),
  ('integration.connect'), ('integration.revoke'), ('invitation.create'), ('invitation.revoke'),
  ('membership.add'), ('membership.remove'), ('membership.role'),
  ('service_principal.create'), ('service_principal.disable'), ('service_principal.rotate'),
  ('workspace.archive'), ('workspace.create'), ('workspace.purge'), ('workspace.restore'),
  ('workspace.update');

CREATE TABLE audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  workspace_id   TEXT,
  occurred_at    TEXT NOT NULL,
  actor          TEXT NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL REFERENCES audit_actions(action),
  target_kind    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  before_json    TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json     TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  run_id         TEXT,
  reason         TEXT
);
CREATE INDEX audit_events_tenant ON audit_events(tenant_id, seq);
CREATE INDEX audit_events_workspace ON audit_events(workspace_id, seq);
CREATE INDEX audit_events_target ON audit_events(target_kind, target_id, seq);
CREATE INDEX audit_events_actor ON audit_events(actor_user_id, seq);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TABLE egress_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain_pattern  TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (workspace_id, domain_pattern)
);

CREATE TABLE bots (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  role                    TEXT NOT NULL,
  model                   TEXT,
  cheap_model             TEXT,
  effort                  TEXT,
  thinking_json           TEXT CHECK (thinking_json IS NULL OR json_valid(thinking_json)),
  avatar_json             TEXT CHECK (avatar_json IS NULL OR json_valid(avatar_json)),
  soul_version            INTEGER NOT NULL DEFAULT 1,
  soul_body               TEXT,
  -- The bot's hand-written MEMORY.md (learned memory lives in memory_entries).
  memory_body             TEXT,
  connectors_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(connectors_json)),
  message_allowlist_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(message_allowlist_json)),
  cron_json               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cron_json)),
  webhook_token_hash      TEXT,
  archived_at             TEXT,
  archived_by             TEXT,
  created_at              TEXT NOT NULL,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);
CREATE INDEX bots_active_by_workspace ON bots(workspace_id, created_at, id) WHERE archived_at IS NULL;
CREATE INDEX bots_workspace_list ON bots(workspace_id, archived_at, name, id);

CREATE TABLE bot_screen_slots (
  bot_id        TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slot          INTEGER NOT NULL CHECK (slot >= 0 AND slot < 6),
  UNIQUE (workspace_id, slot)
);

-- ---------------------------------------------------------------------------------------------
-- Threads and messages (ADR-0005)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE threads (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('chat', 'bus')),
  channel          TEXT NOT NULL,
  title            TEXT NOT NULL,
  turn_budget      INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  owner_bot_id     TEXT REFERENCES bots(id) ON DELETE SET NULL,
  external_key     TEXT,
  deadline         TEXT,
  -- The actor label of the person or principal who opened a side chat; NULL elsewhere.
  opened_by        TEXT,
  -- Private audience (ADR-0031 decision 9): only this person reads the conversation, whatever
  -- anyone's role. NULL is the workspace audience.
  private_to_user_id  TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  CHECK (private_to_user_id IS NULL OR kind = 'chat')
);
CREATE INDEX threads_private_to ON threads(private_to_user_id);
CREATE INDEX threads_workspace_updated ON threads(workspace_id, updated_at, id);
CREATE INDEX threads_owner_bot ON threads(owner_bot_id);
CREATE UNIQUE INDEX threads_channel_external_key
  ON threads(workspace_id, channel, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX threads_deadline ON threads(deadline) WHERE deadline IS NOT NULL;

CREATE TABLE thread_members (
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id         TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  last_seen_seq  INTEGER NOT NULL DEFAULT 0,
  joined_at      TEXT NOT NULL,
  PRIMARY KEY (thread_id, bot_id)
);
CREATE INDEX thread_members_bot ON thread_members(bot_id);

CREATE TRIGGER thread_members_same_workspace BEFORE INSERT ON thread_members
WHEN (SELECT workspace_id FROM threads WHERE id = NEW.thread_id)
  IS NOT (SELECT workspace_id FROM bots WHERE id = NEW.bot_id)
BEGIN SELECT RAISE(ABORT, 'thread member belongs to another workspace'); END;

CREATE TABLE thread_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
  author_id         TEXT NOT NULL,
  body              TEXT NOT NULL,
  attachments_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json)),
  mentions_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mentions_json)),
  relay_count       INTEGER NOT NULL DEFAULT 0,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  external_id       TEXT,
  must_reply        INTEGER NOT NULL DEFAULT 0 CHECK (must_reply IN (0, 1)),
  ts                TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX thread_messages_author ON thread_messages(author_id);
CREATE INDEX thread_messages_run ON thread_messages(run_id);
CREATE UNIQUE INDEX thread_messages_external_id
  ON thread_messages(thread_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE thread_pins (
  thread_id     TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL CHECK (position > 0),
  pinned_by     TEXT NOT NULL,
  pinned_at     TEXT NOT NULL,
  UNIQUE (workspace_id, position)
);

CREATE TABLE thread_routing_walks (
  message_id         TEXT PRIMARY KEY REFERENCES thread_messages(id) ON DELETE CASCADE,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'first_taker')),
  next_member_index  INTEGER NOT NULL DEFAULT 0,
  active_run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  taker_bot_id       TEXT REFERENCES bots(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
  created_at         TEXT NOT NULL
);
CREATE INDEX thread_routing_walks_pending
  ON thread_routing_walks(thread_id, status, created_at, message_id);
CREATE INDEX thread_routing_walks_run ON thread_routing_walks(active_run_id);
CREATE INDEX thread_routing_walks_taker ON thread_routing_walks(taker_bot_id);

CREATE TABLE thread_routing_walk_members (
  message_id  TEXT NOT NULL REFERENCES thread_routing_walks(message_id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, ordinal)
);
CREATE INDEX thread_routing_walk_members_bot ON thread_routing_walk_members(bot_id);

-- A bot's canonical private chat (ADR-0024): cleared when the thread stops having one member.
CREATE TABLE private_chats (
  bot_id     TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  thread_id  TEXT UNIQUE REFERENCES threads(id) ON DELETE SET NULL
);

CREATE TRIGGER private_chat_member_added AFTER INSERT ON thread_members
BEGIN
  UPDATE private_chats SET thread_id = NULL WHERE thread_id = NEW.thread_id
    AND (SELECT count(*) FROM thread_members WHERE thread_id = NEW.thread_id) <> 1;
END;

CREATE TRIGGER private_chat_member_removed AFTER DELETE ON thread_members
BEGIN
  UPDATE private_chats SET thread_id = NULL WHERE thread_id = OLD.thread_id
    AND bot_id = OLD.bot_id;
END;

CREATE TABLE private_mention_results (
  source_message_id  TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  recipient_name     TEXT NOT NULL,
  message_id         TEXT REFERENCES thread_messages(id) ON DELETE CASCADE,
  reason             TEXT,
  PRIMARY KEY (source_message_id, recipient_name)
);
CREATE INDEX private_mention_results_message ON private_mention_results(message_id);

CREATE TABLE incoming_handoffs (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id         TEXT NOT NULL UNIQUE REFERENCES thread_messages(id) ON DELETE CASCADE,
  source_message_id  TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  recipient_bot_id   TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL
);
CREATE INDEX incoming_handoffs_recipient ON incoming_handoffs(recipient_bot_id, seq);
CREATE INDEX incoming_handoffs_source ON incoming_handoffs(source_message_id);
CREATE INDEX incoming_handoffs_run ON incoming_handoffs(run_id);

CREATE TABLE incoming_handoff_reads (
  bot_id    TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  actor_id  TEXT NOT NULL,
  seen_seq  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, actor_id)
);

CREATE TABLE bot_sessions (
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sdk_session_id  TEXT NOT NULL,
  tainted         INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1)),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (bot_id, thread_id)
);
CREATE INDEX bot_sessions_thread ON bot_sessions(thread_id);

CREATE TABLE session_usage (
  bot_id               TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  model                TEXT NOT NULL,
  sdk_session_id       TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (bot_id, thread_id, model)
);
CREATE INDEX session_usage_thread ON session_usage(thread_id);

-- ---------------------------------------------------------------------------------------------
-- Runs and the ledger
-- ---------------------------------------------------------------------------------------------

-- Open vocabularies (ADR-0031 decision 5): adding a value is an INSERT, never a table rebuild.
CREATE TABLE run_trigger_kinds (kind TEXT PRIMARY KEY);
INSERT INTO run_trigger_kinds (kind) VALUES
  ('thread_message'), ('cron'), ('webhook'), ('approval'), ('welcome');

CREATE TABLE run_event_kinds (kind TEXT PRIMARY KEY);
INSERT INTO run_event_kinds (kind) VALUES
  ('tool_call'), ('tool_result'), ('thinking'), ('screenshot'), ('log'), ('approval'),
  ('takeover'), ('cap_breached'), ('pricing_missing'), ('turn_usage'), ('compact_boundary'),
  ('rule_file_modified'), ('memory_index'), ('memory_skipped'), ('cost_alert'),
  ('model_switch'), ('model_retry'), ('skill_used');

CREATE TABLE runs (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id                TEXT NOT NULL,
  thread_id             TEXT,
  lane                  TEXT NOT NULL CHECK (lane IN ('interactive', 'background')),
  trigger_kind          TEXT NOT NULL REFERENCES run_trigger_kinds(kind),
  trigger_ref           TEXT NOT NULL,
  trigger_payload_json  TEXT CHECK (trigger_payload_json IS NULL OR json_valid(trigger_payload_json)),
  status                TEXT NOT NULL CHECK (status IN (
                          'queued', 'running', 'waiting_approval_live', 'waiting_approval',
                          'waiting_browser', 'waiting_continuation', 'succeeded', 'silent', 'failed',
                          'cancelled', 'stopped')),
  attempt               INTEGER NOT NULL DEFAULT 1,
  sdk_session_id        TEXT,
  resume_payload_json   TEXT CHECK (resume_payload_json IS NULL OR json_valid(resume_payload_json)),
  delivered_seq         INTEGER,
  config_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  summary_json          TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  error                 TEXT,
  -- Fields the Gateway filters or joins on, read from the JSON the run already records.
  run_type                 TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.runType')) VIRTUAL,
  continuation_expires_at  TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.continuationExpiresAt')) VIRTUAL,
  resume_approval_id       TEXT GENERATED ALWAYS AS (json_extract(resume_payload_json, '$.approvalId')) VIRTUAL,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT,
  UNIQUE (workspace_id, id),
  -- The bot and the thread are in the run's workspace.
  FOREIGN KEY (workspace_id, bot_id) REFERENCES bots(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, thread_id) REFERENCES threads(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX runs_bot_lane_status ON runs(bot_id, lane, status);
CREATE INDEX runs_bot_trigger ON runs(bot_id, trigger_kind, trigger_ref);
CREATE INDEX runs_bot_type ON runs(bot_id, run_type);
CREATE INDEX runs_status_created ON runs(status, created_at);
CREATE INDEX runs_bot_created ON runs(bot_id, created_at, id);
CREATE INDEX runs_thread ON runs(thread_id, created_at, id);
CREATE INDEX runs_workspace_created ON runs(workspace_id, created_at, id);
CREATE INDEX runs_workspace_bot ON runs(workspace_id, bot_id);
CREATE INDEX runs_workspace_thread ON runs(workspace_id, thread_id);
CREATE INDEX runs_resume_approval ON runs(resume_approval_id) WHERE resume_approval_id IS NOT NULL;
CREATE INDEX runs_continuation_expiry
  ON runs(continuation_expires_at) WHERE continuation_expires_at IS NOT NULL;

CREATE TABLE run_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  sidecar_seq   INTEGER,
  kind          TEXT NOT NULL REFERENCES run_event_kinds(kind),
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  -- The sub-kind of a `log` event and of several others, filtered on by the ledger.
  source        TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.source')) VIRTUAL,
  ts            TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE UNIQUE INDEX run_events_sidecar_seq
  ON run_events(run_id, attempt, sidecar_seq) WHERE sidecar_seq IS NOT NULL;
CREATE INDEX run_events_kind_source ON run_events(run_id, kind, source);

CREATE TABLE run_usage (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt              INTEGER NOT NULL DEFAULT 1,
  model                TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL
);
CREATE UNIQUE INDEX run_usage_run_attempt_model ON run_usage(run_id, attempt, model);

CREATE TABLE model_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt              INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  ts                   TEXT NOT NULL,
  request_kind         TEXT NOT NULL CHECK (request_kind IN ('messages', 'count_tokens')),
  model                TEXT,
  served_model         TEXT,
  rewritten_from       TEXT,
  refusal              TEXT CHECK (refusal IS NULL OR refusal IN ('model_not_selected')),
  system_sha256        TEXT,
  stream               INTEGER NOT NULL CHECK (stream IN (0, 1)),
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_read_tokens    INTEGER,
  cache_create_tokens  INTEGER,
  thinking_tokens      INTEGER,
  UNIQUE (run_id, seq)
);

CREATE TABLE run_tokens (
  token_hash  TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX run_tokens_run ON run_tokens(run_id);

CREATE TABLE message_requests (
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id     TEXT NOT NULL,
  -- The request as the caller serialized it, compared byte for byte on a replay.
  request_body   TEXT NOT NULL,
  response_json  TEXT NOT NULL CHECK (json_valid(response_json)),
  PRIMARY KEY (run_id, request_id)
);

-- ---------------------------------------------------------------------------------------------
-- Approvals (ADR-0002) and the browser (ADR-0004, ADR-0008)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE approval_rules (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id                    TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  matcher_json              TEXT NOT NULL CHECK (json_valid(matcher_json)),
  decision                  TEXT NOT NULL CHECK (decision IN ('allow_always', 'deny')),
  created_from_approval_id  TEXT REFERENCES approvals(id) ON DELETE CASCADE,
  created_by                TEXT NOT NULL,
  created_at                TEXT NOT NULL
);
CREATE INDEX approval_rules_bot ON approval_rules(bot_id, created_at);
CREATE INDEX approval_rules_workspace ON approval_rules(workspace_id);
CREATE INDEX approval_rules_approval ON approval_rules(created_from_approval_id);

CREATE TABLE approvals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id                TEXT NOT NULL,
  bot_id                TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id             TEXT REFERENCES threads(id) ON DELETE SET NULL,
  message_id            TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('tool', 'egress', 'continuation')),
  action_json           TEXT NOT NULL CHECK (json_valid(action_json)),
  risk_level            TEXT NOT NULL CHECK (risk_level IN ('L0', 'L1', 'L2')),
  tool_use_id           TEXT,
  instruction           TEXT,
  display_summary_json  TEXT CHECK (display_summary_json IS NULL OR json_valid(display_summary_json)),
  wait_mode             TEXT NOT NULL CHECK (wait_mode IN ('live', 'deferred')),
  decision              TEXT CHECK (decision IN ('allow_once', 'allow_always', 'deny')),
  decided_by            TEXT,
  decided_at            TEXT,
  reason                TEXT,
  rule_id               TEXT REFERENCES approval_rules(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX approvals_run ON approvals(run_id);
CREATE INDEX approvals_workspace_run ON approvals(workspace_id, run_id);
CREATE INDEX approvals_workspace_decision ON approvals(workspace_id, decision, created_at, id);
CREATE INDEX approvals_decision_created ON approvals(decision, created_at);
CREATE INDEX approvals_thread ON approvals(thread_id, created_at, id);
CREATE INDEX approvals_bot ON approvals(bot_id);
CREATE INDEX approvals_message ON approvals(message_id);
CREATE INDEX approvals_rule ON approvals(rule_id);

CREATE TRIGGER approvals_same_run_bot BEFORE INSERT ON approvals
WHEN NEW.bot_id IS NOT (SELECT bot_id FROM runs WHERE id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'approval bot differs from its run'); END;

CREATE TABLE browser_locks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  holder_kind       TEXT NOT NULL CHECK (holder_kind IN ('run', 'human')),
  holder_run_id     TEXT,
  holder_principal  TEXT,
  tab_id            TEXT,
  acquired_at       TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
CREATE INDEX browser_locks_workspace ON browser_locks(workspace_id, holder_kind);
CREATE UNIQUE INDEX browser_locks_human ON browser_locks(workspace_id) WHERE holder_kind = 'human';
CREATE UNIQUE INDEX browser_locks_run ON browser_locks(workspace_id, holder_run_id)
  WHERE holder_kind = 'run';

CREATE TABLE browser_origin_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'held')),
  queued_at     TEXT NOT NULL,
  granted_at    TEXT,
  expires_at    TEXT NOT NULL
);
CREATE INDEX browser_origin_queue_fifo ON browser_origin_queue(workspace_id, origin, id);
CREATE UNIQUE INDEX browser_origin_queue_one_holder
  ON browser_origin_queue(workspace_id, origin) WHERE status = 'held';

-- ---------------------------------------------------------------------------------------------
-- Tasks (ADR-0021)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title               TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description         TEXT NOT NULL DEFAULT '',
  owner_bot_id        TEXT REFERENCES bots(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned', 'in_progress', 'blocked', 'delivered', 'accepted', 'cancelled')),
  blocked_reason      TEXT NOT NULL DEFAULT '',
  next_action         TEXT NOT NULL DEFAULT '',
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  output_schema_json  TEXT CHECK (output_schema_json IS NULL OR json_type(output_schema_json) = 'object'),
  output_json         TEXT
                      CHECK (output_json IS NULL OR (json_valid(output_json) AND status IN ('delivered', 'accepted'))),
  delivered_at        TEXT,
  delivered_by        TEXT
                      CHECK (delivered_by IS NULL
                        OR (status IN ('delivered', 'accepted')
                          AND (delivered_by IS 'human:web'
                            OR (delivered_by LIKE 'user:%' AND length(delivered_by) > 5)
                            OR (delivered_by LIKE 'bot:%' AND length(delivered_by) > 4)))),
  accepted_at         TEXT,
  accepted_by         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (status <> 'blocked' OR (length(trim(blocked_reason)) > 0 AND length(trim(next_action)) > 0)),
  CHECK (status NOT IN ('delivered', 'accepted') OR delivered_at IS NOT NULL),
  CHECK ((status = 'accepted' AND accepted_at IS NOT NULL
          AND (accepted_by IS 'human:web' OR (accepted_by LIKE 'user:%' AND length(accepted_by) > 5)))
      OR (status <> 'accepted' AND accepted_at IS NULL AND accepted_by IS NULL))
);
CREATE INDEX tasks_workspace_updated ON tasks(workspace_id, updated_at DESC);
CREATE INDEX tasks_owner_bot ON tasks(owner_bot_id);
CREATE INDEX tasks_workspace_status ON tasks(workspace_id, status, updated_at, id);

CREATE TRIGGER tasks_owner_same_workspace BEFORE INSERT ON tasks
WHEN NEW.owner_bot_id IS NOT NULL
  AND (SELECT workspace_id FROM bots WHERE id = NEW.owner_bot_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'task owner bot belongs to another workspace'); END;

CREATE TRIGGER tasks_owner_same_workspace_update BEFORE UPDATE OF owner_bot_id ON tasks
WHEN NEW.owner_bot_id IS NOT NULL
  AND (SELECT workspace_id FROM bots WHERE id = NEW.owner_bot_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'task owner bot belongs to another workspace'); END;

-- A task's links, in the order the task lists them.
CREATE TABLE task_threads (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, ordinal),
  UNIQUE (task_id, thread_id)
);
CREATE INDEX task_threads_thread ON task_threads(thread_id);

CREATE TABLE task_runs (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, ordinal),
  UNIQUE (task_id, run_id)
);
CREATE INDEX task_runs_run ON task_runs(run_id);

CREATE TABLE task_artifacts (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  path     TEXT NOT NULL,
  label    TEXT NOT NULL,
  run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
  PRIMARY KEY (task_id, ordinal),
  UNIQUE (task_id, path)
);
CREATE INDEX task_artifacts_run ON task_artifacts(run_id);

-- ---------------------------------------------------------------------------------------------
-- Cost alerts (ADR-0018), per workspace (ADR-0031 Q3)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE cost_alert_rules (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('known_cost', 'unpriced_usage')),
  window_kind    TEXT NOT NULL CHECK (window_kind IN ('day', 'month')),
  bot_id         TEXT REFERENCES bots(id) ON DELETE CASCADE,
  threshold_usd  REAL CHECK (threshold_usd IS NULL OR threshold_usd > 0),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX cost_alert_rules_workspace ON cost_alert_rules(workspace_id, created_at, id);
CREATE INDEX cost_alert_rules_bot ON cost_alert_rules(bot_id);

CREATE TRIGGER cost_alert_rules_same_workspace BEFORE INSERT ON cost_alert_rules
WHEN NEW.bot_id IS NOT NULL
  AND (SELECT workspace_id FROM bots WHERE id = NEW.bot_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'cost alert rule bot belongs to another workspace'); END;

CREATE TABLE cost_alerts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- No foreign key: deleting a rule keeps the alerts it fired, which copy its facts (ADR-0018).
  rule_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('known_cost', 'unpriced_usage')),
  window_kind           TEXT NOT NULL CHECK (window_kind IN ('day', 'month')),
  window_key            TEXT NOT NULL,
  bot_id                TEXT REFERENCES bots(id) ON DELETE CASCADE,
  threshold_usd         REAL,
  run_id                TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_count             INTEGER NOT NULL,
  usage_count           INTEGER NOT NULL,
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL,
  cache_create_tokens   INTEGER NOT NULL,
  priced_usage_count    INTEGER NOT NULL,
  unpriced_usage_count  INTEGER NOT NULL,
  known_cost_usd        REAL,
  fired_at              TEXT NOT NULL,
  acknowledged_at       TEXT,
  acknowledged_by       TEXT,
  UNIQUE (rule_id, window_key)
);
CREATE INDEX cost_alerts_workspace ON cost_alerts(workspace_id, acknowledged_at, fired_at, id);
CREATE INDEX cost_alerts_open ON cost_alerts(acknowledged_at, fired_at);
CREATE INDEX cost_alerts_bot ON cost_alerts(bot_id);
CREATE INDEX cost_alerts_run ON cost_alerts(run_id);

CREATE TRIGGER cost_alerts_rule_workspace BEFORE INSERT ON cost_alerts
WHEN (SELECT workspace_id FROM cost_alert_rules WHERE id = NEW.rule_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'cost alert workspace differs from its rule'); END;

-- ---------------------------------------------------------------------------------------------
-- Knowledge (tenant-wide) and learned memory (ADR-0011)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE knowledge_docs (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  path           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  source_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  approved_by    TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX knowledge_docs_tenant ON knowledge_docs(tenant_id, updated_at DESC, id DESC);
CREATE INDEX knowledge_docs_run ON knowledge_docs(source_run_id);

CREATE TRIGGER knowledge_docs_tenant_fixed BEFORE UPDATE OF tenant_id ON knowledge_docs
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN SELECT RAISE(ABORT, 'knowledge cannot move between tenants'); END;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, body, content='knowledge_docs', content_rowid='rowid');

CREATE TRIGGER knowledge_docs_ai AFTER INSERT ON knowledge_docs BEGIN
  INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER knowledge_docs_ad AFTER DELETE ON knowledge_docs BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER knowledge_docs_au AFTER UPDATE OF title, body ON knowledge_docs BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE knowledge_versions (
  document_id    TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE RESTRICT,
  version        INTEGER NOT NULL,
  path           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  source_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  approved_by    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (document_id, version)
);
CREATE INDEX knowledge_versions_run ON knowledge_versions(source_run_id);

CREATE TABLE knowledge_proposals (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  source_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  document_id    TEXT REFERENCES knowledge_docs(id),
  created_at     TEXT NOT NULL,
  reviewed_by    TEXT,
  reviewed_at    TEXT
);
CREATE INDEX knowledge_proposals_tenant ON knowledge_proposals(tenant_id, status, created_at DESC, id DESC);
CREATE INDEX knowledge_proposals_run ON knowledge_proposals(source_run_id);
CREATE INDEX knowledge_proposals_document ON knowledge_proposals(document_id);

CREATE TRIGGER knowledge_proposals_tenant_fixed BEFORE UPDATE OF tenant_id ON knowledge_proposals
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN SELECT RAISE(ABORT, 'knowledge cannot move between tenants'); END;

CREATE TRIGGER knowledge_proposals_doc_tenant BEFORE UPDATE OF document_id ON knowledge_proposals
WHEN NEW.document_id IS NOT NULL
  AND (SELECT tenant_id FROM knowledge_docs WHERE id = NEW.document_id) IS NOT NEW.tenant_id
BEGIN SELECT RAISE(ABORT, 'knowledge document belongs to another tenant'); END;

CREATE TABLE memory_entries (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope                TEXT NOT NULL CHECK (scope IN ('task', 'workspace', 'bot')),
  kind                 TEXT NOT NULL CHECK (kind IN ('note', 'candidate', 'episode')),
  bot_id               TEXT REFERENCES bots(id) ON DELETE CASCADE,
  thread_id            TEXT REFERENCES threads(id) ON DELETE CASCADE,
  body                 TEXT NOT NULL,
  normalized_body      TEXT NOT NULL,
  authority            TEXT NOT NULL CHECK (authority IN ('fact', 'preference', 'procedure')),
  trust                TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
  source_run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  source_kind          TEXT NOT NULL
                       CHECK (source_kind IN ('human', 'bot_self', 'other_bot', 'tool', 'page', 'webhook')),
  derived_from_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(derived_from_json)),
  observed_at          TEXT NOT NULL,
  valid_from           TEXT NOT NULL,
  invalid_at           TEXT,
  superseded_by        TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  last_confirmed_at    TEXT,
  ttl_seconds          INTEGER CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  version              INTEGER NOT NULL DEFAULT 1,
  tombstoned           INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
  -- Task entries distilled into an episode leave every later index.
  episode_id           TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  -- Candidates and episodes a consolidation run has taken as input.
  consolidated_by_run  TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (scope <> 'task' OR thread_id IS NOT NULL),
  CHECK (scope <> 'bot' OR bot_id IS NOT NULL)
);
CREATE INDEX memory_entries_bot ON memory_entries(bot_id);
CREATE INDEX memory_entries_workspace_bot ON memory_entries(workspace_id, bot_id, scope);
CREATE INDEX memory_entries_dedupe ON memory_entries(workspace_id, scope, normalized_body);
CREATE INDEX memory_entries_thread ON memory_entries(thread_id, scope);
CREATE INDEX memory_entries_workspace_scope ON memory_entries(workspace_id, scope, kind, tombstoned);
CREATE INDEX memory_entries_run ON memory_entries(source_run_id);
CREATE INDEX memory_entries_superseded ON memory_entries(superseded_by);
CREATE INDEX memory_entries_episode ON memory_entries(episode_id);
CREATE INDEX memory_entries_consolidated ON memory_entries(consolidated_by_run);
CREATE INDEX memory_entries_workspace_list ON memory_entries(workspace_id, tombstoned, observed_at, id);

CREATE TRIGGER memory_entries_same_workspace BEFORE INSERT ON memory_entries
WHEN (NEW.bot_id IS NOT NULL
      AND (SELECT workspace_id FROM bots WHERE id = NEW.bot_id) IS NOT NEW.workspace_id)
  OR (NEW.thread_id IS NOT NULL
      AND (SELECT workspace_id FROM threads WHERE id = NEW.thread_id) IS NOT NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'memory entry references another workspace'); END;

CREATE VIRTUAL TABLE memory_fts USING fts5(body, content='memory_entries', content_rowid='rowid');

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER memory_entries_au AFTER UPDATE OF body ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO memory_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TABLE memory_versions (
  entry_id     TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  op           TEXT NOT NULL
               CHECK (op IN ('create', 'edit', 'forget', 'undo', 'confirm', 'supersede', 'consolidate')),
  body         TEXT NOT NULL,
  authority    TEXT NOT NULL CHECK (authority IN ('fact', 'preference', 'procedure')),
  trust        TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
  source_kind  TEXT NOT NULL
               CHECK (source_kind IN ('human', 'bot_self', 'other_bot', 'tool', 'page', 'webhook')),
  redacted     INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
  by           TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (entry_id, version)
);

-- History is immutable except for redaction, and is deleted only by a permanent delete.
CREATE TRIGGER memory_versions_immutable BEFORE UPDATE ON memory_versions
WHEN NOT (
  NEW.redacted = 1 AND NEW.body = '' AND NEW.entry_id = OLD.entry_id
  AND NEW.version = OLD.version AND NEW.op = OLD.op AND NEW.by = OLD.by
  AND NEW.created_at = OLD.created_at AND NEW.authority = OLD.authority
  AND NEW.trust = OLD.trust AND NEW.source_kind = OLD.source_kind
)
BEGIN SELECT RAISE(ABORT, 'memory versions are immutable'); END;

CREATE TRIGGER memory_versions_no_delete BEFORE DELETE ON memory_versions
WHEN NOT EXISTS (SELECT 1 FROM permanent_delete_context)
BEGIN SELECT RAISE(ABORT, 'memory versions are immutable'); END;

CREATE TABLE memory_suggestions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id          TEXT REFERENCES threads(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  body               TEXT NOT NULL,
  proposed_scope     TEXT NOT NULL DEFAULT 'bot' CHECK (proposed_scope IN ('task', 'workspace', 'bot')),
  authority          TEXT NOT NULL DEFAULT 'procedure'
                     CHECK (authority IN ('fact', 'preference', 'procedure')),
  trust              TEXT NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('trusted', 'untrusted')),
  source_kind        TEXT NOT NULL DEFAULT 'tool'
                     CHECK (source_kind IN ('human', 'bot_self', 'other_bot', 'tool', 'page', 'webhook')),
  reasons_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
  conflicts_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicts_json)),
  derived_from_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(derived_from_json)),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  entry_id           TEXT REFERENCES memory_entries(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  UNIQUE (run_id, ordinal)
);
CREATE INDEX memory_suggestions_queue
  ON memory_suggestions(workspace_id, status, created_at DESC, id DESC);
CREATE INDEX memory_suggestions_review
  ON memory_suggestions(status, bot_id, created_at DESC, id DESC);
CREATE INDEX memory_suggestions_bot ON memory_suggestions(bot_id);
CREATE INDEX memory_suggestions_thread ON memory_suggestions(thread_id);
CREATE INDEX memory_suggestions_entry ON memory_suggestions(entry_id);

-- ---------------------------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------------------------

CREATE TABLE skills (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('installed', 'authored')),
  stage            TEXT NOT NULL CHECK (stage IN ('provisional', 'active', 'stale', 'archived')),
  author_bot_id    TEXT REFERENCES bots(id) ON DELETE SET NULL,
  current_version  INTEGER NOT NULL DEFAULT 0,
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  provenance       TEXT,
  listed_since     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE INDEX skills_author_bot ON skills(author_bot_id);

CREATE TABLE skill_versions (
  skill_id           TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL CHECK (version >= 1),
  op                 TEXT NOT NULL CHECK (op IN ('author', 'revise', 'install', 'undo')),
  files_json         TEXT NOT NULL CHECK (json_valid(files_json)),
  sha256             TEXT NOT NULL,
  description        TEXT NOT NULL,
  review             TEXT NOT NULL CHECK (review IN ('pending', 'cleared', 'rejected')),
  hold_reasons_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hold_reasons_json)),
  findings_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings_json)),
  source_run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  derived_from_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(derived_from_json)),
  by                 TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  decided_by         TEXT,
  decided_at         TEXT,
  PRIMARY KEY (skill_id, version)
);
CREATE INDEX skill_versions_pending ON skill_versions(review) WHERE review = 'pending';
CREATE INDEX skill_versions_run ON skill_versions(source_run_id);

CREATE TRIGGER skill_versions_immutable
BEFORE UPDATE OF skill_id, version, op, files_json, sha256, description ON skill_versions
BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;

CREATE TABLE skill_assignments (
  skill_id       TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  bot_id         TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  basis          TEXT NOT NULL CHECK (basis IN ('human', 'evidence')),
  evidence_json  TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  by             TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (skill_id, bot_id)
);
CREATE INDEX skill_assignments_bot ON skill_assignments(bot_id);

CREATE TABLE skill_usage (
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  bot_id        TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  last_used_at  TEXT NOT NULL,
  uses          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (skill_id, bot_id)
);
CREATE INDEX skill_usage_bot ON skill_usage(bot_id);

-- ---------------------------------------------------------------------------------------------
-- Connectors (ADR-0012), integrations (ADR-0013) and channels (ADR-0017)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE connectors (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  config_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  secret_id     TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  public_url    INTEGER NOT NULL DEFAULT 0 CHECK (public_url IN (0, 1)),
  created_at    TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE INDEX connectors_secret ON connectors(secret_id);
CREATE INDEX connectors_workspace_created ON connectors(workspace_id, created_at, id);

CREATE TABLE connector_validations (
  connector_id   TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  validation_id  TEXT NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bot_id         TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  content_hash   TEXT NOT NULL,
  valid          INTEGER NOT NULL CHECK (valid IN (0, 1)),
  effect         TEXT NOT NULL CHECK (effect IN ('read', 'reversible', 'external')),
  summary        TEXT NOT NULL,
  errors_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors_json)),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  PRIMARY KEY (connector_id, validation_id)
);
CREATE INDEX connector_validations_run ON connector_validations(run_id);
CREATE INDEX connector_validations_bot ON connector_validations(bot_id);

CREATE TABLE connector_receipts (
  connector_id     TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  receipt_id       TEXT NOT NULL,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  content_hash     TEXT NOT NULL,
  validation_id    TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (connector_id, receipt_id),
  UNIQUE (connector_id, content_hash, idempotency_key)
);
CREATE INDEX connector_receipts_workspace ON connector_receipts(workspace_id);
CREATE INDEX connector_receipts_run ON connector_receipts(run_id);
CREATE INDEX connector_receipts_bot ON connector_receipts(bot_id);

CREATE TRIGGER connector_receipts_same_workspace BEFORE INSERT ON connector_receipts
WHEN (SELECT workspace_id FROM connectors WHERE id = NEW.connector_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'connector receipt belongs to another workspace'); END;

CREATE TRIGGER connector_receipts_immutable_update BEFORE UPDATE ON connector_receipts
BEGIN SELECT RAISE(ABORT, 'connector receipts are immutable'); END;

CREATE TRIGGER connector_receipts_immutable_delete BEFORE DELETE ON connector_receipts
WHEN NOT EXISTS (SELECT 1 FROM permanent_delete_context)
BEGIN SELECT RAISE(ABORT, 'connector receipts are immutable'); END;

CREATE TABLE connector_receipt_versions (
  connector_id  TEXT NOT NULL,
  receipt_id    TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version >= 1),
  status        TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'rejected')),
  result_ref    TEXT,
  detail        TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (connector_id, receipt_id, version),
  FOREIGN KEY (connector_id, receipt_id)
    REFERENCES connector_receipts(connector_id, receipt_id) ON DELETE CASCADE
);

CREATE TRIGGER connector_receipt_versions_immutable_update BEFORE UPDATE ON connector_receipt_versions
BEGIN SELECT RAISE(ABORT, 'connector receipt versions are immutable; add a version'); END;

CREATE TRIGGER connector_receipt_versions_immutable_delete BEFORE DELETE ON connector_receipt_versions
WHEN NOT EXISTS (SELECT 1 FROM permanent_delete_context)
BEGIN SELECT RAISE(ABORT, 'connector receipt versions are immutable'); END;

CREATE TABLE integration_providers (
  service          TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  auth_kinds_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(auth_kinds_json)),
  adopted_at       TEXT NOT NULL
);

CREATE TABLE integration_action_overrides (
  action_id        TEXT PRIMARY KEY,
  lowerable_to_l1  INTEGER NOT NULL DEFAULT 0 CHECK (lowerable_to_l1 IN (0, 1)),
  never_lowerable  INTEGER NOT NULL DEFAULT 0 CHECK (never_lowerable IN (0, 1)),
  updated_at       TEXT NOT NULL
);
-- Writes that can share with anyone or transfer ownership (ADR-0013 amendment 1).
INSERT INTO integration_action_overrides (action_id, lowerable_to_l1, never_lowerable, updated_at)
VALUES
  ('googledrive.permissions.create', 0, 1, '2026-09-29T00:00:00.000Z'),
  ('googledrive.permissions.update', 0, 1, '2026-09-29T00:00:00.000Z');

CREATE TABLE integration_catalog_token (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  runtime_token_id  TEXT NOT NULL,
  secret_id         TEXT NOT NULL REFERENCES secrets(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX integration_catalog_token_secret ON integration_catalog_token(secret_id);

CREATE TABLE integration_workspace_tokens (
  workspace_id      TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_token_id  TEXT NOT NULL,
  secret_id         TEXT NOT NULL REFERENCES secrets(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX integration_workspace_tokens_secret ON integration_workspace_tokens(secret_id);

CREATE TABLE integration_connections (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service                  TEXT NOT NULL,
  connection_name          TEXT NOT NULL,
  runtime_connection_name  TEXT NOT NULL,
  runtime_connection_id    TEXT NOT NULL,
  auth_kind                TEXT NOT NULL CHECK (auth_kind IN ('oauth', 'api_key')),
  created_at               TEXT NOT NULL,
  revoked_at               TEXT
);
CREATE INDEX integration_connections_workspace
  ON integration_connections(workspace_id, created_at, id);
CREATE UNIQUE INDEX integration_connections_live_name
  ON integration_connections(workspace_id, service, connection_name) WHERE revoked_at IS NULL;

CREATE TABLE integration_oauth_states (
  -- Only the sha256 of the runtime's `state` is kept; a state is used once and expires.
  state_hash               TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id               TEXT REFERENCES auth_sessions(id) ON DELETE SET NULL,
  service                  TEXT NOT NULL,
  connection_name          TEXT NOT NULL,
  runtime_connection_name  TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  used_at                  TEXT
);
CREATE INDEX integration_oauth_states_workspace ON integration_oauth_states(workspace_id);
CREATE INDEX integration_oauth_states_session ON integration_oauth_states(session_id);

CREATE TABLE channel_connections (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id       TEXT NOT NULL,
  plugin_version  TEXT NOT NULL,
  method          TEXT NOT NULL,
  -- No action: a bot with a live channel is not purged. Checked at statement end, so a
  -- workspace purge that removes both passes.
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  config_json     TEXT NOT NULL CHECK (json_valid(config_json)),
  secret_id       TEXT REFERENCES secrets(id) ON DELETE SET NULL,
  phase           TEXT NOT NULL,
  message         TEXT,
  account         TEXT,
  details_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (workspace_id, plugin_id)
);
CREATE INDEX channel_connections_plugin ON channel_connections(plugin_id);
CREATE INDEX channel_connections_bot ON channel_connections(bot_id);
CREATE INDEX channel_connections_secret ON channel_connections(secret_id);
