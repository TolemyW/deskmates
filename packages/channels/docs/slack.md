# Slack (ChannelPlugin ABI 2)

The Slack plugin connects one Slack app, installed in one Slack workspace, to one Bot
([ADR-0047](../../../docs/adr/0047-per-connection-channel-identity-and-first-wave-providers.md);
issue deskmates-private#4, owner rulings of 2026-10-17, which put Slack in the first wave and
withdrew C43's condition). A Deskmates workspace may hold several Slack connections, each its own
app and Bot. People reach the Bot in the app's direct messages; nothing else is handled. Code:
[`src/slack/`](../src/slack/), entry `slack/plugin.js` in the release manifest.

## Transport

- **Events: Socket Mode.** The app-level token (`xapp-…`, scope `connections:write`) opens
  `apps.connections.open`; the plugin connects to the one-time WebSocket URL, checks that the
  `hello` names the connection's app, and acknowledges every envelope by `envelope_id`. A
  `disconnect` frame (`refresh_requested`, `warning`) reconnects at once; a dropped socket
  reconnects with backoff (1 s doubling to 60 s); `link_disabled` stops with an error. No public
  ingress is needed, so the Gateway's webhook route answers 404 for Slack connections.
- **Sends: Web API** with the bot token (`xoxb-…`): `chat.postMessage` for replies and notices,
  `auth.test` and `bots.info` for identity, file downloads for images. 429 is retried after
  `Retry-After` (at most 60 s, three retries); 5xx and network failures likewise.
- Plain `fetch` and Node's global `WebSocket`; no `@slack/*` or other third-party package, so
  nothing is declared in `provider-dependencies.ts`. All I/O is behind `SlackTransport`
  (`src/slack/transport.ts`) so tests run against a scripted Slack. The Gateway process reaches
  `slack.com` directly; an operator proxy is not configured by this plugin.

## Slack app setup

Create the app in Slack's app settings, then:

1. Turn on **Socket Mode** and create an app-level token with `connections:write`.
2. Under **App Home**, turn on the **Messages tab** and allow people to send messages to the app.
3. Under **Event Subscriptions**, subscribe to the bot event `message.im`.
4. Give the bot the scopes `chat:write`, `im:history`, `files:read` and `users:read`
   (`users:read` is what `bots.info` needs to name the app).
5. Install the app in the Slack workspace and paste the bot token and the app-level token into
   **Integrations → Channels → Slack**. Both are secret fields: the Gateway keeps them in its
   Secret Store and passes them to the plugin only in `verify` and `open`.

## Identity

`verify` calls `auth.test` and `bots.info` with the bot token and `apps.connections.open` with
the app-level token (the URL is discarded unused). The identity key is
`slack:<team id>:<app id>`, or `slack:<enterprise id>:<app id>` for an org-wide install; the label
is `<bot name> in <team name>`. The same app installed in another Slack workspace is therefore a
different identity, and a second connection of the same installation (another token of it, or
the same tokens in another Deskmates workspace) has the same key and is refused by the Gateway
with `channel_identity_in_use`. On `open` the bot token is checked again: a token that now
belongs to another app or Slack workspace, or an app-level token whose socket names another app,
stops the connection with an error instead of serving the wrong identity. Events whose
`api_app_id` or team (enterprise) is not the connection's are acknowledged and dropped.

## What is handled

| ADR-0047 row | Slack plugin, this version |
|---|---|
| Direct messages | `available`: `message` events with `channel_type: im` from a person |
| Groups, channels, threads, topics | `unavailable`: channel, private-channel and multi-person DM events are acknowledged and ignored (no thread, no wake). A reply inside a thread of the DM gets "Replies in threads are not supported here…" and is not posted |
| Inbound images | `available`: GIF, JPEG, PNG, WebP files up to 10 MiB, at most four per message, downloaded from `files.slack.com` only, with the bot token, then passed to `host.receive` like a Web upload |
| Other inbound media | `disabled`: any other file is refused with "Only text and images reach the assistant here…"; text sent with it is still posted |
| Outbound reply | `available`: every message of the thread not written by the person (Bot replies, `system` notices, approval requests, the rebind notice) through the send gate, `&`, `<`, `>` escaped so a reply cannot mention, link or broadcast, chunked at 4,000 characters without splitting an entity, link unfurling off |
| Proactive messages | `unavailable`: the plugin only answers conversations a person started |
| Streaming | `disabled`: Slack has a streaming method; not used |
| Approvals | `available`: ADR-0017 decision 7's grammar (`approve <id>`, `deny <id> [reason]`), decided only for the conversation's own thread and never posted |
| Test message | `unavailable`: it would be a proactive send |

Edits, deletions and other message subtypes, bot messages (the plugin's own echoes included) and
every non-message event are ignored. `app_uninstalled` and a `tokens_revoked` naming the bot stop
the connection as `revoked`, as does a Web API answer `invalid_auth`, `token_revoked`,
`account_inactive`, `not_authed` or `token_expired`.

Admission is the host's: allow by default with the connection's blocklist. Before any notice or
approval decision the plugin asks the host with an empty `receive` (answered `empty` for an
admitted sender, `blocked` for a blocked one, and posting nothing), so a blocked person never
hears from the connection.

## Delivery

At least once, as ADR-0047 decision 11 describes. An envelope is acknowledged after its message
is posted, or at 2.5 s when posting takes longer (Slack wants an answer within 3 s). A Gateway
failure before that leaves it unacknowledged, so Slack redelivers it; the event id, remembered in
the state file (last 1,000) and deduplicated again by the host, keeps a redelivery from posting
twice. A crash between the deadline acknowledgement and the post loses that message. Outbound,
the per-thread cursor and the ids of chunks already sent survive a restart; a transient failure
keeps the message and retries the thread with backoff; a permanent refusal (for example
`channel_not_found`) is logged and the message dropped. A send Slack accepted but whose receipt
was not yet recorded may be repeated after a crash.

## Private state

`slack-state.json` in the connection's state directory (0700, file 0600): relay cursors for the
current binding and credential generation, and recent event ids. No token, no socket URL. A
rebind or relink discards the cursors. Disconnect removes the file (the Gateway removes the
directory and the secret records); Slack itself has no session to log out of, so revoking the
tokens is done by uninstalling the app or rotating them in Slack.

## Verified and not

T0/T1 (`src/slack/*.test.ts`) against the scripted Slack and a fake connection host: verify and
identity keys (same app in two Slack workspaces, same installation twice, org-wide install),
invalid tokens, DM text, image files, refused files, channel/MPIM/thread events ignored,
blocklisted sender, duplicate envelope, unacknowledged redelivery, approvals, chunking and
rate-limit resume, catch-up after restart, reconnect on `disconnect` and on a dropped socket,
revocation, app and identity mismatch, stale host, disconnect, two connections kept apart, and no
token in logs, statuses, errors or the state file.

**Not verified:** anything against a live Slack workspace. No Slack app, token or workspace was
created or used. The event and method shapes are taken from Slack's public documentation; the
Socket Mode `hello` app id, `bots.info` scope, file download behaviour, retry timing and rate
limits of a live workspace, and ADR-0047's live journey (connect, inbound, reply, approval,
restart, revoke or relink, reconnect, disconnect) are **not run**.
