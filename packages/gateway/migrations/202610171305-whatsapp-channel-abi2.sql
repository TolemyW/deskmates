-- ADR-0047 amendment 1: the release-bundled WhatsApp plugin moves from ChannelPlugin ABI 1 to
-- ABI 2. Its existing connections, their bound threads and messages move in place; nothing is
-- re-linked, and the QR state directory and the Secret Store record stay where they are (both are
-- keyed by the connection id, which does not change). Data only: no table is rebuilt.
--
-- 1. Each WhatsApp connection becomes an ABI-2 connection of plugin version 2.0.0, binding and
--    credential generation 1, still single-connection (ADR-0017 amendment 1 P4). Its account key
--    is the pending key `whatsapp:pending:<connection id>`; the plugin claims the real one
--    (`whatsapp:linked:<number>` or `whatsapp:cloud:<phone number id>`) through the host when it
--    reopens the connection, so the uniqueness check of ADR-0047 decision 7 runs in one place.
UPDATE channel_connections
   SET api_version = 2,
       plugin_version = '2.0.0',
       account_key = 'whatsapp:pending:' || id,
       account_label = NULL,
       binding_generation = 1,
       credential_generation = 1,
       multiple_connections = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE plugin_id = 'whatsapp' AND api_version = 1;

-- 2. Every WhatsApp thread of a workspace that holds a WhatsApp connection is bound to it at
--    generation 1, the ABI-1 host's reach. The external key gains the host's prefix
--    `<connection id>:1:`; what follows is the unchanged conversation key
--    (`<phone number id>:<wa_id>` or `web:<account>:<wa_id>`), so the next message of a known
--    conversation resolves the same thread. Message external ids stay as they are: the host
--    deduplicates them per connection.
UPDATE threads
   SET channel_connection_id = (
         SELECT c.id FROM channel_connections c
          WHERE c.workspace_id = threads.workspace_id AND c.plugin_id = 'whatsapp'),
       binding_generation = 1,
       external_key = (
         SELECT c.id FROM channel_connections c
          WHERE c.workspace_id = threads.workspace_id AND c.plugin_id = 'whatsapp')
         || ':1:' || external_key
 WHERE channel = 'whatsapp'
   AND external_key IS NOT NULL
   AND channel_connection_id IS NULL
   AND EXISTS (
         SELECT 1 FROM channel_connections c
          WHERE c.workspace_id = threads.workspace_id AND c.plugin_id = 'whatsapp');
