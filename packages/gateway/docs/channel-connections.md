# Channel connections (ADR-0047)

The Gateway side of ChannelPlugin ABI 2: one connection is one verified external identity bound
to one Bot. The plugin author's view is
[`packages/channels/docs/abi-2-provider-plugins.md`](../../channels/docs/abi-2-provider-plugins.md).
WhatsApp moved to ABI 2 in ADR-0047 amendment 1 and keeps one connection per workspace; since
ADR-0017 amendment 3 it admits every sender unless the connection's blocklist names them, like the
other ABI-2 plugins. ABI-1 plugins (none in the release) keep the plugin-wide host.

## Code

- `channels/channel-manager.ts`: both ABIs. ABI-1 runtimes are created at startup; an ABI-2
  runtime is created on first verify, open or restore of one of its connections. Connect, the
  lifecycle commands, rebind, relink and the blocklist.
- `channels/connection-host.ts`: the ABI-2 host. `issue` makes every earlier host of the
  connection stale; every call checks connection, binding generation and host. It applies the
  plugin's `senderAdmission` (the blocklist by default; an allowlist config field, which no
  release plugin declares any more) to `receive`,
  `decideApproval`, `beginSend` and `admits`, and stores a `link` method's `claimIdentity`.
- `channels/plugin-host-v1.ts`: the ABI-1 host, narrowed to workspaces where the plugin has a
  connection and to threads without a binding generation.
- `channels/channel-store.ts`, `sender-blocks.ts`, `outbound-receipts.ts`: the tables below.
- `ChannelManager.archiveWorkspace` and `restoreWorkspace`: called by the trash lifecycle when a
  workspace moves to Trash and back (ADR-0017 amendment 1 P6). Archive makes each connection's
  host stale, closes it with the `archive` reason (no logout), records outbound it left unsent
  `cancelled` (`workspace_archived`) and reports the Gateway's own phase `archived`; state
  directories, secret records and generations stay. Every host call refuses while the workspace
  is in Trash, the webhook route answers 503, lifecycle commands, rebind and blocklist changes are
  409, and a Gateway restart does not open those connections. Restore opens each one with the
  `restore` reason. An ABI-1 runtime has no per-connection stop: its host stops reaching the
  workspace instead.
- `ChannelManager.permanentlyDeleteWorkspace`: called by the trash lifecycle before a workspace's
  rows are purged; closes its connections as a disconnect does and removes its channel state
  directories (decision 14). A connection the archive already closed is not live, so a QR link
  is not logged out at the provider then; its local credentials go with the directory.
- `channels/channel-run-stamp.ts`: `runs.config_json.channelConnection` for runs a channel thread
  starts.
- `files/channel-image-upload.ts`: inbound images through the Web upload path.

## Tables (migration `202610171104-channel-connection-identity.sql`)

- `channel_connections` gains `api_version`, `account_key` and `account_label` (the verified
  identity; ADR-0004 item 4 keeps the word "identity" out of the schema), `binding_generation`,
  `credential_generation` and `multiple_connections`. `(plugin_id, account_key)` is unique; rows
  without `multiple_connections` keep `(workspace_id, plugin_id)` unique.
- `threads.channel_connection_id` and `threads.binding_generation` on ABI-2 threads.
- `channel_sender_blocks`: the per-connection blocklist.
- `channel_outbound_receipts`: one row per relayed message (`sent`, `cancelled`, `blocked`) with
  connection, binding generation and credential generation.

## WhatsApp's move to ABI 2 (migration `202610171305-whatsapp-channel-abi2.sql`)

Data only. Every ABI-1 WhatsApp connection becomes ABI 2, plugin version 2.0.0, generation 1,
single-connection, with the pending key `whatsapp:pending:<connection id>`; the plugin claims its
number on restore. Every WhatsApp thread of the workspace gets `channel_connection_id`, generation
1 and the external-key prefix `<connection id>:1:` before its unchanged conversation key. Bot,
secret record and state directory are untouched; nothing is re-linked. A number two workspaces
had both linked is refused for the second at its claim. A relink keeps the secrets it is not
given.

## WhatsApp admits by default (migration `202610171454-whatsapp-allow-by-default.sql`)

ADR-0017 amendment 3. `channel_connections.admission_changed_at` (`admissionChangedAt` in the
API) records when a connection's plugin stopped using an allowlist under it. The migration removes
`allowedSenders` from every WhatsApp connection's config, stamps those connections and blocks
nobody; the Integrations card says once per viewer that every sender is now admitted.

## Routes

The plugin-addressed routes of ADR-0017 amendment 1 still serve a workspace's only connection of
a plugin. Every connection is also addressed by id (Owner or Admin):

| Route | Does |
|---|---|
| `POST /api/workspaces/:workspaceId/channels/:pluginId/connect` | ABI 2: verify, refuse a taken identity (`channel_identity_in_use`, 409), store, open |
| `POST /api/workspaces/:workspaceId/channel-connections/:connectionId/commands/:command` | `reconnect`, `test`, `disconnect`, and `relink` with `{ config }` (ABI 2: same identity only, else `channel_identity_mismatch`, 409) |
| `POST /api/workspaces/:workspaceId/channel-connections/:connectionId/rebind` | `{ botId }`: the fence, then the new generation; answers the fence summary |
| `GET`, `POST /api/workspaces/:workspaceId/channel-connections/:connectionId/blocks` | List, add `{ senderId, note? }` |
| `DELETE /api/workspaces/:workspaceId/channel-connections/:connectionId/blocks/:senderId` | Remove |
| `GET`, `POST /api/channel-webhooks/:workspaceId/:pluginId/:connectionId` | Provider ingress for one connection; the plugin verifies it |

Audit actions: `channel.connect`, `channel.disconnect`, `channel.relink`, `channel.rebind`
(before and after Bot and generation, runs and outbound cancelled), `channel.sender_block`,
`channel.sender_unblock`. A stale host call is `channel_connection_stale` (409) and has no effect.

## Rebind, in order

1. `binding_generation` increments with the new Bot in one statement; the current host is
   revoked and its subscriptions end.
2. The plugin's `close(…, "rebind")`.
3. In the connection's older threads: pending approvals closed by `system:channel_binding` with
   reason `binding_changed`, live runs cancelled, every unsent outbound message recorded
   `cancelled`.
4. `open(…, "rebind")` with a new host. The next message of a conversation that had an older
   thread creates a new thread for the new Bot that opens with one `system` notice naming it.

## Verified and not

T1: `channels/connection-binding.test.ts`, `connection-host.test.ts`, `rebind.test.ts`,
`sender-blocklist.test.ts`, `inbound-images.test.ts`, `channel-migration.test.ts`,
`workspace-archive.test.ts` (archive, restore and purge after archive), with the fake ABI-2
provider from `@deskmates/testkit`, and `whatsapp-abi2.test.ts` (upgrade of ABI-1 rows, the
dropped allowlists, blocklist admission, the allowlist mode on a variant, link identity, stale
handle, single connection, archive across a restart) with a WhatsApp-shaped fake.
Provider plugins live in `packages/channels` with their own tests (see its README); nothing here
is verified against a live provider.
