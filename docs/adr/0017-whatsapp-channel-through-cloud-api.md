# ADR-0017: The WhatsApp channel is a standalone adapter on the WhatsApp Business Platform Cloud API

Date: 2026-10-02
Status: Accepted for implementation, including amendment 1 on 2026-10-11 and amendment 2 on 2026-10-12; live-account rows remain pending

2026-10-03 update: [ADR-0019](0019-whatsapp-linked-device-qr.md) supersedes the
Cloud-API-only selection and rejection of QR-linked clients following the owner's
explicit request for QR onboarding. This document remains the optional Cloud API
transport's record; the channel/Gateway semantics continue to apply to both.
Builds on: ADR-0002 (approvals are thread messages any member may decide), ADR-0005 (threads have members; the transcript belongs to the Gateway), ADR-0006 (operator routes are authenticated and sit on the operator listener)

## Context

Design v0.3 §8 lists a chat channel for M3 and C43 names WhatsApp. The blueprint says a channel adapter "turns external messages into Gateway chat triggers and relays replies back" and that "channel adapters map native mentions" (§3.3). `threads.channel` has existed since migration 0001 for exactly this, but no adapter exists and nothing binds a thread to an external conversation.

What has to be settled before code, in the words of the M3 inventory: connection mechanism, account prerequisites, workspace and thread mapping, sender identity, deduplication, mentions, delivery and approval semantics. The architecture constraints that apply: the Gateway never calls a model and stays thin; nothing imports across packages except from `contracts`; the operator token is never exposed to a sandbox; page content and external bodies are untrusted; every trigger creates a run row first.

### Connection mechanisms considered

| Mechanism | What it is | Verdict |
|---|---|---|
| WhatsApp Business Platform **Cloud API** (Meta-hosted) | HTTPS webhooks deliver inbound messages to a URL the operator registers; outbound messages are `POST /<version>/<phone_number_id>/messages` on the Graph API with a Bearer access token | **Chosen.** Official, documented, no reverse engineering, no persistent device session, webhook bodies are signed |
| On-premises Business API | Same contract, operator-hosted Docker stack | Rejected: Meta has been retiring it in favour of the Cloud API; heavier to run; no benefit for this product |
| Business Solution Provider (Twilio, 360dialog, …) | A vendor in front of the same platform with its own webhook and send shapes | Not chosen: another vendor contract and credential; the Cloud API shape is the one every BSP wraps, so a BSP adapter would be a thin variant later |
| Unofficial web-client libraries (Baileys, whatsapp-web.js) | Drive a linked consumer WhatsApp session through a reverse-engineered protocol | Rejected: violates WhatsApp's terms, accounts get banned, protocol breaks without notice, needs a QR-linked phone and a persistent browser-like session |

### Account prerequisites (to verify on a real account; none of this is established by code)

- A Meta Business Portfolio and a WhatsApp Business Account (WABA) with a phone number that is not registered on a consumer WhatsApp app.
- A Meta app with the WhatsApp product added; its **app secret** signs webhooks.
- A **permanent access token** for a System User with `whatsapp_business_messaging` (and `whatsapp_business_management` to read the number). Temporary developer tokens expire after 24 hours and are not suitable for an always-on adapter.
- The **phone number ID** of the sending number.
- A publicly reachable **HTTPS** callback URL (Meta refuses plain HTTP) and a **verify token** of the operator's choosing for the subscription handshake; the `messages` webhook field must be subscribed.
- In an unverified developer app, messages can be exchanged only with up to five pre-registered recipient numbers; business verification lifts that. Meta charges per conversation.
- Free-form text may be sent to a user only within 24 hours of that user's last message (the customer service window); outside it only pre-approved template messages are accepted (error code 131047 otherwise).
- The Graph API version is configuration (`WHATSAPP_GRAPH_API_VERSION`, default `v23.0`, a guess to confirm against Meta's changelog; each version is supported for roughly two years).

## Decision

1. **Connection mechanism.** The channel uses the WhatsApp Business Platform Cloud API: inbound through Meta webhooks, outbound through the Graph API `messages` endpoint with a Bearer access token. No unofficial client, no linked consumer session.

2. **Where the code lives.** The adapter is a standalone operator-side service, `deskmates-whatsapp`, in `packages/channels`. It imports only `@deskmates/contracts`, reaches the Gateway solely through the authenticated operator API and its SSE feed with `GATEWAY_OPERATOR_TOKEN`, and never runs inside a workspace. The Gateway carries no WhatsApp-specific code. It gains exactly two channel-agnostic facts, which is how any later channel attaches:
   - **Thread binding.** `POST /api/threads` accepts `channel` (`[a-z][a-z0-9_-]*`, default `web`) and `externalKey`; `(channel, externalKey)` is unique, so creating a thread with a key that already exists returns the existing thread (200, not 201) and `GET /api/threads?channel=&externalKey=` finds it. `Thread.externalKey` is exposed.
   - **Message idempotency.** `POST /api/threads/:id/messages` accepts `externalId`; `(thread, externalId)` is unique, and a repeat returns the stored message with `duplicate: true` and no new run (200, not 201). `ThreadMessage.externalId` is exposed.

3. **Conversation to thread mapping.** One WhatsApp sender (`wa_id`, the E.164 digits) on one business number is one `chat` thread: `channel = "whatsapp"`, `externalKey = "<phone_number_id>:<wa_id>"`. The thread is created on the sender's first accepted message in the adapter's configured workspace (`WHATSAPP_WORKSPACE_ID`) with the configured bots as members (`WHATSAPP_BOT_IDS`), title `WhatsApp <wa_id>`. From there ADR-0005 applies unchanged: interactive lane, `@name` mentions parsed by the Gateway from the text, owner routing for unaddressed messages, the two caps. WhatsApp has no native bot mentions, so the text form is the mapping §3.3 asks for. WhatsApp group chats are not supported by the Cloud API and are not in scope.

4. **Sender identity and admission.** A human message carries `authorId = "whatsapp:<wa_id>"`. The sender's profile name and anything else in the webhook beyond the message text never enters a thread or model context. Admission is deny-by-default: `WHATSAPP_ALLOWED_SENDERS` lists the `wa_id`s that may drive the bots; a message from any other sender, or for a `phone_number_id` other than the configured one, is acknowledged to Meta (200) and dropped with an operational log line. The business number is a public address; this list is what keeps it from being a public entry point into the workspace. The list governs both directions: a sender removed from it receives nothing further from its bound thread (no relays, no notices), the thread's relay cursor still advances past what was not sent, so re-adding the number does not replay it, and the binding stays so the history is not lost.

5. **Inbound verification and deduplication.** The subscription handshake (`GET` with `hub.mode=subscribe`) answers `hub.challenge` only when `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`. Every `POST` must carry `X-Hub-Signature-256` equal to `sha256=` HMAC-SHA256 of the raw body under `WHATSAPP_APP_SECRET`, compared timing-safe; otherwise 401 and nothing is read. Only `text` messages are posted, each with `externalId = <wamid>`, so Meta's retries never create a second message or run. Delivery `statuses` are acknowledged and ignored. A non-text message (image, audio, document, sticker, location, reaction, …) is not posted; the sender gets one fixed notice that only text is supported. When the Gateway cannot be reached, the webhook answers 503 so Meta retries later; the Gateway's idempotency makes the retry safe.

6. **Outbound relay.** Every message appended to a bound thread whose author is not the WhatsApp sender itself (bot replies, system notices such as approval requests, cap and routing notices, and a web operator's own messages) is sent to the sender as text, split into chunks of at most 4096 characters. Sends retry on HTTP 429 and 5xx up to three times with backoff inside one attempt. A failure that may clear later (network error, 429, 5xx after those retries) keeps the message: the per-thread cursor does not move, the number of chunks already delivered is recorded so a long message resumes rather than repeats, and the thread is relayed again after a growing delay (5 s doubling to 60 s) and on every SSE (re)connect. A failure that will not clear (any other 4xx, including 131047 outside the 24-hour window) is logged once with Meta's error code, the rest of that message is dropped, and the cursor moves on. Delivery is therefore at least once: the adapter keeps a per-thread "relayed through seq" cursor plus the delivered-chunk count in `WHATSAPP_STATE_FILE`, refetches `GET /api/threads/:id/messages?afterSeq=` on every pass, and never relays a seq it has recorded. Template messages are out of scope.

7. **Approval semantics.** An approval request reaches the sender as the relayed system message (decision 6) followed by the instruction line `Reply "approve <approval id>" or "deny <approval id> [reason]"`. A sender's text that matches that grammar is a decision, not a message: the verb is one of `approve`, `allow`, `deny`, `reject` (case-insensitive), the id must have the shape the Gateway hands out (the sidecar's UUID for a tool approval, `approval_<hex>` for a continuation), and an optional reason follows. Anything else, including "yes please", "no thanks" or "approve this", is ordinary chat and is posted as such. A matching text it is not posted to the thread, and the adapter calls `POST /api/approvals/:id/decide` with `allow_once` or `deny` and `authorId = "whatsapp:<wa_id>"`, but only when the approval's `threadId` is the sender's own bound thread; otherwise the sender gets a refusal notice and nothing is decided. `allow_always` is not offered from WhatsApp: a stored rule is too consequential to create from a phone keyboard. Continuation approvals (ADR-0016) use the same grammar because the Gateway treats `allow_once`/`deny` as continue/stop. The Gateway already echoes the decision into the thread, which decision 6 relays back.

8. **Credentials and exposure.** The adapter reads its credentials from its own environment (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `GATEWAY_OPERATOR_TOKEN`) and holds them in memory; none is written to the Gateway database, a thread, a run row or a log line. The adapter listens on plain HTTP (`WHATSAPP_BIND`, default `127.0.0.1`, `WHATSAPP_PORT`) behind the operator's TLS reverse proxy, which is what Meta's HTTPS requirement is satisfied with. It is an operator-side component with operator privileges, deployed next to the Gateway and the web UI, never on a workspace network.

## Alternatives

- Put the webhook route and the Graph API client in the Gateway: rejected; the Gateway would gain vendor code, a second inbound credential scheme and an outbound dependency on Meta, and every later channel would repeat that. The two generic facts in decision 2 are all the Gateway needs.
- Keep the thread binding and dedup state in the adapter: rejected for the binding and the dedup key, which must survive adapter restarts and Meta retries and are facts about the transcript; accepted for the relay cursor, which only bounds duplicate outbound sends.
- Post non-text messages as a placeholder human message: rejected; it would wake bots on content they cannot see.
- Offer `allow_always` from WhatsApp: rejected (decision 7).

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | The adapter speaks only the Cloud API shapes: webhook JSON in, `POST <graph>/<version>/<phone_number_id>/messages` with `Authorization: Bearer` out; no other WhatsApp dependency exists in `packages/channels/package.json` | T0 `packages/channels/src/whatsapp/webhook-payload.test.ts`, `outbound.test.ts`; static: the package's dependency list is `@deskmates/contracts` only | none |
| 1 (live) | A text sent from an allowlisted phone reaches a thread, the bot's reply arrives on the phone; an approval round trip completes from the phone | Manual journey on a real WABA, recorded in `docs/design/` with wamids, thread id, run ids and token usage; **not run** at the time of writing (no account) | relayed messages per day (reported) |
| 2 | `packages/channels/src` imports nothing from `@deskmates/*` but `contracts`; the Gateway source contains no `whatsapp` string; `POST /api/threads` with an existing `(channel, externalKey)` returns 200 and the same thread id; `POST .../messages` with a seen `externalId` returns 200, `duplicate: true` and creates no run | static test in `packages/channels/src/whatsapp/package-boundary.test.ts`; T1 `packages/gateway/src/api/thread-channel-routes.test.ts` | none |
| 3 | The first accepted message from `wa_id` creates one chat thread with the configured members and key `<phone_number_id>:<wa_id>`; the second reuses it; `@name` in the text wakes the named member | T1 `packages/channels/src/whatsapp/adapter.test.ts` against the fake Gateway; T1 thread-channel route test asserts mentions are parsed from the posted body | none |
| 4 | A message from an unlisted `wa_id` or another `phone_number_id` answers 200, posts nothing, logs one line; an accepted one posts with `authorId = whatsapp:<wa_id>` and the profile name appears nowhere in the request to the Gateway; after a restart with the sender removed from the list, a new bot message in its thread is not sent, the cursor moves past it, and no notice goes out | T1 adapter test | dropped inbound and dropped outbound by reason (reported) |
| 5 | Wrong verify token gets 403; a body whose signature does not match gets 401 and no Gateway call; a valid body is posted with `externalId = wamid`; the same body twice posts once; statuses post nothing; an image message posts nothing and sends one notice; Gateway down answers 503 | T0 `signature.test.ts`, `server.test.ts`; T1 adapter test | signature failures (reported) |
| 6 | A bot message on a bound thread is sent to the sender; a 5000-character body becomes two sends; 429 then 200 is one delivery; a 4xx other than 429 is logged, dropped and the cursor moves; a run of 503s after the first chunk leaves the cursor and records one delivered chunk, and when sends succeed again only the second chunk and the following message go out; after a reconnect, messages below the cursor are not resent and those above are; a human message authored `whatsapp:` is not echoed | T1 adapter test with the fake Graph API | outbound failures and deferrals by code (reported) |
| 7 | `approve <uuid>` on the sender's own thread decides `allow_once` with `authorId whatsapp:<wa_id>` and posts no message; `deny <uuid> reason` passes the reason; an id from another thread is refused and not decided; `always <id>`, `yes please`, `no thanks`, `approve this` and an id of another shape are plain text and are posted | T0 `commands.test.ts`; T1 adapter test | approvals decided from WhatsApp (reported) |
| 8 | Config loading fails fast without each required variable; no credential value appears in any log line or Gateway request body in the T1 adapter test; default bind is loopback | T0 `config.test.ts`; T1 adapter test asserts on captured requests and logs | none |

## Consequences

- `contracts` gains `channel.ts` (channel name pattern, author id helper, the `whatsapp` channel constant); `Thread` gains `externalKey`, `ThreadMessage` gains `externalId`.
- Gateway migration `0023-thread-channel-bindings.sql`; `thread-routes.ts` accepts and finds bindings and idempotent posts. No other Gateway change.
- `packages/channels` becomes a real package with a `deskmates-whatsapp` binary and no third-party runtime dependency (`node:http`, `node:crypto`, global `fetch`).
- Deployment needs a TLS reverse proxy in front of the adapter and the Meta-side setup listed under prerequisites; `docs/runbooks/stable-release.md` gains a section when the first live journey is recorded.
- Not in scope and unchanged by this ADR: WhatsApp groups, media, templates and the 24-hour window workaround, several business numbers per adapter, Slack and Telegram.

## Amendment 1 (2026-10-11): official channel runtimes load in the Gateway process

Issue #43 showed that shipping two operator-side services without an in-product lifecycle left the
feature unusable. The owner revised the earlier process boundary after comparing systems such as
OpenClaw: deliver the capability first with in-process dynamic loading, while preserving a generic
contract that can move out of process later. This supersedes decision 2's standalone-service
requirement, decision 8's environment-only credential ownership, and ADR-0019 decisions 1, 2 and 7
where they require a separately operated QR service.

P1. **The Gateway loads official channel runtimes through a versioned contract.** `ChannelPlugin`
and its manifest are vendor-neutral contracts. A release discovers its bundled plugin entry points
and uses dynamic `import()` to load them into the Gateway process. Gateway core has no WhatsApp
branch and no static import from a provider package; provider packages import only contracts. A
future process host must be able to expose the same contract without changing product APIs.

The first version knowingly does not isolate a loaded plugin from process crash, OOM or event-loop
blocking. Import, API-version and initialization errors are caught and reported as a degraded
channel; they do not prevent the Gateway from starting its non-channel capabilities.

P2. **Official plugins are release assets.** The release manifest pins each plugin name, version,
entry-point hash and supported `apiVersion`. There is no runtime code download, arbitrary local
path entry or third-party marketplace. An incompatible contract fails closed. Plugin upgrades ship
through the normal semver release, tests and rollback, while the core and provider code remain
separately organized so either can evolve behind the contract.

P3. **The product surface is generic.** Workspace-scoped channel APIs and the Integrations UI read
the plugin manifest's configuration schema, capabilities, connection methods and status vocabulary.
They drive connect, reconnect/re-link, test and disconnect commands without provider-specific route
or component branches. Cloud API webhook delivery enters a generic channel webhook route that
passes the authenticated raw request envelope to the selected plugin.

P4. **One workspace has at most one WhatsApp connection.** It belongs only to that workspace and
has exactly one default Bot. QR linked-device and Cloud API are connection methods of the same
plugin; only one is active, and changing method requires disconnecting the existing connection.
Every accepted first inbound private message creates or resolves the one-member chat for that Bot
and binds the external conversation to it. There are no per-contact routing overrides. Both methods
ignore group chats in the first version: no thread, message or run is created.

P5. **Both connection methods have an in-product lifecycle.** The first release exposes setup,
live status, a test, reconnect/re-link and disconnect for QR and Cloud API without requiring a shell.
Detailed Cloud API product policy for templates, proactive initiation and conversation windows is
deliberately undecided until real use. The existing transport can report provider refusals, but UI
or acceptance criteria must not invent a policy decision.

P6. **Secrets use the generic encrypted store; linked-device state stays file-backed.** Cloud API
access tokens, app secrets and verify tokens are encrypted records referenced by the connection;
plaintext never appears in ordinary database fields, UI responses or logs. QR credentials, Signal
keys and transport state live in the plugin's private operator directory (directory 0700, files
0600). Archive stops the plugin instance but retains that state. Permanent workspace deletion or
explicit disconnect removes it according to the selected action. Pairing Gateway database and
private-directory backups is outside the first version's backup contract.

### Verification for amendment 1

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| P1 | Gateway loads a fake channel plugin dynamically through `ChannelPlugin`; no Gateway source names WhatsApp; missing/bad/incompatible plugins become degraded while ordinary routes still start | T0 contract/loader tests and static package-boundary test; T1 Gateway startup with injected plugin failures | plugin load failures |
| P2 | only release-manifest entries under the configured release plugin root load, with exact version/hash/API checks; no install/download API exists | T0 manifest/hash/path tests; release build test | loaded plugin versions |
| P3 | one generic API/UI flow renders fake manifest schema/status and drives lifecycle/webhook commands without provider branches | T1 generic channel routes with fake plugin; T0 web tests with fake manifests | lifecycle failures by plugin/method |
| P4 | a workspace cannot create a second WhatsApp connection or share one; method switch requires disconnect; every admitted private sender maps to the same configured Bot while groups create nothing | T1 connection/routing tests for both methods, duplicate requests and two workspaces | accepted/dropped conversations by reason |
| P5 | QR and Cloud API complete connect/status/test/reconnect/disconnect against fakes; no test requires an undecided template/proactive policy | T1 lifecycle suite; manual real-phone journeys remain pending | connection state transitions |
| P6 | secret plaintext is absent from database dumps, responses and logs; QR state has 0700/0600, survives restart/archive, and is removed on disconnect/delete | T1 secret-store/log tests; temporary-directory permission/lifecycle tests | relink-required transitions |

## Amendment 2 (2026-10-12): a channel-bound thread is a read-only Web mirror

The owner clarified on 2026-10-11 (issue #43) that WhatsApp is the interaction surface and the
Web is an observer. This amends decision 3's "from there ADR-0005 applies unchanged" and decision
6's relay of "a web operator's own messages" for threads owned by an external chat channel.

M1. **The external conversation has its own thread and session.** A contact's first admitted
private message creates or resolves a one-member thread bound to that conversation for the
connection's default Bot (amendment 1, P4). It is separate from that Bot's canonical Web private
chat and from every other contact's thread, so the Bot keeps a separate SDK session for each.
When the default Bot is a Chief-style Bot it may use the existing `message_bot` bus to wake
allowlisted same-workspace Bots and answer the contact; that neither merges sessions nor changes
direct Bot chats. Workspace observation, task summaries and goals are channel-agnostic product
capabilities tracked separately, not WhatsApp transport responsibilities.

M2. **The Web view is read-only.** A thread whose `channel` is a channel name other than `web` is
a mirror (`isChannelMirrorThread` in contracts; agent-submission channels `agent:*` are not
channel names and stay writable). The thread page shows the history and the channel identity
and says replies are sent from that channel. It renders no composer, no member controls, no
mention dispatch and no approval decision buttons. Pinning and other navigation-only state stay
available because they do not write to the conversation.

M3. **The Gateway enforces it.** `POST /api/threads/:id/messages` refuses a signed-in person and a
service principal posting to a mirror thread with 403 `channel_thread_read_only` before any
message, run or member change exists. Hiding the composer is not the guard. Provider ingress
through the in-process plugin posts through the channel manager, not this route, and is
unaffected; Bot and system messages are unaffected. The shared operator credential remains the
legacy standalone adapters' bridge (`deskmates-whatsapp`, `deskmates-whatsapp-web` post as the
contact through it), so it is not refused; it is an operator-held machine credential, not a Web
human surface. A future change that retires the standalone adapters can close that path too.

M4. **Approvals and administration stay where they were.** A pending approval in a mirror thread
is still decided from the global Approvals surface as an operator capability, or from the phone
under decision 7. The Integrations page owns connection administration: connect or QR scan,
status, test delivery, reconnect or re-link and disconnect. A test message verifies the
connection; it is not conversation from the Web thread.

### Verification for amendment 2

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| M1 | The same Bot's canonical Web private chat is a different thread from a WhatsApp-bound thread and stays writable | T1 `packages/gateway/src/api/thread-channel-mirror.test.ts` (private chat case); live check that the two keep different SDK sessions is part of the pending stable phone journey | none |
| M2 | A WhatsApp-bound thread renders its history and a channel badge but no composer textbox, Send, Add bot or Allow once; a Web thread keeps them; the notice is localized | T1 `packages/web/src/features/chats/chat-pane-channel-mirror.test.tsx`; T0 `packages/contracts/src/channel.test.ts` for the predicate | none |
| M3 | An Admin's and a Member's session post and a service principal's post to a WhatsApp-bound thread get 403 `channel_thread_read_only` and leave message and run counts unchanged; the operator credential still posts (201); an `agent:*` submission thread still accepts a follow-up | T1 `packages/gateway/src/api/thread-channel-mirror.test.ts`; existing in-process plugin tests in `packages/gateway/src/channels/` and `packages/channels` keep passing | refused Web posts to mirror threads (reported) |
| M4 | A pending approval in a mirror thread shows a note pointing to Approvals or the phone instead of buttons; phone-side approval commands still decide | T1 chat-pane mirror test; existing T1 adapter/plugin approval tests; manual stable phone journey **not run** | approvals decided from WhatsApp (reported) |
