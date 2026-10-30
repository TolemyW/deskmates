-- ADR-0045 (accepted under owner delegation, 2026-10-17): the workspace credential vault. A row in
-- `vault_entries` is catalog metadata; the value (username and password, or a token) is one
-- AES-256-GCM blob in `secrets`, owned by the entry's workspace, so the database never holds a
-- plaintext credential. A replacement points the entry at a new secret and bumps `revision`; the
-- old blob is deleted in the same transaction. Deleting an entry, or its workspace, deletes its
-- blob (the trigger below); a historical backup may still hold the encrypted copy.
CREATE TABLE vault_entries (
  id             TEXT NOT NULL PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  purpose        TEXT,
  type           TEXT NOT NULL CHECK (type IN ('browser_login', 'http_header_token')),
  target_origin  TEXT NOT NULL,
  is_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  secret_id      TEXT NOT NULL REFERENCES secrets(id),
  has_username   INTEGER NOT NULL DEFAULT 0 CHECK (has_username IN (0, 1)),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX vault_entries_secret ON vault_entries (secret_id);

CREATE TRIGGER vault_entries_secret_delete AFTER DELETE ON vault_entries
BEGIN
  DELETE FROM secrets
   WHERE id = OLD.secret_id AND owner_kind = 'workspace' AND owner_id = OLD.workspace_id;
END;

-- Decision 6: the operator-maintained request definitions of a token entry, read whole.
CREATE TABLE vault_request_definitions (
  id               TEXT NOT NULL PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id         TEXT NOT NULL,
  position         INTEGER NOT NULL,
  definition_json  TEXT NOT NULL CHECK (json_valid(definition_json)),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES vault_entries (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, entry_id, position)
);

-- Decision 8: the typed outcomes, a lookup so a later status is one INSERT.
CREATE TABLE vault_use_status_kinds (status TEXT PRIMARY KEY);
INSERT INTO vault_use_status_kinds (status) VALUES
  ('filled'), ('completed'), ('not_found'), ('disabled'), ('revision_mismatch'), ('wrong_type'),
  ('request_not_found'), ('invalid_params'), ('no_grant'), ('takeover'), ('workspace_not_running'),
  ('vault_unavailable'), ('egress_refused'), ('address_refused'), ('target_mismatch'),
  ('frame_mismatch'), ('stale_tab'), ('missing_fields'), ('ambiguous_fields'),
  ('not_password_field'), ('navigated'), ('fill_failed'), ('auth_failed'), ('http_error'),
  ('redirect_refused'), ('tls_failed'), ('network_error'), ('result_withheld'), ('unknown');

-- Decisions 6 and 7: one row per credential release, bound to the approval that released it, so a
-- repeated request returns the recorded answer and an interrupted one (`in_flight` left behind)
-- is reported as unknown, never executed again. No value is stored; `result_json` is the answer
-- the tool got, already without credential echoes. The entry id is kept without a foreign key:
-- the record outlives a deleted entry.
CREATE TABLE vault_uses (
  id           TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  approval_id  TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE CASCADE,
  tool_use_id  TEXT NOT NULL,
  operation    TEXT NOT NULL CHECK (operation IN ('fill', 'request')),
  request_id   TEXT,
  target       TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('in_flight', 'done')),
  status       TEXT REFERENCES vault_use_status_kinds (status),
  http_status  INTEGER,
  result_json  TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  UNIQUE (run_id, tool_use_id)
);
CREATE INDEX vault_uses_entry ON vault_uses (workspace_id, entry_id, created_at);

INSERT INTO audit_actions (action) VALUES
  ('vault.entry_create'), ('vault.entry_delete'), ('vault.entry_update'), ('vault.requests_set'),
  ('vault.value_replace');
