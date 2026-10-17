-- Network profile ownership and the open-internet switch (ADR-0027 amendment 1 decisions 12 and
-- 13, owner-decided 2026-10-14).

-- Decision 12: a profile a workspace Owner created names its creator and is available where that
-- person is Owner; NULL is a root profile, available to every workspace.
ALTER TABLE network_profiles ADD COLUMN owner_user_id TEXT;
-- The profiles one person may edit, and the availability join on the creator.
CREATE INDEX network_profiles_owner ON network_profiles(owner_user_id);

-- Decision 13: whether an open-internet (`*`) workspace may select profiles. No row is the
-- default, allowed.
CREATE TABLE workspace_network_settings (
  workspace_id               TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  profiles_on_open_internet  INTEGER NOT NULL DEFAULT 1 CHECK (profiles_on_open_internet IN (0, 1)),
  updated_by                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

INSERT INTO audit_actions (action) VALUES ('workspace.network_settings_set');
