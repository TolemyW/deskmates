# Discord channel plugin (ADR-0047)

`src/discord/` is a release-bundled ChannelPlugin ABI-2 plugin. One connection is one Discord
application's bot, bound to exactly one Bot; a workspace may hold several, each with its own
application. People talk to the bot in direct messages. The plugin needs no public URL: inbound
arrives over the Discord Gateway websocket, replies go out through the REST API. Read
[the ABI-2 guide](abi-2-provider-plugins.md) for the contract it implements.

## Connect

1. In the Discord developer portal create an application, open **Bot**, and copy the bot token.
   No privileged intent is needed: the plugin asks only for `DIRECT_MESSAGES`, and a DM's text
   reaches a bot without `MESSAGE_CONTENT`.
2. Make the bot reachable by DM: a person can DM a bot they share a server with, or one installed
   to their account. The plugin never starts a conversation.
3. In **Integrations → Channels → Discord**, paste the token and choose the Bot. The Gateway asks
   the plugin to verify it before anything is stored; the plugin calls `GET /users/@me` (it must
   be a bot user) and `GET /applications/@me`, and the identity is `discord:app:<application id>`,
   labelled with the bot's username. The same application cannot be connected twice anywhere in
   the installation (`channel_identity_in_use`).

The token is kept in the Gateway Secret Store; the plugin sends it only in the REST
`Authorization` header and in the websocket Identify and Resume payloads. It is not written to
the plugin state, a status, a host call or a log line, and a REST error message is scrubbed of it.

## Capability matrix

| Row | State | What happens |
|---|---|---|
| Direct messages | available | A DM channel is one conversation and one thread |
| Groups, channels, threads | unavailable | A message with a `guild_id` (server channel or thread) is ignored: no thread, no run |
| Inbound images | available | GIF, JPEG, PNG, WebP attachments up to 10 MiB, 4 per message, downloaded from Discord's CDN and posted like a Web upload |
| Other inbound media | disabled | Voice messages, video, files and stickers get a fixed notice; nothing is posted for them |
| Outbound reply | available | Every message not written by the person, `system` notices included, as text in 2000-character chunks |
| Proactive message | unavailable | Reply-only; there is no test message |
| Streaming | disabled | |
| Approvals | available | `approve <id>` / `deny <id> [reason]` (ADR-0017 decision 7), never posted as a message |

Messages from bots, webhooks, the bot itself and system message types are ignored. Admission is
the Gateway's: any sender is admitted unless on the connection's blocklist. Before sending a
notice (refused media, an approval refused) the plugin asks the host with an empty `receive`, so a
blocked sender gets nothing at all; for images it asks before downloading.

## Delivery and restart

- **Outbound.** Each relayed message passes the send gate (`beginSend`, then `recordSend` with
  Discord's message ids). A 429 waits for Discord's `retry_after`; 5xx and network failures are
  retried, then the thread is retried with a growing delay, sending only the chunks not yet
  delivered. A permanent refusal (for example 50007, the person does not accept DMs) is logged
  and a message with no delivered chunks is dropped. If earlier chunks already arrived, their
  ids and the unsent tail remain pending instead: connection status reports a partial reply,
  and **Reconnect** retries only the remaining chunks after the operator fixes the refusal.
  An automatic restore or a new message does not retry that permanently refused tail; later
  messages in that conversation wait for the explicit reconnect. Other conversations continue.
  A 401 marks the connection `revoked`. Delivery is at least once.
- **Gateway websocket.** Heartbeats at Discord's interval; a missing ACK is a zombie connection
  and is resumed on a new socket. A drop, opcode 7 or a resumable Invalid Session resumes, so
  Discord replays missed events; otherwise the plugin identifies again with exponential backoff
  and jitter. Close code 4004 (token refused) is `revoked`; 4010 to 4014 are `failed`. Neither
  reconnects.
- **State.** `discord-state.json` in the connection's 0700 state directory (file 0600) holds the
  session to resume, each thread's relay cursor and chunk progress, the bot user id, and the last
  handled message of each DM channel. A Gateway restart closes the socket resumably, and the next
  start resumes. When the session can no longer be resumed, the plugin reads each known DM
  channel's messages since the last handled one over REST; the host's deduplication keeps every
  message posted once. A relink drops the old credential's session and chunk progress.
- **Rebind.** The old host is stale; threads of the old generation answer `not_found` and are
  dropped from the state. The new Bot's first thread in a conversation opens with the Gateway's
  rebind notice, relayed like any `system` message.
- **Disconnect** closes the websocket with 1000, which ends the Discord session; the Gateway
  deletes the state directory and the token record.

Neither Node's `fetch` nor its `WebSocket` uses `HTTPS_PROXY`: a Gateway host that reaches the
internet only through a proxy cannot run this plugin in this version.

## Verified and not

T1 `src/discord/plugin.test.ts` runs the whole runtime against a scripted Discord Gateway and
REST API (`src/test-support/fake-discord.ts`) and an in-memory connection-scoped host
(`src/test-support/fake-connection-host.ts`): verify, invalid and non-bot tokens, DM text and
reply with receipts, guild, bot and system messages ignored, images and refused media, the
blocklist, approvals, chunking, 429 and chunk-level retry, heartbeat, drop and resume, opcode 7,
invalid session, zombie connections, restart with resume and with REST catch-up, revoked tokens,
a token of another application, disconnect, rebind, two bots kept apart, and no token in logs,
statuses, host input or state. T0 `src/discord/outbound.test.ts` covers chunking and rendering.

Not verified: anything against the live Discord service. Every provider cell above, the
payload shapes, close codes, rate-limit behaviour, CDN download, the REST catch-up and the
end-to-end journey (connect, inbound, reply, approval, restart, revoke, reconnect, disconnect)
are the live rows of ADR-0047's Verification table and are recorded as not run: no Discord
application, token or live configuration exists for this work.


Connection lifecycle operations are serialized per connection id, including stop behind a
pending open; different connections remain independent. Concurrent reconnect/stop may retire
a connection while its persisted state is still loading.
A retired connection must not create a Gateway session afterward. The deterministic T1
regression gates that state read and verifies that disconnect and stop leave no orphan socket.
