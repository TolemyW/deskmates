# Chat channels

What it is: a chat channel lets people talk to a workspace's bots from a chat app they already use:
Telegram, WhatsApp, Slack or Discord. Each connected account on a channel (one Telegram bot, one
WhatsApp number, one Slack app, one Discord bot) is answered by exactly one bot of the workspace.
The channels are built into the installed release; nothing extra has to be started.

Where you find it: **Connections** in the sidebar (Resources), tab **Chat channels**, the first
tab. Conversations that arrive through a channel also appear under **Chats**.

## What the tab shows

- **Connected**: every account connected in this workspace, with its channel and account name (for
  example "Telegram · @galaxy_ops_bot"), the bot that answers, when its state last changed, and its
  state: **Connected**, **Connecting**, **Waiting for scan**, **Needs re-link**,
  **Disconnected** or **Stopped (in Trash)**. A state that needs you says what to do in one line.
  Where the channel allows it, **Open in Telegram** (or Slack, WhatsApp, or **Add to a Discord
  server**) opens the account so you can message it. **Manage** opens its settings.
- **Add a chat channel**: one card per channel with what it supports (**What this channel
  supports**: direct messages, images, approvals in the chat, and so on), **Connect** and
  **Guide**, which opens that channel's section of this page.

Members see the same list and states; connecting and changing a channel is an Owner's or Admin's.
A workspace needs at least one bot before anything can be connected.

## Connect a channel

**Connect** opens a short guided setup:

1. **Who answers.** Pick the bot that answers this account. The workspace's default bot is
   preselected and marked. Everyone who messages the account talks to this bot; you can switch
   later. WhatsApp also asks how to connect (a linked phone or the Business Cloud API).
2. **Set up.** Numbered steps tell you what to do on the channel's side, with a link to the right
   page there and a **Copy** button for anything you have to paste there. Under each field a line
   says where to find the value. **Connect** checks the details with the channel: the account it
   names is the account that is stored, never what was typed. If the channel refuses, the dialog
   says why and keeps what you typed; nothing is saved.
3. **Try it.** The dialog shows the verified account ("Connected as @galaxy_ops_bot"), the bot that
   answers, and a link to open the account. For WhatsApp it shows the QR code to scan. **Go to
   Chats** opens the conversations.

Tokens and secrets you type are sent once, stored encrypted by the Gateway, and never shown again.
Closing the dialog before connecting discards them.

## Telegram

1. In Telegram, open @BotFather and send `/newbot`. Choose a display name and a username that ends
   in `bot`; BotFather answers with the bot's token.
2. Use a new Telegram bot for each Deskmates bot.
3. Paste the token and connect. Deskmates asks Telegram for new messages itself, so no public
   address is needed.
4. Open the bot in Telegram and press **Start**: Telegram lets a bot reply only to people who
   started it.

Direct messages only; text and images in, text replies out. Keep using the same conversation:
"Watch this project and tell me when something needs my decision" or "Here is an update to the
plan". Reconnects and restarts preserve its history. Replies and result links, approval cards,
and important blockers arrive here; routine running transitions do not produce a notification.
Other people's conversations and workspace-wide activity are not copied into your chat.

| Input | What happens |
|---|---|
| `/start`, `/help` | Introduction and help, without resetting work. |
| `/status` | Current work and synchronization state, without starting a model run. |
| `/settings` | The configured HTTPS Web settings link, or instructions to open Deskmates. Sign-in and workspace roles still apply. |
| `approve <id>` / `deny <id> [reason]` | Decide a request belonging to this conversation. |
| Ordinary text and supported images | Continue talking with the Agent. |
| `/new`, `/reset`, `/stop`, unknown commands | Unsupported-command guidance; no task/session control is performed. |

An Owner/Admin may configure **Web settings URL** while connecting the bot. A Telegram sender
is not thereby a workspace member or administrator and cannot change global model or approval
rules. The Web channel mirror stays read-only.

**Reusing a bot.** Stop the previous program's poller and remove its webhook before connecting.
An old command menu alone does not mean the previous program is still reading messages. In the
connection's management card, expand **Command menu**, review the exact proposed commands and
choose **Inspect current menu** or **Synchronize this target**. Select default, all private
chats, or a specific private chat, and an optional two-letter language code. Only that combination
is changed. More-specific chat/language overrides may still show old entries; repeat with their
known IDs/languages because Telegram cannot enumerate every combination. The custom menu button
stays intact unless you explicitly select replacement. For default/all-private scope, replacement
changes the default button. Name, description and avatar are never changed. Connect, reconnect,
upgrade and rebind do not automatically rewrite menus; synchronization failures appear in the
card while ordinary messaging continues.

As a temporary manual route, use BotFather: `/mybots` → choose the bot → Edit Bot → Edit Commands,
or `/setcommands`, and follow its prompts to clear old entries. Labels do not create handlers.
Use the command list shown by Deskmates; do not advertise short-task controls.

**Delivery and recovery.** Messages are processed in order and offline messages are caught up on
reconnection. Confirmed chunks are remembered and not normally resent. If Telegram accepted a
send but its response was lost, a retry can duplicate it; `/status` reports the last uncertain
send. Permanent refusals are recorded separately and are not shown as sent. Gateway inbound
failures keep retrying without confirming the update. Provider retention limits still apply.
Review a failed message in the Web mirror. Help/status responses are best-effort notices.

[Adapter details and verification limits](../../packages/channels/docs/telegram.md).
[Telegram command scopes](https://core.telegram.org/bots/api#setmycommands).

## WhatsApp

One WhatsApp account per workspace, in one of two ways.

**Linked device** (the usual way, no Meta business account needed):

1. Pick the WhatsApp account that should answer. Messages to its number reach the chosen bot, so
   use a number meant for this rather than a personal one.
2. On that phone, open WhatsApp, then **Linked devices** (in Settings on iPhone, in the ⋮ menu on
   Android), and choose **Link a device**.
3. Press **Connect** and scan the QR code. The phone stays the account's main device and needs its
   internet connection. If the phone unlinks the device later, the state becomes **Needs
   re-link**: **Manage → Link again** shows a new code.

**Business Cloud API** (a Meta business number): create a Business app in Meta for Developers
with the WhatsApp product, copy the phone number ID, a system user's permanent access token and the
app secret, make up a verify token, and in Meta's webhook settings set the callback URL to this
Deskmates server's public address followed by the webhook path the setup shows (with **Copy**),
then subscribe to the `messages` field. The Cloud API cannot send free-form text outside
WhatsApp's 24-hour window, and templates are not supported.

Text messages only: images and other media get a fixed notice. **Manage** offers **Send test**.

## Slack

1. Create a Slack app **From a manifest** in the Slack workspace people will use, and paste the app
   manifest the setup shows (**Copy**). It turns on Socket Mode and the Messages tab, subscribes to
   direct messages and asks for exactly the scopes Deskmates needs.
2. **Install App** in the workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under **Basic Information → App-Level Tokens**, generate a token with `connections:write` and
   copy it (`xapp-…`).
4. Paste both tokens and connect. No public address is needed.
5. In Slack, open the app under **Apps** and write to it on its **Messages** tab.

Direct messages only; text and images in.

## Discord

1. In the Discord developer portal, choose **New Application**.
2. Under **Bot**, press **Reset Token** and copy the token. No privileged intent is needed.
3. Paste the token and connect. No public address is needed.
4. Discord lets people message a bot only when they share a server with it: after connecting, use
   **Add to a Discord server** and add the bot to a server they are in.

Direct messages only; server channels and threads are ignored.

## Manage a connection

**Manage** on a connected account offers, for Owners and Admins:

- **Reconnect** or **Retry**, and **Disconnect**.
- **Answer with another Bot** (Telegram, Slack, Discord): new messages go to the bot you choose;
  conversations so far stay with the previous bot as read-only history, and each person is told
  once that a different assistant now answers.
- **Replace credentials** for the same account, for example after rotating a token. A different
  account is a new connection.
- **Blocked people**: anyone can message a connected account; messages from people on this list
  are ignored and nothing more is sent to them.

## Conversations and approvals

Each person who writes to a connected account gets their own conversation, answered by the bound
bot like a private chat. It also appears under **Chats** as a read-only copy: reply from the chat
app, not from the web UI. When the bot needs approval, the request is sent to that chat with its
id; reply `approve <id>` or `deny <id> [reason]`, or answer it in **Approvals**. Only requests of
your own conversation can be decided from the chat app, and **Always** is not offered there.

## What this cannot do

- One account is answered by exactly one bot. Several bots never share one Telegram bot, number,
  Slack app or Discord bot; connect one account per bot instead.
- Direct messages only. No groups, channels or threads; no messages the bot starts on its own;
  only the media each card lists.
- Delivery is at least once: a lost acknowledgment can repeat a reply.
- The answering bot works on the workspace's shared computer like any other run. A channel is not
  a boundary between bots.
- Personal WeChat is planned for a later phase.
- Telegram, Slack, Discord and WhatsApp are tested offline; real accounts on a stable release have
  not been accepted yet (see the [M4 status ledger](../design/m4-status-2026-10-04.md),
  [ADR-0047](../adr/0047-per-connection-channel-identity-and-first-wave-providers.md) and
  [ADR-0017](../adr/0017-whatsapp-channel-through-cloud-api.md)). The operator runbook for a linked
  phone is [WhatsApp QR onboarding](../runbooks/whatsapp-qr-onboarding.md).
