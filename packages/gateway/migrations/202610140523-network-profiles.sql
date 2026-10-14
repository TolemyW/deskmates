-- Network profiles (ADR-0027 amendment 1): named, durable LAN grants the root defines and
-- selects per workspace. Installation-level, so no tenant or workspace column on the profile.

-- Decisions 6, 7 and 9. `rules_json` is a document read whole and validated by the Gateway
-- (contracts `parseNetworkRules`); nothing filters, joins or orders on its content.
CREATE TABLE network_profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '',
  rules_json   TEXT NOT NULL CHECK (json_valid(rules_json)),
  expires_at   TEXT,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Decisions 12 and 13: an explicit selection per workspace, optionally expiring.
CREATE TABLE workspace_network_profiles (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL REFERENCES network_profiles(id) ON DELETE CASCADE,
  expires_at    TEXT,
  selected_by   TEXT NOT NULL,
  selected_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id)
);
-- The workspaces a profile change is published to.
CREATE INDEX workspace_network_profiles_profile ON workspace_network_profiles(profile_id);

INSERT INTO audit_actions (action) VALUES
  ('network_policy.publish'),
  ('network_profile.create'),
  ('network_profile.delete'),
  ('network_profile.update'),
  ('workspace.network_profiles_set');
