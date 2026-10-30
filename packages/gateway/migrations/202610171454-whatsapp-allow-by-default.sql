-- ADR-0017 amendment 3 and ADR-0047 amendment 1 A3 (owner ruling 2026-10-17): WhatsApp admits
-- every sender unless the connection's blocklist names them, like the other ABI-2 providers.
--
-- 1. A connection records when its plugin's sender admission changed under it, so the
--    Integrations card can say once that every sender is now admitted. NULL for a connection
--    created after the change.
ALTER TABLE channel_connections ADD COLUMN admission_changed_at TEXT;

-- 2. Every stored WhatsApp allowlist is dropped and every WhatsApp connection is stamped. Nothing
--    is turned into a block: a list of who was allowed says nothing about whom to keep out.
UPDATE channel_connections
   SET config_json = json_remove(config_json, '$.allowedSenders'),
       admission_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE plugin_id = 'whatsapp';
