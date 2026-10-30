# Writing an ABI-2 provider plugin (ADR-0047)

ChannelPlugin ABI 2 is the contract every new chat provider (Telegram, Discord, Slack) is built
on. One **connection** is one verified external identity (a bot, an app installation, an
account) bound to exactly one Bot. A plugin may hold several connections in one workspace, each
its own identity and Bot. The Gateway owns the lifecycle and checks every call; the plugin talks
to the provider and nothing else. The types are in
[`packages/contracts/src/channel-connection.ts`](../../contracts/src/channel-connection.ts), whose
header comment is the short form of this page. WhatsApp runs on ABI 2 since ADR-0047 amendment
1; ABI 1 (`channel.ts`) is still accepted by the loader but no release plugin uses it.

Read [ADR-0047](../../../docs/adr/0047-per-connection-channel-identity-and-first-wave-providers.md)
first. The owner's rulings of 2026-10-17 fix the scope of the first version: 1:1 conversations
only (no groups, channels, threads or topics), inbound images received, other media refused with
a notice, replies only where proactive sends are unverified, allow-by-default admission with a
per-connection blocklist the Gateway keeps.

## Shape

```ts
export const channelPlugin: ChannelPluginV2 = {
  manifest: {
    apiVersion: 2,
    id: "telegram", // also the thread channel name and the identity key's first segment
    version: "1.0.0",
    displayName: "Telegram",
    description: "One Telegram bot per connection.",
    multipleConnections: true,
    capabilities: { /* every row of ChannelCapabilityMatrix; groups: "unavailable" */ },
    methods: [{ id: "token", label: "Bot token", description: "…", fields: [/* … */] }],
    statusVocabulary: ["connected", "reconnecting", "revoked"],
  },
  create: async (context) => runtime, // called only when a connection of the plugin is used
};
```

The release manifest (`scripts/write-channel-plugin-manifest.mjs`) gets one line per shipped
plugin, with `apiVersion: 2`. The loader refuses an ABI-2 manifest that omits a capability row,
uses an unknown state, or declares `groups` as anything but `unavailable`
(`channelManifestV2Problems`).

Two optional manifest declarations (ADR-0047 amendment 1):

- **`identity: "link"` on a method** whose account is known only after the person links it (a QR
  scan). The Gateway skips `verify`, stores the connection under a pending key and opens it; call
  `host.claimIdentity({ identityKey, label })` when the provider names the account. A number
  another connection holds is refused (`channel_identity_in_use`), and so is a different number
  than the one already claimed (`channel_identity_mismatch`); stop serving that account and show
  the reason. A relink of such a method skips `verify` too.
- **`senderAdmission`**: absent or `{ mode: "blocklist" }` is decision 13's allow-by-default with
  the Gateway's blocklist. `{ mode: "allowlist", field }` is deny-by-default: the host admits only
  the sender ids listed (comma-separated) in that plain config field of every method, and refuses
  the rest in both directions. No release plugin uses it since WhatsApp moved to the blocklist
  (ADR-0017 amendment 3).

## Lifecycle: the Gateway calls, the plugin answers

| Gateway step | Runtime call | What the plugin does |
|---|---|---|
| An Admin submits the connect form | `verify({ workspaceId, method, config, secrets })` | Call the provider's own identity endpoint with the credential (Telegram `getMe`, Discord current application, Slack `auth.test`) and return `{ identityKey, label }`. Throw if the provider refuses. Never derive the key from what the operator typed. |
| Identity is free in the installation | (Gateway stores the connection) | Nothing. A taken identity is refused with `channel_identity_in_use` before any secret or row exists. |
| Connect, restore at startup, reconnect, rebind, relink | `open(request, host)` | Start polling or the websocket for `request.connectionId`. Use only `host` for Gateway work. `request.reason` says why; `bindingGeneration` and `credentialGeneration` say which binding and credential this is. |
| Before every reopen and on disconnect | `close(connectionId, reason)` | Stop the transport. `disconnect` is final (log out where the provider has a session). Never touch the old host again. |
| Integrations page shows status | `status(connectionId)` | Return a phase from `statusVocabulary`. |
| Test message (only if `testMessage: "available"`) | `test(connectionId, input)` | Send the test, or throw. |
| Signed webhook (optional transports) | `webhook(request)` | Verify the signature on the untouched envelope before any host call. The URL is `/api/channel-webhooks/<workspace>/<plugin>/<connection>`. |
| Gateway shutdown | `stop()` | Stop every connection, keep private state. |

A **relink** is a credential change for the same identity (token rotation): the Gateway verifies
the new credential first and refuses another identity with `channel_identity_mismatch`. The
binding generation stays; `credentialGeneration` increments, and the plugin discards reply
contexts and send state of the older credential generation. A provider cursor (for example
Telegram's update offset) may survive a relink only when it is identity-scoped.

A **rebind** gives the connection another Bot. The Gateway fences first (the generation
increments, the old host is stale), cancels the old Bot's runs in the connection's threads,
closes their approvals `binding_changed`, records every unsent outbound message `cancelled`, and
then calls `open(…, reason "rebind")` with a new host. Old threads stay as read-only mirrors; no
history moves. The plugin does nothing special: after `open` it simply serves the new host.

## The host

Every method checks that the connection exists, its binding generation is the host's, and this
host is the connection's latest. Otherwise it throws `DeskmatesError("channel_connection_stale")`
and has no effect. Another connection's thread or approval is `not_found`.

- **Inbound: `receive({ conversationKey, senderId, externalId, body, title?, images? })`.** One
  call per provider message. `conversationKey` is the provider's 1:1 conversation id (a private
  chat id, a DM channel id), `senderId` the person's provider id, `externalId` the provider's
  message or event id. The host applies the blocklist, deduplicates `externalId` across every
  generation of the connection, creates or resolves the one-member thread for the bound Bot
  (external key `<connection>:<generation>:<conversationKey>`), stores images and posts the
  message. An `@name` in the text never adds a member. Results:
  - `posted`: thread, message, runs, and `imagesRefused` (tell the person that many images were
    not received).
  - `duplicate`: already posted; acknowledge the provider and do nothing.
  - `blocked`: the sender is on the blocklist; acknowledge and drop, send nothing.
  - `empty`: no text and no storable image; nothing was posted; tell the person.
- **Images.** Pass the bytes of image files the person sent as `images` (`image/gif`,
  `image/jpeg`, `image/png`, `image/webp`, at most 4 per message and 10 MiB each). The host writes
  each into `/work/uploads/<date>/` exactly like a Web upload, attributed to the channel author,
  and attaches it to the message; the run's vision policy decides whether the model sees it.
  Download from the provider only what you pass; refuse every other medium (voice, video,
  documents, stickers, locations) yourself with a short notice and do not call `receive` for it
  unless it has text.
- **Outbound.** `subscribe` delivers `thread_message` frames of this connection's current threads
  only. On a frame, `listMessages(threadId, cursor)`, and for each message call
  `beginSend({ threadId, seq })`. Send only on `{ send: true }`, then
  `recordSend({ threadId, seq, providerMessageIds })` with the provider's ids, one per chunk.
  `{ send: false }` means advance the cursor past that message for good: `sender_message` (the
  person's own), `already_sent`, `cancelled` (fenced by a rebind or disconnect) or `blocked`.
  Relay every message not written by the person, `system` messages included: approval requests,
  cap notices and the rebind notice (`This conversation is now handled by <Bot>. …`), which the
  host puts first in a rebound conversation's new thread so it reaches the person before the
  reply. `conversationKeyOf(threadId)` maps a thread back to the provider conversation.
- **Admission before a notice.** `admits(senderId)` answers whether the connection admits that
  person now. Ask it before sending anything `receive` did not see, such as a media refusal or an
  approval refusal, so a blocked or unlisted person gets nothing.
- **Approvals.** Parse ADR-0017 decision 7's grammar (`approve <id>`, `deny <id> [reason]`) and
  call `decideApproval({ id, decision, senderId, reason })`. The host decides only approvals of
  this connection's current threads, only `allow_once` or `deny`, and only for a person who wrote
  in that thread and is not blocked. Do not post a matching text as a message.
- **Delivery semantics.** At least once. A send acknowledged by the provider but not yet recorded
  may be repeated after a crash; that duplicate is the documented failure. An admitted inbound
  message never starts a second run.

## Dependencies

A provider may use a third-party SDK only through
[`src/provider-dependencies.ts`](../src/provider-dependencies.ts): pin the package exactly in
`package.json` `dependencies`, add one sorted registry entry naming the provider, and load it
with `await loadProviderDependency<typeof import("pkg")>("<provider>", "pkg")` inside the runtime.
Never import it statically (`import type` is fine). `provider-dependencies.test.ts` enforces this,
and the WhatsApp package-boundary test pins the full dependency list, so a new dependency updates
both. The Gateway creates a plugin's runtime only when a connection of it is first verified,
opened or restored, so an installation that never connects a provider never loads its
dependencies.

## Testing

`FakeChannelProvider` in `@deskmates/testkit` is a reference ABI-2 plugin: `verify` from its own
account table, inbound through `receive`, every relay through the send gate. The Gateway's T1
tests in `packages/gateway/src/channels/*.test.ts` drive it; a provider plugin's own tests run
its runtime against a scripted provider server and a fake `ChannelConnectionHost`. Live provider
behaviour is never established by these tests; record live journeys in `docs/design/` as ADR-0047's
Verification table asks.
