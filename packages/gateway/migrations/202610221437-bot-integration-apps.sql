-- ADR-0055 decision 1: the connected apps a bot may use. NULL is every app the workspace has
-- connected, which every existing bot keeps; a JSON array lists integration service ids.
ALTER TABLE bots ADD COLUMN integration_apps_json TEXT
  CHECK (integration_apps_json IS NULL OR json_valid(integration_apps_json));
