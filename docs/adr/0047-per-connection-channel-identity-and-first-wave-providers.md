# ADR-0047: Each channel connection is one verified external identity bound to one Agent; first-wave Telegram, Discord and Slack, personal WeChat later

Date: 2026-10-17
Status: Accepted (owner rulings, and owner delegation for the engineering detail, 2026-10-17; amendment 2 accepted by the owner, 2026-10-22). The owner ruled decisions 1 to 5 on 2026-10-13 and 7, 8 with its notice, 9, 12, 13, 15 and 16 on 2026-10-17 (issue deskmates-private#4). On 2026-10-17 the owner delegated sign-off of the remaining engineering detail to the implementing sessions ("你来处理"): decisions 6, 10, 11 and 14 and amendment 1 are **accepted under owner delegation, 2026-10-17**, after a review against the code as built; what that review changed, and why, is in "Review under owner delegation" at the end. The owner answered amendment 1's open question A3 the same day ("发件人默认放行"): WhatsApp admits every sender unless blocked, like the other ABI-2 providers (ADR-0017 amendment 3). The Gateway foundation (ABI 2 host, identity uniqueness, binding generation, blocklist, inbound images, rebind notice, dependency registry), WhatsApp's ABI-2 port and the Telegram, Discord and Slack plugins (`packages/channels/src/{telegram,discord,slack}/`) are implemented and covered by T0/T1 tests against scripted providers. Nothing is verified against a live provider.
Builds on: ADR-0002 (approvals are thread messages), ADR-0005 (threads have members; the transcript belongs to the Gateway), ADR-0013 (SaaS integrations run in the integration runtime), ADR-0017 with amendments 1 and 2 (the `ChannelPlugin` contract, release-bundled in-process loading, read-only Web mirror), ADR-0019 (QR-linked WhatsApp), ADR-0022 amendment 6 (roles per workspace), ADR-0045 (encrypted secret records)

## Context

Current WeChat implementation scope (owner, 2026-10-27): native iLink QR binding and direct
messaging are authorized. The first increment is text-only, including an explicit refusal for
images and other media; this narrows decision 12's image expectation for WeChat only. Decision
16's release gates remain in force. See [native readiness](../design/wechat-native-readiness-2026-10-27.md)
for the per-gate results and `packages/channels/docs/wechat.md` for the development entry point.
The QR identity extension anticipated by decision 16 already exists in amendment 1 A1.

Issue deskmates-private#4 began as research into an Agent-level messenger surface modelled on a reference product: one Agent reachable through several messengers and a dedicated e-mail address, with a many-to-many binding between Agents and connections, a shared product bot and routing by deep link or Agent selector. The owner's comment of 2026-10-13 replaced that proposal. This ADR records the replacement and the engineering contract it needs.

What exists today, read from main at the base of this ADR:

- `ChannelPlugin` ABI version 1 (`packages/contracts/src/channel.ts`): a manifest with `capabilities { directMessages, groups, testMessage }`, connection methods and a status vocabulary; a runtime with `connect`, `restore`, `status`, `command`, `webhook` and `stop`; and one `ChannelPluginHost` per plugin, created by `ChannelManager.host()`. Only WhatsApp ships (Cloud API and QR-linked methods of one plugin).
- `channel_connections` holds one row per connection with a single `bot_id`, a `secret_id`, a free-text `account`, and `UNIQUE (workspace_id, plugin_id)`. ADR-0017 amendment 1 P4 is the product rule behind that constraint: one WhatsApp connection per workspace, one default Bot.
- Threads are bound to an external conversation by `(workspace_id, channel, external_key)`; messages are idempotent by `(thread, external_id)`. A thread whose channel is not `web` is a read-only Web mirror, and the Gateway already refuses a signed-in person's post to it with 403 `channel_thread_read_only` (ADR-0017 amendment 2 M3).
- The host is plugin-wide, not connection-scoped. `findThread`, `getThread`, `listMessages`, `postHumanMessage`, `getApproval` and `decideApproval` accept any workspace, thread or approval id, and `subscribe` delivers every bus frame of the installation. The WhatsApp plugin checks its own thread before deciding an approval (ADR-0017 decision 7). Nothing outside the plugin enforces that. With one plugin and one connection per workspace this is a contract gap, not a demonstrated exploit; with several connections per plugin it would make every adapter responsible for every other connection's isolation.

The research for the issue inspected public sources only. For personal WeChat it found a Tencent-published adapter (`openclaw-weixin`, MIT, under Tencent's verified GitHub organisation) that uses the iLink service: QR authorisation, persisted credentials, long polling, several accounts, direct chat and media advertised in its capability declarations, and a reply `context_token` cached per account and user. Its protocol document cautions that fields such as `group_id` do not guarantee server behaviour, and its account code replaces a stale account on re-login. None of that is a live test. Tencent's hosted-service terms, quotas and pricing were not obtained.

No provider account, credential, live configuration or paid test was created for this ADR. Every provider fact below is documentation or source reading and is marked as such.

## Decision

### Owner decisions (2026-10-13, decided)

1. **First wave.** The first wave is Telegram, personal WeChat, Discord and Slack, alongside the existing WhatsApp work of issue deskmates-private#1. No order among the four is implied. E-mail is not in the first wave; its research stays on the issue as history and is not an MVP dependency. *Owner ruling 2026-10-17:* personal WeChat is deferred to a later phase (decision 16), so the first wave that ships is Telegram, Discord and Slack.

2. **Personal WeChat, direct chat only.** WeChat means personal WeChat, not WeCom or enterprise WeChat. The first version's outcome is one person chatting directly with one Agent in WeChat. There is no WeChat group requirement in this version. That exclusion does not decide group support for Telegram, Discord or Slack.

3. **One connection, one external identity, exactly one Agent.** A channel connection is identified by its actual external bot, app or account identity and binds to exactly one Agent. Different connections, on the same or different providers, may bind to different Agents, and one Agent may have several connections.

4. **No multiplexing of Agents behind one identity.** Several Agents never share one external bot, app or account. There is no per-conversation Agent multiplexing, no selector or automatic routing among Agents behind one identity, and no many-Agent binding on one connection. A second Agent that needs its own recognisable entry gets its own external identity.

5. **Several independent identities per provider.** A provider may have several independent apps, bots or accounts, each its own connection bound to one Agent; Telegram and Discord are the owner's named examples. This is neither "one Agent per provider" nor permission to register one external identity as several connections. Slack and personal WeChat follow their verified capability matrix (decision 12), not a presumed equivalence with Telegram and Discord. The WhatsApp scope approved in issue deskmates-private#1 and ADR-0017 amendment 1 P4 is unchanged and is not generalised by this ADR.

### Owner rulings of 2026-10-17 and engineering choices

The owner answered the nine questions of the draft on 2026-10-17. Decisions 7, 8 (with the notice), 9, 12, 13, 15 and 16 below are rewritten to those answers and are accepted. Two further rulings have no decision of their own: groups, channels, threads and topics are not implemented in the first version (1:1 only; group support is designed in a later version, not shipped disabled), and design change C43's condition is withdrawn (Slack is in the first wave without waiting for a per-bot work-record view, which is ADR-0046's Grafana and the run drawer). Decisions 6, 10, 11 and 14 are engineering detail, accepted under owner delegation on 2026-10-17 as reviewed against the code.

6. **Identity is normalised from an authorised verification call, never from what the operator typed.** *(Accepted under owner delegation, 2026-10-17, with the keys as built and the `link` exception of amendment 1 A1.)* Before any connection row exists, the Gateway asks the plugin to verify the supplied credential (`verify` in ABI 2), so a duplicate identity is refused before anything is stored or started. The plugin calls the provider's own identity endpoint with the supplied credential and returns an `identityKey` of the form `<provider>:<namespace>:<id>`, plus a display label that is not part of the key. The keys as built: Telegram `telegram:bot:<bot user id>` from `getMe`; Discord `discord:app:<application id>` from the current application and bot user; Slack `slack:<team id, or enterprise id for an org-wide install>:<app id>` from `auth.test` on the installed bot token, with the app id from `bots.info`, because `auth.test` names the bot but not its app; WhatsApp `whatsapp:cloud:<phone number id>` checked against the Graph API, and `whatsapp:linked:<number>` claimed after the scan (amendment 1 A1). Personal WeChat's `wechat:ilink:<account id>` stays the plan for its phase (decision 16). A method that declares `identity: "link"` has no verification call before its row exists: it is stored under a reserved pending key, and its identity is checked, and a duplicate refused, when the plugin claims it (amendment 1 A1). A token prefix, a username, or a phone number, id or QR payload as the operator typed it is never the key. The key holds no credential material; it and its display label are the only identity values stored in ordinary columns, responses and logs.

7. **Uniqueness is by identity across the installation, not by plugin per workspace.** *(Accepted 2026-10-17: one external bot, app or account binds to exactly one Agent anywhere in the installation.)* `channel_connections` gains the identity key and `binding_generation`. The columns are named `account_key` and `account_label`, because ADR-0004 item 4 (and `db/migrate.test.ts`) keeps identity-named schema out of the database; the API and contracts call the value `identityKey`. A disconnect deletes the row, so a unique index on `(plugin_id, account_key)` over every row with a key makes a second connection of the same identity fail with a typed `channel_identity_in_use` error, whether the duplicate is a second token for the same bot, an alias, or the same identity in another workspace (a cross-workspace duplicate would be one identity behind two Agents, which decision 4 forbids). `UNIQUE (workspace_id, plugin_id)` is replaced by a manifest flag `multipleConnections`: a plugin without it keeps one connection per workspace, which is how WhatsApp keeps P4. The row copies the flag at creation, and a partial unique index on `(workspace_id, plugin_id)` over rows without it keeps that rule in the database as well as in the Gateway. SQLite cannot drop a table constraint in place, so the change is one forward migration that rebuilds `channel_connections` and its indexes (ADR-0030 naming, ADR-0031 conventions). The identity that verification returns on a reconnect or relink must equal the stored key; a different identity is refused with `channel_identity_mismatch` and the operator is told to create a new connection.

8. **The binding is explicit, versioned and one-to-one.** *(Accepted 2026-10-17 as proposed, with the notice below.)* The binding is the connection's `bot_id` plus `binding_generation`, starting at 1; it is not a separate many-to-many table. Only a workspace Owner or Admin creates, rebinds or disconnects a connection, and only to a Bot of the same workspace (ADR-0022 amendment 6). Every change is an audit event carrying actor, connection, old and new Bot and generation. A rebind is a fence, in this order:
   - the generation is incremented before anything else, so every host call and callback still carrying the old generation is refused (decision 9);
   - inbound for the old generation is no longer admitted; the next admitted message of a conversation creates a new thread for the new Agent and generation;
   - runs of the old Agent started by this connection are stopped; pending approvals in its threads are expired with the reason `binding_changed`; unsent outbound for those threads is cancelled and recorded as cancelled, never sent after the fence;
   - the old threads stay as read-only mirrors under the old Agent; no history, memory or SDK session moves to the new Agent;
   - the person on the other side receives one notice before the first reply after the rebind, naming the new assistant (owner ruling; the wording is the implementation's). When the first admitted message of a conversation creates its thread for the new generation and that conversation had a thread under an earlier generation of the same connection, the Gateway appends, before the person's message, one `system` message: `This conversation is now handled by <Bot name>. Earlier messages stay with the previous assistant and are not carried over.` The plugin relays it like every other message not written by the sender, so it reaches the person ahead of the reply; a conversation that never had an earlier thread gets no notice, and a conversation gets it at most once per rebind.
   A credential change for the same identity (token rotation, QR re-login) is a relink, not a rebind: it keeps the binding generation, increments a `credential_generation` held in the plugin state, and discards reply contexts and receipts of the previous credential generation. A plugin may carry a provider cursor across a relink only where its capability matrix declares the cursor identity-scoped (for example Telegram's update offset); otherwise the cursor is reset.

9. **The host is scoped to one connection and one generation.** *(Accepted 2026-10-17: the connection-scoped host lands before any multi-connection plugin; WhatsApp moves to ABI 2 in its own change.)* ABI version 2 of `ChannelPlugin` replaces the plugin-wide host with a `ChannelConnectionHost` handed to the runtime per connection (on `connect` and `restore`) and bound to `(workspace, connection, binding generation)`. The Gateway checks, not the plugin:
   - `createThread` creates only in the connection's workspace, with the bound Bot as the only member, the plugin's channel name, and an external key the host prefixes with the connection id (`<connection id>:<provider conversation key>`); the plugin cannot choose another workspace, Bot or prefix;
   - `findThread`, `getThread`, `listMessages` and `postHumanMessage` reach only threads bound to this connection and generation; the message `externalId` is namespaced by the connection id as well;
   - `getApproval` and `decideApproval` reach only approvals whose thread is one of this connection's current-generation threads, decide only `allow_once` or `deny`, and record the deciding author as the channel author id; sender matching (the decision comes from the thread's own external sender) remains the plugin's check as in ADR-0017 decision 7, on top of the host's;
   - `subscribe` delivers only frames of this connection's threads;
   - outbound passes a gate: before each provider send the plugin asks the host (`beginSend`) whether that message may still go out, and after the provider's receipt it records the send (`recordSend`); the Gateway keeps those receipts with connection, binding generation and credential generation, so "cancelled at the fence" and "sent" are both facts in the Gateway, not only in plugin state *(proposed detail)*;
   - every call first checks that the connection is live and the generation current; a stale, revoked or disconnected handle gets a typed `channel_connection_stale` error and produces no message, run, decision or outbound effect.
   Errors are typed in `contracts`. Multiple connections per plugin are offered only to ABI-2 plugins. WhatsApp moves to ABI 2 in its own change; until then its ABI-1 host is narrowed to the workspaces in which that plugin has a live connection, which is the most the old contract can express.

10. **Every record carries its connection.** *(Accepted under owner delegation, 2026-10-17, narrowed to the records that exist.)* Threads bound to a channel carry `channel_connection_id` and `binding_generation` columns (indexed; the thread cascades with its workspace, and a disconnect, which deletes the connection row, clears the reference and leaves the thread as a read-only mirror). A run started from such a thread records the connection, plugin and generation in `runs.config_json`, so token usage and cost attribute to the workspace, Bot, connection and generation without reading mutable rows. An approval reaches the pair through its thread and carries no copy. Outbound receipts carry connection, binding generation and credential generation. There is no channel dead-letter record in this version: a send the provider refuses for good is logged by the plugin, leaves no receipt and moves the relay cursor on (ADR-0017 decision 6). External ids (peer, conversation, event, message, thread or topic ids) are namespaced by connection everywhere and are never treated as globally unique; identical provider ids in two connections or two workspaces are different keys.

11. **Ingress and egress reuse the existing at-least-once mechanisms.** *(Accepted under owner delegation, 2026-10-17, with Slack's id and the transports as built.)* Inbound idempotency stays the Gateway's `(thread, external_id)` uniqueness, deduplicated per connection, with the provider's event or message id as the namespaced external id (Telegram `<chat id>:<message id>`, not `update_id`, which the Bot API may restart at a random value after a week without updates; Discord message id; Slack `event_id`, which the plugin requires: an event without one is dropped as malformed, with no `ts` fallback; WhatsApp's `wamid` or the linked device's message id; the iLink message id in its phase). Outbound stays a per-thread relay cursor plus delivered-chunk count in the plugin's private state (ADR-0017 decision 6), in the connection's own state directory and discarded when the credential generation changes; WhatsApp keeps its ABI-1 cursor files keyed by linked account (amendment 1 A4), which is equivalent because a relink must claim the same number. A send is acknowledged only after the provider returns a message id or receipt, and the Gateway's receipts keep a fully sent message from going out twice. Delivery is at least once; the product does not claim exactly-once external delivery, and a duplicate visible message after an uncertain send is the documented failure, while an admitted inbound message never starts a second run. The first-wave plugins need no public ingress and build none: Telegram long polling, Discord's Gateway websocket and Slack Socket Mode, whose webhook entry answers 404. WhatsApp's Cloud API is the one signed webhook in this version (ADR-0017 decision 5). An optional Telegram webhook or the Slack Events API, if a later change adds one, enters the generic channel webhook route of amendment 1 P3 and is verified by the plugin before any host call; iLink long polling is the plan for WeChat's phase.

12. **Each provider has a declared capability matrix, and unsupported means disabled.** *(Accepted 2026-10-17 with the media and group rulings.)* The manifest's `capabilities` grows into a matrix with one entry per row below, each `available`, `disabled` (supported by the provider but off in this version) or `unavailable` (not supported, not verified, or not implemented in this version). The UI shows the state; a disabled or unavailable feature is refused with a visible notice, never simulated. The matrix ships with the plugin and is versioned with it. Two rows are fixed by the owner for every provider in this version: groups, channels, threads and topics are `unavailable` (1:1 only; group support is a later design, not a disabled switch), and inbound images are `available`: an image a person sends enters the workspace exactly as a Web upload does (a completed upload under `/work/uploads/`, attached to the person's message by upload id) and is shown to the model only when the run's vision policy delivers images, so a model without vision gets the withheld-image notice instead (ADR-0023 amendment 2). Other inbound media (voice, video, documents, stickers, locations) stays `disabled` with the refusal notice. Proactive (non-reply) sends stay reply-only where unverified. The ABI-2 manifest type fixes `groups: "unavailable"`, so a plugin cannot declare otherwise in this version. The entries below are what public documentation or source reading suggests, every provider-specific cell unverified until the plugin's live journey records it:

| Row | Telegram | Discord | Slack | Personal WeChat (iLink, later phase) |
|---|---|---|---|---|
| Connect and identity check | bot token, `getMe` | bot token and application id, current application and bot user | OAuth install into one Slack workspace, `auth.test` | QR authorisation; identity field to confirm in the pinned adapter |
| Revoke | token revocation in the provider's bot settings; Gateway disconnect deletes the token record | token reset in the developer portal; disconnect | app uninstall or token revocation; disconnect | logout or account replacement on re-login; disconnect |
| Several independent identities | one bot per token; distinct bot ids | one bot per application; distinct application ids | one app per installation; a second Agent needs a second app in that Slack workspace | per-account limits for one personal identity not established; gate W3 |
| Direct messages | `available` (a user must start the bot first) | `available` (reachability depends on shared server or user install) | `available` (app messages tab) | `available` (1:1 only, the version's whole scope) |
| Groups, channels, threads, topics | `unavailable` (not in this version) | `unavailable` | `unavailable` | `unavailable` (decision 2) |
| Inbound images | `available` (largest photo size, provider size limit) | `available` (image attachments) | `available` (image files the bot can read) | to confirm at gate W8 |
| Other inbound media | `disabled`, refusal notice | `disabled`, refusal notice | `disabled`, refusal notice | `disabled`; real type and size behaviour is gate W8 |
| Outbound reply | text, chunked at the provider's message limit | text, chunked | text, chunked | text, needs a valid reply context token |
| Proactive message (not a reply) | `unavailable` until verified (provider allows it only to a user who has started the bot) | `unavailable` until verified | `unavailable` until verified (provider allows it to a user who has opened the app's messages tab) | `unavailable` until gate W4 establishes the window |
| Streaming or edit-in-place progress | `disabled` | `disabled` | `disabled` (a streaming method exists; not used in v1) | `unavailable` |
| Approvals from the provider | text grammar of ADR-0017 decision 7 | same | same | same |
| Rate limits | provider-documented guidance; 429 with retry-after honoured | rate-limit headers and 429 honoured | method tiers and 429 honoured | not officially published; gate W4 |

13. **Admission and disclosure are per connection.** *(Accepted 2026-10-17: allow by default with a blocklist.)* Verifying a connection says who the connection is, not who may write to it; the owner chose to admit every sender of an ABI-2 connection unless that sender is on the connection's own **blocklist** of provider user ids. There is no allowlist gate and no pairing code. The blocklist is kept by the Gateway, not by the plugin: a workspace Owner or Admin adds and removes entries in the Integrations UI (audited `channel.sender_block` and `channel.sender_unblock`), and the host refuses a blocked sender in both directions, as ADR-0017 decision 4 does for its list: a blocked sender's message is acknowledged to the provider and dropped with no thread, message or run, and nothing further is sent to a blocked sender's thread (the send gate of decision 9 answers `blocked`), while the thread and its history stay. Unblocking does not replay what was skipped. Each external conversation has its own one-member thread and SDK session, separate from the Bot's Web private chat and from every other conversation (ADR-0017 amendment 2 M1). Context is never shared across connections or conversations by default. The read-only Web mirror and its server-side guard (amendment 2 M2 and M3) apply unchanged to every channel name, because the guard tests `channel != web`. Approval mode, egress, network, model and budget policies apply to channel-started runs as to any other. A credential is never reused across workspaces. WhatsApp follows this decision too since the owner answered amendment 1 A3 on 2026-10-17 (ADR-0017 amendment 3): its stored allowlists were dropped, nobody was blocked, and its connections use this blocklist.

14. **Credentials and private state.** *(Accepted under owner delegation, 2026-10-17; workspace purge now does what this says.)* Bot tokens, app secrets, signing secrets and app-level tokens are encrypted secret records referenced by the connection (amendment 1 P6), never in `config_json`, the identity key column (`account_key`), responses or logs. QR credentials and long-poll cursors live in the connection's private state directory (0700, files 0600), one directory per connection id, removed on disconnect or workspace purge. A purge removes the workspace's channel state directories without contacting the provider (owner ruling of 2026-10-18: no logout at purge; the workspace was archived first, so no connection is live, and the phone keeps a stale linked device until the person removes it), then the rows and secret records go with the workspace.

15. **Code shape: provider dependencies are isolated per provider and lazy.** *(Accepted 2026-10-17; replaces the draft's "no third-party runtime dependency".)* Each provider is one release-bundled ABI-2 plugin in `packages/channels/src/<provider>/`, importing only `contracts` from workspace packages. A provider may use a third-party SDK (a chat SDK such as the Vercel Chat SDK, a provider client library) under one rule: every such dependency is declared and loaded in one place, `packages/channels/src/provider-dependencies.ts`, which pins the package, names the one provider that uses it, and imports it only through a dynamic `import()` when that provider is opened. Provider code never imports a third-party package statically. The Gateway in turn creates an ABI-2 plugin's runtime only when a connection of that plugin is first connected or restored, so an installation that never connected a provider never loads that provider's runtime or its dependencies, and a release can leave out the packages of providers it does not ship. A dependency's own state or retry model never replaces the Gateway's transcript, idempotency and send gate; a plugin that uses one still passes the same contract tests. WhatsApp's existing pinned dependencies (Baileys, the proxy agent, `pino`, `qrcode`) stay as they are until its own ABI-2 change. Personal WeChat, when its phase starts, follows the same rule; the choice between porting the iLink protocol client and depending on a pinned, checksum-verified Tencent adapter release with its MIT notice is still made after gate W6. ADR-0013's integration runtime keeps SaaS tool actions; two-way channel ingress, sessions and outbound stay in the channel layer, and a Slack integration tool and a Slack channel connection are separate things with separate credentials.

16. **Personal WeChat is deferred to a later phase.** *(Accepted 2026-10-17.)* The first wave is Telegram, Discord and Slack. The gates below and the test accounts they need are not authorised now; this section stays as the plan for the later phase. When that phase is authorised, the WeChat plugin is built behind the gates and is not offered in a release until each has a recorded result (passed, failed, blocked or not run) on separately authorised test accounts. A failed or blocked gate keeps the plugin out of the release; it never becomes a claim of compliance, free or unlimited service, stability or zero account risk. The ABI-2 contract has no method for an identity known only after a QR scan; the WeChat phase adds one as an ABI-2 extension.
   - W1: current region, account and client eligibility for iLink authorisation.
   - W2: token and session lifetime, the re-login path, and what the stale-account replacement does to an existing connection (expected: a relink of the same identity, decision 8).
   - W3: how many simultaneous authorised connections one personal identity may hold, so that decision 7's uniqueness matches the platform.
   - W4: quotas, the reply context-token lifetime and any proactive-send window.
   - W5: the client and adapter scope Tencent allows, and the current hosted-service terms.
   - W6: iLink pricing and service level, and whether the adapter's protocol client can run without its original host framework.
   - W7: that 1:1 inbound, reply, restart, relink and disconnect work end to end with no group behaviour exercised or claimed.
   - W8: actual media types and sizes, even though media is disabled in the first version, so the refusal notice is accurate.
   Other personal-WeChat transports (puppet services, desktop-client hooks) remain fallback research only and are not first-wave baselines.

## Alternatives considered

- **Many-to-many Agent bindings behind a shared product bot, routed by deep link, command or selector.** The issue's original proposal. Rejected by the owner (decisions 3 and 4): one identity behind several Agents is ambiguous to the person on the other side.
- **Keep the plugin-wide host and require each adapter to check its own connection.** Works for one connection per workspace. With several, one adapter bug would leak another connection's threads and approvals, and the Gateway would have no single place to fence a rebind. Rejected for decision 9.
- **Uniqueness per workspace only.** Would let the same bot token be connected in two workspaces and so sit behind two Agents. Rejected for decision 7.
- **A separate binding table that allows history migration on rebind.** Moving a person's private history to a different Agent is exactly what the owner said not to do implicitly. A migration flow can be a later, explicit design; decision 8 does not need a table for it.
- **A unified chat SDK as the adapter layer.** Faster to start, but it duplicates the durable inbox and outbox the Gateway already has, and its retry and state semantics are untested here. Not adopted as the layer between the Gateway and providers; since the owner's ruling of 2026-10-17 a provider plugin may use one internally, declared and loaded lazily through the dependency registry, if it passes the same contract tests (decision 15).
- **An allowlist with a pairing code an Admin confirms.** The draft's proposal for decision 13. Not adopted: the owner chose allow-by-default with a per-connection blocklist on 2026-10-17.
- **Groups shipped disabled behind a switch.** The draft's proposal. The owner ruled that group support is a later design, so nothing in the first version models a group conversation.

## Consequences

- `contracts`: `ChannelPlugin` ABI 2 in `channel-connection.ts` (`ChannelConnectionHost`, the capability matrix, `multipleConnections`, `verify` and its `ChannelIdentity`, the send gate, inbound images), and typed errors `channel_identity_in_use`, `channel_identity_mismatch`, `channel_connection_stale`. ABI 1 (`channel.ts`) is unchanged and still accepted.
- Gateway: one forward migration rebuilding `channel_connections` with `api_version`, `account_key`, `account_label` (the identity key and label), `binding_generation`, `credential_generation`, `multiple_connections`, the identity unique index and the single-connection backstop; `channel_connection_id` and `binding_generation` on `threads`; `channel_sender_blocks` and `channel_outbound_receipts`; a connection-scoped host in `src/channels/`; connection-addressed lifecycle, rebind, relink and blocklist routes with their policies; the connection, plugin and generation frozen in `runs.config_json`.
- `packages/channels`: three new plugin directories, built by other changes on top of ABI 2; the dependency registry; WhatsApp unchanged until its own ABI-2 change.
- `packages/testkit`: a fake ABI-2 provider that the Gateway's T1 tests drive, also usable by provider plugins' own tests.
- Web: the Integrations page lists several connections per plugin when the manifest allows it, shows each connection's identity label, Bot and capability matrix, and offers rebind, relink and blocklist management to Owners and Admins only.
- Operations: each connection is a long-lived poll or websocket in the Gateway process (amendment 1 P1 already accepts that a plugin is not isolated from the process). Inbound images need the workspace to be running, as a Web upload does; while it is stopped, the person's text is still posted and the image is refused with a notice.
- C43's condition is withdrawn by the owner (2026-10-17); the design document's C43 row stays as history and is not edited by this ADR.
- Unverified: every provider fact in decision 12, every gate in decision 16, and the live rows of the Verification table. No live provider test was done for this ADR.

## Verification

The owner's verification bullets of 2026-10-13 are cited as V1 to V6 in the Means column so each can be traced to a row: V1 lifecycle evidence per provider; V2 distinct apps on one provider and one Agent across providers; V3 colliding ids and stale or wrong callbacks; V4 rebind, relogin, restart and cursor or context changes; V5 duplicates, retries and visible failures; V6 live QR and WeChat behaviour on authorised accounts.

| Decision | Means | Test | Metric |
|---|---|---|---|
| 1 | the release manifest lists only the plugins the release ships (today WhatsApp and Telegram; Discord and Slack as each lands), and no e-mail or WeChat plugin before its phase | T0 `scripts/write-channel-plugin-manifest.test.mjs`, extended by each provider change | none |
| 2 | deferred with the WeChat phase (decision 16): when it starts, the WeChat plugin declares groups `unavailable` and a group event creates no thread, message or run (V1: 1:1 only) | T1 `packages/channels/src/wechat/plugin.test.ts` with a scripted iLink transport (implemented 2026-10-27; live acceptance not run) | dropped group events (reported) |
| 3, 4 | a connection has exactly one Bot; the connect body accepts one `botId`, and inbound on a connection only ever wakes its bound Bot (V2) | T1 `packages/gateway/src/channels/connection-binding.test.ts` | none |
| 5 | two connections of one ABI-2 plugin with distinct identities in one workspace bind to two different Bots and keep threads, sessions and run usage separate; one Bot holds connections of two plugins without sharing a thread (V2); an ABI-1 plugin without `multipleConnections` (WhatsApp) still refuses a second connection in a workspace | T1 `connection-binding.test.ts` with the testkit fake ABI-2 provider; existing `api/channel-routes.test.ts` for ABI 1 | runs and tokens per connection |
| 5 (live) | the same as above on real provider apps | manual journeys per provider, recorded in `docs/design/` with versions, dates, redacted ids and passed/failed/blocked/not-run; **not run** | none |
| 6 | the identity key comes from the verification call's response, not the input; a token or secret never appears in the key, a response or a log line | T1 `connection-binding.test.ts` (the fake derives the key from its own lookup; responses and stored rows hold no secret); a log-capture assertion is left to each provider change; per-plugin connect tests against scripted provider servers in each provider change (Telegram: T1 `packages/channels/src/telegram/plugin.test.ts`, identity from `getMe`, no token in logs, statuses, host calls or state) | none |
| 7 | a second connection of the same identity in the same or another workspace gets `channel_identity_in_use`, including a second token for the same bot (V2); a relink returning a different identity gets `channel_identity_mismatch`; the migration rebuilds the table and keeps existing rows | T1 `connection-binding.test.ts`; T1 `packages/gateway/src/channels/channel-migration.test.ts`; `db/schema-conventions.test.ts` | refused duplicate connects (reported) |
| 8 | a rebind increments the generation first; after it, the next inbound creates a new thread for the new Bot, old runs are cancelled, old approvals are closed `binding_changed`, unsent old outbound is recorded cancelled and the send gate refuses it, old threads stay read-only under the old Bot, and no message or session moves (V4); the person gets the rebind notice once, before the reply; a relink keeps the binding generation and increments the credential generation | T1 `packages/gateway/src/channels/rebind.test.ts` with the fake provider holding a queued send | rebinds and cancelled outbound per rebind |
| 9 | a plugin cannot create a thread in another workspace or with another Bot, cannot read, post to, subscribe to or decide an approval of another connection's thread, and gets `channel_connection_stale` with zero effects after a rebind or disconnect (V3); the ABI-1 host reaches only workspaces where its plugin has a connection | T1 `packages/gateway/src/channels/connection-host.test.ts` driving a hostile fake plugin; T0 `packages/contracts/src/channel-connection.test.ts` | stale-handle refusals (reported) |
| 10 | identical conversation and message ids in two connections and two workspaces create distinct threads and messages; a channel-started run's `config_json` carries connection, plugin and generation; usage aggregates by connection (V3) | T1 `connection-host.test.ts` collision and run-config cases | share of channel runs without a connection in `config_json` (target 0) |
| 11 | a duplicated inbound event starts one run (Gateway side); per provider: reordered or retried events, lost acknowledgements, sends without receipts and bad webhook signatures (V5) | T1 `connection-host.test.ts` for the Gateway's idempotency; per-plugin ingress and outbound tests with scripted servers in each provider change (Telegram: `telegram/plugin.test.ts`, redelivery, 429 resume, offset across restart) | visible duplicate sends; inbound duplicates suppressed |
| 12 | an ABI-2 manifest declares every matrix row with a known state and groups `unavailable`, or the plugin is refused at load; an inbound image becomes a completed workspace upload attached to the person's message like a Web upload, and a run's vision policy decides whether the model sees it; other media is refused by the plugin with a notice and creates no run (V5); the UI renders the matrix from the manifest without provider branches | T0 `channel-connection.test.ts`; T1 `packages/gateway/src/channels/inbound-images.test.ts`; T1 `packages/web/src/features/integrations/channel-connections.test.tsx`; per-plugin refusal tests in each provider change (Telegram: `telegram/plugin.test.ts`, `telegram/updates.test.ts`) | refusals by capability row |
| 13 | any sender of an ABI-2 connection is admitted unless blocked; a blocked sender's message creates no thread, message or run and its thread receives nothing (the send gate answers `blocked`); unblocking does not replay; only Owners and Admins change the list; WhatsApp admits by default and takes the blocklist too (amendment 1 A3); a channel thread and the Bot's Web private chat are different threads; a signed-in person's post to any non-web channel thread gets 403 `channel_thread_read_only` | T1 `packages/gateway/src/channels/sender-blocklist.test.ts`; T1 `whatsapp-abi2.test.ts` and `packages/channels/src/whatsapp/plugin.test.ts`; existing `thread-channel-mirror.test.ts` | dropped senders by reason |
| 14 | secret plaintext is absent from database rows, responses and logs; each connection's state directory is 0700 and is removed on disconnect; a workspace purge closes its live connections and removes their state directories | T1 `connection-binding.test.ts`; per-plugin file-permission tests in each provider change (Telegram: `telegram/plugin.test.ts`, state file 0600, no credential in it) | none |
| 15 | provider plugins import only `contracts` and never a third-party package statically; every third-party dependency of a non-WhatsApp provider is declared, pinned and dynamically imported in `provider-dependencies.ts`; the Gateway creates an ABI-2 runtime only when one of its connections is opened | T0 `packages/channels/src/provider-dependencies.test.ts`; T1 `connection-binding.test.ts` (lazy creation) | none |
| 16 | deferred: before the WeChat plugin enters a release each gate W1 to W8 has a recorded result on authorised test accounts, and a release build with the plugin and a missing gate record fails (V6) | `scripts/wechat-release-gate.test.mjs` and the [readiness record](../design/wechat-native-readiness-2026-10-27.md), implemented 2026-10-27; live gates **not run** | gates passed/failed/blocked/not run |
| 1 (live) | Telegram, Discord and Slack (personal WeChat in its later phase) each record connect, inbound, reply, approval, restart, revoke or relink, reconnect and disconnect on real test accounts, with honest passed/failed/blocked/not-run (V1, V6) | manual journeys recorded in `docs/design/`; **not run**: no account, credential or live configuration exists | journeys by result per provider |

## Amendment 1 (2026-10-17): WhatsApp on ABI 2

*Accepted under owner delegation, 2026-10-17; A3 answered by the owner the same day.*

Decision 9's ruling ("WhatsApp moves to ABI 2 in its own change") is this change. Its rule is no
behaviour change a person can see: the scope of issue deskmates-private#1 and ADR-0017 amendment 1
P4 stays (one WhatsApp connection per workspace, one default Bot, private chats only, the
read-only Web mirror and its 403 `channel_thread_read_only`), and existing connections move in
place. Four things were missing from ABI 2 for that, and are added here as backwards-compatible
extensions every plugin may use.

A1. **An identity known only after linking.** Decision 16 noted that ABI 2 had no method for an
identity known only after a QR scan; WhatsApp's linked device needs it now. A connection method
may declare `identity: "link"`. For such a method the Gateway does not call `verify`: it stores
the connection under the reserved pending key `<plugin>:pending:<connection id>` (the `pending`
namespace is never a valid identity key, and responses never show it) and opens it. When the
provider names the account, the plugin calls `host.claimIdentity({ identityKey, label })`. The
first claim of a pending connection stores the key unless another connection holds it
(`channel_identity_in_use`, decision 7); a later claim must equal the stored key
(`channel_identity_mismatch`, decision 8), so a QR relink to another number is refused. On either
refusal the plugin serves nothing for that account and shows the reason. A relink of a `link`
method skips `verify` and keeps the stored key. WhatsApp's keys: `whatsapp:linked:<E.164 digits>`
for a linked device, `whatsapp:cloud:<phone number id>` for the Cloud API, which `verify` checks
against the Graph API's phone-number node with the operator's token (the answer must name the
configured id).

A2. **Sender admission is a per-plugin declaration.** The manifest's optional `senderAdmission` is
`{ mode: "blocklist" }`, the default and decision 13, or `{ mode: "allowlist", field }`: nobody is
admitted unless listed in that plain config field (comma-separated provider sender ids). The host
enforces the declared mode in both directions, as decision 13 does for the blocklist: `receive`
answers `blocked` for an unlisted sender, `decideApproval` refuses one, and `beginSend` answers
`blocked` (recorded with reason `sender_not_listed`) when the thread's person is no longer listed,
so re-adding the number does not replay what was skipped (ADR-0017 decision 4). The blocklist
routes refuse an allowlist connection. A new host method `admits(senderId)` lets a plugin ask
before it sends a notice the host would not otherwise see (WhatsApp's text-only notice and
approval refusals), so an unlisted sender gets nothing at all. WhatsApp declared
`{ mode: "allowlist", field: "allowedSenders" }` until A3 was answered; no release plugin declares
the allowlist mode now. The mode stays in the contract, still covered by its T0 and T1 tests,
until the ABI-1 clean-up of A5 removes it with the other unused contract parts.

A3. **WhatsApp's admission: allow by default (owner, 2026-10-17).** The owner's ruling 6 of
2026-10-17 had left open whether WhatsApp also becomes allow-by-default with a blocklist; the
owner answered it the same day ("发件人默认放行"): yes. ADR-0017 amendment 3 records the ruling
and what it means for WhatsApp. Here it is the manifest's `senderAdmission: { mode: "blocklist" }`
with the `allowedSenders` field removed from both methods, the generic blocklist routes accepting a
WhatsApp connection, the single-connection Integrations card offering the blocklist to Owners and
Admins, and the forward migration `202610171454-whatsapp-allow-by-default.sql`, which removes
every stored `allowedSenders`, blocks nobody, and stamps each WhatsApp connection
(`admission_changed_at`, `admissionChangedAt` in the API) so that its card says once that every
sender is now admitted. Approval commands keep ADR-0017 decision 7, enforced by the plugin and the
host.

A4. **The in-place migration.** `202610171305-whatsapp-channel-abi2.sql` (data only) turns every
ABI-1 WhatsApp connection into an ABI-2 connection of plugin version 2.0.0 at binding and
credential generation 1, still single-connection, with the pending key, and binds every WhatsApp
thread of the workspace (the ABI-1 host's reach) to it: `channel_connection_id`, generation 1, and
the host's external-key prefix `<connection id>:1:` before the unchanged conversation key
(`<phone number id>:<wa_id>` or `web:<number>:<wa_id>`). The connection id, its Bot, its Secret
Store record and its private state directory (0700, files 0600, keyed by the connection id) do
not change, so nothing is re-linked; the relay cursor files keep their thread ids. On restore the
plugin claims its number (A1). If two ABI-1 workspaces had linked the same number, the second
claim is refused and that connection shows the reason instead of serving, because one number
behind two Agents is what decision 4 forbids. A relink keeps the secrets it is not given (a QR
relink gives none, so its proxy URL survives).

A5. **Other consequences.** WhatsApp's capability matrix keeps ABI 1's behaviour: inbound images
and other media `disabled` (the text-only notice of ADR-0017 decision 5 stays), groups
`unavailable`, replies only, a test message. Receiving images on WhatsApp, as decision 12 rules for
the first-wave providers, is a separate change. The Integrations page keeps WhatsApp's one-card
lifecycle (QR, webhook path, test, relink) for any ABI-2 plugin without `multipleConnections`.
Rebind (decision 8) is available on the API for a WhatsApp connection like any ABI-2 connection;
the WhatsApp card does not offer it yet. After a disconnect and a new connect, conversations start
new threads, because threads now belong to the connection (decision 10); under ABI 1 the same
number found its old thread again. The ABI-1 host path (`plugin-host-v1.ts`, `ChannelPlugin` in
`channel.ts`) stays: no release plugin uses it any more, but its T1 suites still drive the
plugin-addressed routes, and removing a contract type while three provider changes edit the same
manager and contracts is left to one follow-up after they merge. The standalone diagnostic
binaries (`deskmates-whatsapp`, `deskmates-whatsapp-web`) keep the operator-API adapter.

### Verification (amendment 1)

| Item | Means | Test | Metric |
|---|---|---|---|
| A1 | a `link` method stores a pending key and opens; the claim stores the number, refuses another connection's number (`channel_identity_in_use`) and a different number later (`channel_identity_mismatch`); a stale host's claim has no effect; a QR relink skips verify and keeps the key; the Cloud API key comes from the Graph API answer, not the typed id | T1 `packages/gateway/src/channels/whatsapp-abi2.test.ts`; T1 `packages/channels/src/whatsapp/plugin.test.ts`; T0 `packages/contracts/src/channel-connection.test.ts` | refused claims (reported) |
| A2 | an allowlist plugin's unknown sender creates no thread, message or decision; a delisted person's thread receives nothing (`blocked`); the blocklist routes refuse it; a manifest naming a missing or secret field is refused at load (no release plugin declares the mode since A3) | T1 `whatsapp-abi2.test.ts` (an allowlist-declaring variant of the fake); T0 `channel-connection.test.ts` | dropped senders by reason |
| A3 | the release manifest declares the blocklist and no `allowedSenders`; an unknown sender is admitted; a blocked sender gets nothing in either direction; the migration drops stored lists, blocks nobody and stamps the connection; the single-connection card offers the blocklist and shows the notice once | T1 `whatsapp-abi2.test.ts`; T1 `plugin.test.ts`; T0 `packages/web/src/features/integrations/channel-integrations.test.tsx` | dropped senders by reason |
| A4 | an ABI-1 database upgrades with the connection's Bot, secret, state directory (0700/0600), threads and messages; the next message of a known conversation lands in its old thread; a redelivered ABI-1 message is a duplicate; a second connection in the workspace is refused; a doubly linked number is refused for one of the two | T1 `whatsapp-abi2.test.ts`; `db/schema-conventions.test.ts`; existing `channel-migration.test.ts` | none |
| A5 | the WhatsApp manifest loads as ABI 2 with `multipleConnections: false`; the single-connection card renders for it; the package boundary holds | T1 `plugin.test.ts`; T0 `packages/web/src/features/integrations/channel-integrations.test.tsx`; T0 `packages/channels/src/whatsapp/package-boundary.test.ts` | none |
| live | QR link, inbound, reply, approval, restart, relink and disconnect on a real phone and a real Cloud API number after the upgrade | manual journeys on the stable host; **not run** | journeys by result |

## Review under owner delegation (2026-10-17)

The owner delegated sign-off of decisions 6, 10, 11 and 14 and amendment 1 to the implementing
sessions on 2026-10-17. Each was read against the code on main (the Gateway's `src/channels/`, the
migrations, the four plugins in `packages/channels/src/`) and accepted. What the review changed:

- **Decision 6.** The proposed keys were confirmed in their provider slices; the text now names
  them as built. Slack's app id comes from `bots.info`, not `auth.test`, which does not return it.
  The `link` exception of amendment 1 A1 is written into the decision, because "before any
  connection row exists" holds only for a method that verifies. "A phone number is never the key"
  read as forbidding WhatsApp's own key; it now says what was meant: never the value as typed.
- **Decision 10.** The text promised the pair on approval and dead-letter records. Approvals
  reach it through their thread, which is enough to attribute them and avoids a second copy that
  could disagree; no channel dead-letter record exists, and the decision now says so instead of
  promising one. The thread reference is cleared, not cascaded, when a disconnect deletes the
  connection; the text said "cascading with the workspace", which is true of the thread itself.
- **Decision 11.** Slack has no `ts` fallback: the plugin requires `event_id` and drops an event
  without one, which is the stricter choice. No first-wave plugin built webhook ingress, so the
  decision no longer reads as if the Telegram webhook and Slack Events API exist. WhatsApp's
  relay cursors stay keyed by linked account (A4) instead of credential generation; that is
  recorded as an equivalent, since a relink must claim the same number.
- **Decision 14.** A workspace purge removed the connection rows and secret records but left the
  channel state directories (a QR link's credentials included) on disk and the live provider
  sessions running until a restart. The purge now closes the workspace's connections as a
  disconnect does and removes their directories first (`ChannelManager.permanentlyDeleteWorkspace`,
  called by the trash lifecycle; T1 `connection-binding.test.ts`). Archive did not stop a
  workspace's channel connections, which ADR-0017 amendment 1 P6 asks for; it now does
  (`ChannelManager.archiveWorkspace` and `restoreWorkspace`, 2026-10-17): each host goes stale,
  the provider session closes with the new `archive` close reason, which keeps the link and the
  state, and outbound left unsent is recorded `cancelled`; restore opens each connection with the
  `restore` reason and the same generations. T1 `workspace-archive.test.ts` (fake ABI-2
  provider: archive, restore, purge after archive) and `whatsapp-abi2.test.ts` (QR connection
  across a Gateway restart). One consequence for this decision: a workspace is archived before
  it can be purged, so at purge time no connection is live and a QR link is not logged out at
  the provider; its local credentials go with the state directory, and the phone keeps a stale
  linked device until the person removes it, as after a disconnect of a connection that is not
  live. The owner ruled on 2026-10-18 that a purge does not reconnect to log out;
  decision 14 says so.
- **Amendment 1.** A1, A4 and A5 match the code and are accepted as written. A2 is accepted with
  the note that no release plugin declares the allowlist mode after A3. A3 is the owner's answer.

## Amendment 2 (2026-10-22): a setup guide in the manifest

*Accepted by the owner, 2026-10-22, with the Connections redesign
([proposal](../design/connections-redesign-2026-10-22.md)): "用 Connections，Chat channels 放前面，然后全部做完吧".*

The owner found that nobody could tell how to connect a chat channel: each method had one prose
`description` and bare fields, and the page printed a README path. Comparable projects (OpenClaw,
LobeHub, nanobot, Chatwoot, n8n; sources in the proposal) ship per-channel setup steps with
official links, copyable values and a way to open the new bot. These additions are optional,
backwards-compatible and release-bundled with each plugin, like the rest of the manifest. The
Gateway validates them at load and passes them through unchanged; it gains no provider branch.

G1. **Setup steps.** A connection method may declare `setup: { steps }`: at most 12 steps, each
with a stable `id` (`[a-z0-9-]{1,32}`, unique in the method), plain `text` (at most 400
characters, never Markdown or HTML), an optional `link` (`label` and an absolute `https:` URL,
opened in a new tab without opener or referrer) and an optional `copy` (`label` and a value of at
most 4,000 characters). A copy value is a non-secret thing the person pastes on the provider, such
as a Slack app manifest; the only placeholder it may hold is `{webhookPath}`, which the Web
replaces with the connection's webhook path. Secret material is never a copy value or a link.

G2. **Field help.** A config field may declare `help`: plain text of at most 300 characters,
shown under the field ("where do I find this?").

G3. **An open link for the verified account.** A method may declare `open: { label, url }`: an
absolute `https:` URL template whose only placeholders are `{namespace}` and `{id}` (the second
and third segments of the verified identity key, decision 6) and `{handle}` (the identity label
without a leading `@` or `+`, offered only when it is 1 to 64 letters, digits, `_` or `.`). The Web
fills each placeholder URL-encoded and shows the link once the connection has a verified
identity; a pending identity (amendment 1 A1) or an unusable handle shows no link. The link is a
convenience to reach the bot, not a verification.

G4. **Translations.** Manifest text is English, and English is always shown from the manifest.
In another language the Web uses its catalog's keys under `channelGuide.<plugin>.<method>`:
`.label`, `.description`, `.step.<id>` with `.link` and `.copy`, `.field.<key>` with `.help`, and
`.open` (plus `channelGuide.<plugin>.description`), each segment with every character other than
a letter or digit written as `_`; a missing key falls back to the manifest's English. Links, copy
values and placeholders are never translated.

G5. **Refusal at load.** `channelManifestV2Problems` refuses a guide that breaks G1 to G3: too
many or duplicate steps, empty or overlong text, a non-https or relative URL, an unknown
placeholder in a copy value or an open URL, overlong help. The plugin then fails to load with
the reason, as for every other manifest problem.

### Verification (amendment 2)

| Item | Means | Test | Metric |
|---|---|---|---|
| G1 | a guide with valid steps passes; 13 steps, a duplicate id, an empty or 401-character text, an `http:` or relative link, and a copy value with `{token}` are each refused; every release plugin's guide passes | T0 `packages/contracts/src/channel-connection.test.ts`; T1 `packages/channels/src/setup-guides.test.ts` | none |
| G2 | help over 300 characters is refused; the Web shows help under its field | T0 `channel-connection.test.ts`; T0 `packages/web/src/features/integrations/channel-setup.test.tsx` | none |
| G3 | an open URL with a placeholder other than `{namespace}`, `{id}` and `{handle}` is refused; the Web fills a verified Telegram identity into `https://t.me/<username>`, encodes the values, and shows no link for a pending identity or a label that is not a handle | T0 `channel-connection.test.ts`; T0 `packages/web/src/features/integrations/channel-guide.test.ts` | none |
| G4 | a step with a Web translation shows it in that locale; one without shows the manifest's English | T0 `channel-guide.test.ts` | none |
| G5 | a release plugin whose guide breaks a rule fails to load with the problem named | T1 `packages/gateway/src/channels/plugin-loader.test.ts` (existing invalid-manifest case) | plugin load failures |
| live | each provider's steps lead a person who has never connected it to a working connection | manual journeys with real accounts; **not run** | journeys by result |


## Amendment 3 (2026-10-27): Telegram continuity

Accepted under the owner's instruction to prioritize long-term information synchronization.

S1. Telegram continues the same person's existing conversation. `/start` and `/help` explain
that continuity; `/status` reads its current activity and delivery state without waking a model.
There are no `/new`, `/reset` or `/stop` actions. Unknown commands explain the supported inputs.
Normal text remains a message to the Agent. Provider account menus are not changed at startup.

S2. The scoped host optionally exposes `listThreads` and `syncActivity`. The former lists only
current-binding threads. The latter reads the latest non-model-job run of that thread and records
one deterministic system notice per meaningful state: failure, interruption, a browser/platform/
continuation wait, and recovery after such a notice. Approval cards and Agent replies already
carry decisions and results; ordinary queued/running/success transitions stay quiet. Notices do
not wake an Agent. Stored message identifiers deduplicate snapshots after restarts. Recovery
reports current state, not every obsolete intermediate transition. No workspace-wide or other
person's activity is exported.

S3. Telegram registers the event listener before recovery, discovers threads from the Gateway,
coalesces simultaneous relay requests, and drains all message pages in sequence. Confirmed chunks
and receipts prevent ordinary replay duplicates; an ambiguous network send can still repeat.
Transient retries retain their backoff even when new messages arrive. Permanent refusals and
ambiguous sends leave a bounded, durable diagnostic in that thread's private cursor, visible to
`/status`; they never count as confirmed delivery. The existing generation fences and send gate
remain mandatory, including before each chunk.

S4. A manifest may advertise a command menu and an optional runtime operation to inspect or
synchronize it. The connection-addressed operator endpoint is Owner/Admin-only. The UI previews
the exact list and selects one scope (default, all private chats, or a specified private chat)
and language. Synchronization only replaces that target; it cannot enumerate unknown overrides.
Menu buttons remain unchanged unless the operator explicitly selects replacement; identity,
name, description and avatar are never changed. Menu failures do not stop polling. Connect,
reconnect, upgrade and rebind never rewrite provider menus automatically. `/settings` links to
an operator-configured HTTPS Web URL when present; it grants no workspace role.

### Verification (amendment 3)

| Item | Means | Test | Metric |
|---|---|---|---|
| S1 | commands do not create runs or reset conversations; blocked senders receive nothing | `packages/channels/src/telegram/plugin.test.ts` | command replies / refused senders |
| S2 | notices deduplicate, recover, and remain connection-scoped without a model call | `packages/gateway/src/channels/connection-host.test.ts` | activity notices |
| S3 | restart discovers missing cursors; paged backlog drains in order; events respect retry delays | `packages/channels/src/telegram/plugin.test.ts` | confirmed chunks, send failures, delivery uncertainty |
| S4 | target scope/language is explicit, repeated sync is safe, custom menu buttons survive, and failure leaves chat working | `packages/channels/src/telegram/plugin.test.ts`; `packages/web/src/features/integrations/channel-menu.test.tsx`; channel route policies | menu sync outcomes |
| live | reconnect and delayed delivery on a real Telegram account | not run | journeys by result |
