-- A person publishes apps too (ADR-0035 decision 1, owner-decided 2026-10-14): such a row has no
-- bot or run and names its publisher's actor label (`user:<id>`), as `revoked_by` does. A bot's
-- publication leaves it NULL.
ALTER TABLE app_shares ADD COLUMN published_by TEXT;
