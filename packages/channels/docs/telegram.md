# Telegram (ADR-0047)

The Telegram channel plugin, on ChannelPlugin ABI 2. One connection is one Telegram bot bound to
one Agent; a workspace may hold several connections, each its own bot and Agent. Code in
[`src/telegram/`](../src/telegram/); the contract every provider follows is
[the ABI-2 guide](abi-2-provider-plugins.md).

## Setup

1. In Telegram, ask @BotFather for a new bot (`/newbot`) and copy its token. A second Agent
   needs a second bot: one bot never serves two Agents (ADR-0047 decisions 3 and 4).
2. In **Integrations → Channels → Telegram**, pick the Agent and paste the token. The Gateway
   asks the plugin to verify it before storing anything: the plugin calls `getMe` and the
   connection's identity is `telegram:bot:<bot user id>` from that answer, never from the pasted
   text. The same bot connected anywhere else in the installation is refused with
   `channel_identity_in_use`.
3. A person opens the bot in Telegram and presses **Start**. Telegram lets a bot write only to
   people who started it, so the bot only ever replies.

No public URL, webhook or port is needed: the plugin long-polls `getUpdates` over HTTPS from the
Gateway process. The bot must have no webhook set; Telegram refuses `getUpdates` while one is
(the connection shows `conflict` until it is removed with `deleteWebhook`). Only one program may
read a bot's updates at a time.

## What it does

| Capability (ADR-0047 decision 12) | State | Behaviour |
|---|---|---|
| Direct messages | `available` | A private chat is one conversation: its own one-member thread for the bound Agent, external key `<connection>:<generation>:<chat id>`, author `telegram:<user id>`. |
| Groups, channels, threads, topics | `unavailable` | Group, supergroup and channel messages and topic messages are ignored: no thread, no wake, no reply. |
| Inbound images | `available` | The largest size of a photo, and a document whose type is JPEG, PNG, GIF or WebP, enter the workspace like a Web upload. The bytes are sniffed; a file over 10 MiB or not really an image is refused with a notice. The run's vision policy decides whether the model sees it. |
| Other inbound media | `disabled` | Voice, audio, video, video notes, animations, stickers, other files, locations, contacts and polls get a notice and are not posted; a caption still is. |
| Outbound reply | `available` | Every message in the thread not written by the person is sent as plain text (no `parse_mode`, so nothing is read as Markdown), split at 4096 characters, through the send gate. |
| Proactive messages | `unavailable` | Reply-only. |
| Streaming | `disabled` | Replies are sent whole. |
| Approvals | `available` | An approval request is relayed with `Reply "approve <id>" or "deny <id> [reason]"`; that reply decides `allow_once` or `deny` and is never posted (ADR-0017 decision 7). |
| Test message | `unavailable` | It would be a proactive send. |

Admission is allow-by-default (ADR-0047 decision 13): every person who writes is admitted unless
an Owner or Admin put their Telegram user id on the connection's blocklist. A blocked person's
messages are acknowledged and dropped, and nothing is sent to them, not even a refusal notice: the
plugin asks the host with an empty `receive` (which posts nothing) before any notice or approval
decision that is not a posted message, and the host answers `blocked`.

An album arrives from Telegram as one message per photo, so it becomes several messages in the
thread.

## Delivery, restart and lifecycle

- **Inbound.** The update offset is confirmed only after an update was handed to the Gateway, so
  a crash or Gateway refusal redelivers it; the Gateway deduplicates by `<chat id>:<message id>`
  (not `update_id`, which Telegram may restart at a random value after a week without updates).
  Gateway failures keep the offset unchanged and retry with bounded backoff; after five attempts
  a warning is recorded, but the update is not discarded. Telegram retention still bounds recovery.
- **Outbound.** At least once: a chunk Telegram accepted is remembered with its message id, so a
  retry after a 429 (its `retry_after` honoured), a 5xx or a network failure resumes at the next
  chunk. A permanent refusal (another 4xx, for example a person who blocked the bot) drops the
  message with a warn log. A send Telegram accepted but the Gateway never recorded can repeat
  after a crash; that duplicate is the documented failure.
- **Private state.** `telegram-state.json` in the connection's 0700 state directory, mode 0600:
  the update offset, per-thread relay cursors and half-sent chunk ids. No credential. The offset
  is identity-scoped and survives restart, reconnect, relink and rebind; cursors are dropped on a
  rebind (the old threads are fenced); half-sent chunks are dropped on a relink.
- **Token.** A secret field: the Gateway keeps it encrypted in its Secret Store and passes it only
  to `verify` and `open`. It is part of every Bot API request path by Telegram's design and
  appears nowhere else: errors and descriptions from Telegram are scrubbed of it, and the plugin's
  log lines carry only status codes and counts.
- **Revoked token.** `getMe` at open or `getUpdates`/`sendMessage` answering 401 shows `revoked`
  and stops polling; unsent replies are kept. **Relink** with the bot's new token (the same bot,
  else `channel_identity_mismatch`) resumes them; **Disconnect** stops polling and the Gateway
  deletes the token and the state directory. Telegram's `logOut` is not called: it would move the
  bot off the cloud Bot API.

Status phases: `connecting`, `connected`, `reconnecting`, `conflict`, `revoked`,
`identity_mismatch` (the stored token names another bot), `stopped`.

## Verified and not

T0/T1 (`src/telegram/*.test.ts`) run the plugin against a scripted Bot API (`FakeTelegram`) and an
in-memory connection host (`FakeConnectionGateway`): verify from `getMe`, inbound text and images,
ignored groups and topics, the blocklist in both directions, chunked replies with a 429 in the
middle, approvals, offset and cursor persistence across a restart, a redelivered update, a revoked
token and its relink, two bots kept apart, rebind cursor reset, and no token in logs, statuses,
host calls or the state file. The Gateway's side of the contract is covered by its own T1 tests
with the testkit fake provider.

Not verified: anything against the live Bot API. Telegram's real update shapes for private-chat
topics, album and media variants, rate-limit behaviour and the connect, inbound, reply, approval,
restart, revoke, relink and disconnect journey on a real bot are ADR-0047's live rows, **not run**:
no bot, token or live configuration exists for this change.


## Continuing communication and menus

The [user guide](../../../docs/guide/channels.md#telegram) describes `/start`, `/help`, `/status`
and `/settings`, approvals, reconnect recovery and migration from an existing bot. No task reset,
new-session or stop handler is offered. Command entities and addressed commands are recognized;
commands addressed to another username are ignored. Unsupported controls never reach the model.

The scoped host discovers current-binding threads on reconnect. Relay passes coalesce events,
read through all available pages, and honor retry delays. Every chunk checks the send gate.
`syncActivity` records a deduplicated system notice for meaningful waits, failure and recovery of
the latest non-model-job run, without waking it. It reads only that conversation. Ordinary replies,
including evidence links, keep their original transcript order. An offline snapshot reports
current activity rather than flooding the person with obsolete transitions.

Private cursor state also keeps the last permanent refusal and ambiguous send sequence. These
are diagnostics, not delivery receipts; an ambiguous send may still be duplicated on retry.
Help/status/settings notices remain best effort and are not claimed to have durable delivery.

`commandMenu` is an optional ABI-2 operator operation advertised in the manifest. Its endpoint
requires Owner/Admin in the connection's workspace. The plugin uses `getMyCommands`,
`setMyCommands`, `getChatMenuButton`, and (only on explicit replacement) `setChatMenuButton`.
Only a selected scope/language is managed. It does not enumerate unknown overrides or alter
profile metadata. Failure does not close the connection; lifecycle operations never sync menus.
Scripted tests cover these methods; a real phone-visible menu journey remains pending.
