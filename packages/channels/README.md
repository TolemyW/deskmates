# @deskmates/channels

Official chat-channel plugins that turn external direct messages into Gateway threads and relay
replies back. The package imports only `@deskmates/contracts` from workspace packages. `npm run
build -w packages/channels` emits `dist/channel-plugins.json`, whose entry and every JavaScript
module are SHA-256 pinned. A release points the Gateway at that bundled manifest with
`CHANNEL_PLUGIN_MANIFEST`; the Gateway verifies it and dynamically loads the versioned
`ChannelPlugin` entry point in process. It never downloads channel code or accepts an arbitrary
third-party entry path (ADR-0017 amendment 1).

New providers are built on ChannelPlugin ABI 2 (ADR-0047): each connection is one verified
external identity bound to one Bot, a plugin may hold several connections in a workspace, and the
Gateway hands each connection a host scoped to it and checks every call. WhatsApp is on ABI 2 too
(ADR-0047 amendment 1), with one connection per workspace; it admits every sender unless the
connection's blocklist names them (ADR-0017 amendment 3), which the host enforces. Provider SDKs are declared and lazily loaded only through
`src/provider-dependencies.ts`.

## Docs

- [Discord channel plugin (ADR-0047)](docs/discord.md): one bot per connection, DMs over the Gateway websocket, capability matrix, restart and resume
- [Slack (ABI 2)](docs/slack.md): Socket Mode app setup, identity, what is handled, delivery, what is verified
- [Telegram (ADR-0047)](docs/telegram.md): one bot per connection, long polling, capability matrix, delivery, restart, revoke
- [WeChat (development, ADR-0047)](docs/wechat.md): native iLink QR binding, private text, recovery and live release gates
- [Writing an ABI-2 provider plugin (ADR-0047)](docs/abi-2-provider-plugins.md): the contract, the host, the send gate, dependencies, testing

## WhatsApp

The product's **Integrations → Channels** screen owns setup and lifecycle. One workspace has at
most one WhatsApp connection and one default Bot. Choose either **QR linked device** or
**Business Cloud API**; changing method requires Disconnect first. The screen shows status and a
current QR, sends a test message, reconnects, relinks QR sessions, disconnects and keeps the
connection's blocklist: anyone who messages the account reaches its Bot unless blocked (ADR-0017
amendment 3; an allowlist stored before that change was dropped and nobody was blocked). Only private
chats are handled; groups are ignored. Secret fields are encrypted by the Gateway's generic
Secrets Store. QR credentials and relay cursors live under `CHANNEL_STATE_DIR` in a 0700
connection directory with 0600 files, outside every workspace. A normal Gateway restart retains
them; Disconnect removes them.

The connection's identity is its number: a Cloud API number is checked against the Graph API when
it is connected (`whatsapp:cloud:<phone number id>`), a linked device's number is claimed after
the scan (`whatsapp:linked:<number>`). One number serves one Agent in the installation; a number
connected elsewhere, or a relink to a different number, is refused with a visible reason.
Connections made before the ABI-2 plugin (version 2.0.0) are moved in place by the Gateway's
migration and claim their number on restart; nothing is re-linked.

Build and enable the release plugin from the repository root:

```sh
npm run build -w packages/contracts
npm run build -w packages/channels
CHANNEL_PLUGIN_MANIFEST="$PWD/packages/channels/dist/channel-plugins.json" \
CHANNEL_STATE_DIR="$PWD/data/channels" npm run dev:gateway
```

`GATEWAY_SECRETS_KEY` must contain 32 bytes of base64 before Cloud API secrets can be saved. Do
not edit a built module without rebuilding the manifest: the loader will degrade that plugin and
keep the rest of the Gateway available.

## QR linked device (ADR-0019)

QR onboarding uses WhatsApp linked devices. No WABA, Meta app, access token, app secret,
business phone ID or public webhook is needed. Configure it in the product UI. The standalone
`deskmates-whatsapp-web` process described below remains a development/diagnostic entry point; it
is not the release product lifecycle.

Set these existing values in a private environment file:

```dotenv
GATEWAY_OPERATOR_TOKEN=<the test Gateway's operator token, at least 32 bytes>
WHATSAPP_GATEWAY_URL=http://127.0.0.1:8081
WHATSAPP_WORKSPACE_ID=<existing workspace ID>
WHATSAPP_BOT_IDS=<one to six existing bot IDs, comma separated>
WHATSAPP_ALLOWED_SENDERS=<allowed sender phone numbers, country code, no plus>
WHATSAPP_WEB_BIND=127.0.0.1
WHATSAPP_WEB_PORT=8091
WHATSAPP_WEB_DATA_DIR=/absolute/private/data/whatsapp-web
```

Build and start from the repository root:

```sh
npm run build -w packages/channels
node --env-file=/absolute/path/whatsapp.env packages/channels/dist/whatsapp-web-main.js
```

Open `http://127.0.0.1:8091`, enter the operator token and click **Connect WhatsApp**.
On the phone open **WhatsApp → Linked devices → Link a device** and scan the current
QR. The page shows the linked number and connection state. It replaces/clears an
expired QR, offers reconnection after failure, and **Log out** clears the local
session. The token and QR are never stored in browser storage. There is no dynamic
bot-routing editor in this first page; startup configuration chooses the bots.

For a remote service, use an SSH tunnel, for example `ssh -L 8091:127.0.0.1:8091
testbox`, or an operator HTTPS proxy. Do not publish this plaintext listener or
mount its session directory into a workspace. The default directory is ignored
`data/whatsapp-web`, permissions 0700 with session files 0600. Keep it across
normal restarts. Exactly one service may own a directory. An invalid or corrupt
session is never silently replaced; explicit logout/relink is required.

The WebSocket honors `https_proxy`/`HTTPS_PROXY` and `http_proxy`/`HTTP_PROXY`,
with `NO_PROXY`/`no_proxy` exclusions. `WHATSAPP_WEB_PROXY_URL` can select a
dedicated HTTP(S) proxy. Proxy credentials remain operator-side and are not logged.

Only newly notified direct text messages reach the configured bots. History sync,
groups, broadcasts, status updates, edits, reactions and outgoing echoes are
ignored. LID senders require a client-supplied phone mapping. The standalone
`deskmates-whatsapp-web` diagnostic keeps an explicit allowlist: self-chat works when your own
number is in it, and an empty list admits nobody.
Channel replies and approval commands reuse the existing Gateway semantics.
Bindings/cursors are separated by linked account, so the Cloud API history is not
replayed. Delivery is at least once: a lost send acknowledgment can cause a retry.
Incoming Gateway failures have five bounded retries and a visible failure counter;
the incoming queue is in memory and a service crash can lose unposted input. Do not
describe this first version as lossless messaging.

Baileys is pinned to `7.0.0-rc14` (an upstream release candidate). Deterministic
coverage exercises a fake socket and Gateway, private auth persistence and the
connection HTTP API. Real-phone QR/link/reply/approval/restart/unlink acceptance is
still required; fake QR and send IDs never establish a real WhatsApp connection.
See [ADR-0019](../../docs/adr/0019-whatsapp-linked-device-qr.md) and
[the runbook](../../docs/runbooks/whatsapp-qr-onboarding.md).

## Business Cloud API (ADR-0017)

The plugin speaks the WhatsApp Business Platform Cloud API: Meta webhooks enter through
`/api/channel-webhooks/:workspaceId/whatsapp`, and Graph API `messages` carry replies. Configure
the phone number id and secrets in Integrations. The standalone `deskmates-whatsapp`
binary and environment variables below remain available for development diagnostics. Read
[ADR-0017](../../docs/adr/0017-whatsapp-channel-through-cloud-api.md) before changing it; the
decisions below are its numbered items.

- **Binding (3).** One sender (`wa_id`) on one business number is one `chat` thread:
  `channel = whatsapp`, `externalKey = <phone_number_id>:<wa_id>`, created on the first accepted
  message in `WHATSAPP_WORKSPACE_ID` with `WHATSAPP_BOT_IDS` as members. Mentions are `@name` in the
  text, parsed by the Gateway as for any human message.
- **Admission (4; standalone binary only).** The release plugin admits by default with a
  blocklist since amendment 3. The standalone binary keeps decision 4's deny-by-default:
  `WHATSAPP_ALLOWED_SENDERS` lists who may drive the bots; a
  message from anyone else, or for another phone number id, is acknowledged and dropped. The human
  message carries `authorId = whatsapp:<wa_id>`; the profile name never leaves the adapter. The list
  works both ways: a number removed from it receives nothing further, its cursor still advances, and
  re-adding it does not replay what it missed.
- **Inbound (5).** `GET /whatsapp/webhook` answers Meta's handshake for `WHATSAPP_VERIFY_TOKEN`;
  `POST` needs a valid `X-Hub-Signature-256` under `WHATSAPP_APP_SECRET` (401 otherwise). Text
  messages are posted with `externalId = wamid`, so a retry returns the stored message and wakes
  nobody. Non-text messages get a fixed notice and are not posted. A Gateway outage answers 503 so
  Meta retries.
- **Outbound (6).** Every message in a bound thread not written by the sender (bot replies, system
  notices, a web operator's messages) is sent as text in chunks of at most 4096 characters. A
  transient failure (network, 429, 5xx) keeps the message: the cursor stays, delivered chunks are
  remembered, and the thread is retried with a growing delay and on every reconnect. A permanent
  refusal (other 4xx) is logged once and the message dropped. The per-thread cursor lives in
  `WHATSAPP_STATE_FILE`. Outside WhatsApp's 24-hour window the Cloud API refuses free-form text
  (code 131047); that is a permanent refusal, templates are out of scope.
- **Approvals (7).** An approval request is relayed with `Reply "approve <id>" or "deny <id>
  [reason]"`. A reply whose verb is `approve`, `allow`, `deny` or `reject` and whose id has the
  Gateway's shape (a UUID, or `approval_<hex>`) decides `allow_once` or `deny` as
  `whatsapp:<wa_id>` through `POST /api/approvals/:id/decide`, only when the approval belongs to
  the sender's own thread; it is never posted as a message. "yes please" and "no thanks" are chat.
  `allow_always` is not offered from WhatsApp.
- **Credentials (8).** Everything comes from the environment (see `.env.example`, the WhatsApp
  section) and stays in memory. The listener is plain HTTP on `127.0.0.1:8090` by default; put the
  operator's TLS reverse proxy in front of it. Deploy it next to the Gateway and the web UI, never on
  a workspace network.

Run it with `npm run build -w packages/channels && node packages/channels/dist/index.js` (or the
`deskmates-whatsapp` binary) with the variables set.

### What is verified and what is not

Deterministic tests cover the webhook signature, payload reduction, the approval grammar, chunking
and retry policy, configuration, the listener, and the adapter end to end against a fake Gateway on
a real port and a fake Graph API (`src/whatsapp/*.test.ts`). The Gateway side of the contract has its
own T1 test (`packages/gateway/src/api/thread-channel-routes.test.ts`) driving the same request
sequence against the real routes. A static test keeps this package's imports to `@deskmates/contracts`
and the Gateway's production code free of WhatsApp.

Not verified: anything that needs a real WhatsApp Business Account. The account prerequisites, the
Graph API version default (`v23.0`), the exact webhook shapes of a live number, template and
24-hour-window behaviour and the end-to-end journey are the live rows of ADR-0017's Verification
table and are recorded as not run until an account exists.

## Not in scope

For WhatsApp: groups, media, templates and several business numbers per adapter are out of scope.
Telegram, Discord and Slack are the first wave of ABI-2 plugins (ADR-0047, owner ruling
2026-10-17, which also withdrew C43's condition on Slack); personal WeChat now has a development-only
native plugin (owner authorization 2026-10-27), excluded from releases until its live gates pass.
Groups, channels, threads and topics are not implemented for any provider in this version.
