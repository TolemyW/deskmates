# ADR-0024: Route private-chat handoffs and notify the recipient's own chat

Date: 2026-10-09
Status: Accepted (product owner, 2026-10-09; implementation requested in issue #11)
Scope: private-chat handoff routing and recipient reminders; acceptance and deployment require separate evidence

## Context

The operator reported a one-member chat where `databricks_fan` ended its reply
with `@team_chief` and a request to review its conclusion. The recipient did
not respond. Repository inspection explains this behavior: `ThreadRouter`
parses bot replies against current thread members, so the non-member address
produces no structured mention and no recipient run. The web Markdown renderer
highlights any syntactic `@name`, including this undelivered address.

ADR-0005 decision 1 explicitly prohibits bots from adding members; decision 3
ignores unknown names. Its amendment 2, decision 19 provides diagnostics to
`thread_post`, but a final reply has no subsequent tool result in which to
correct the handoff. This is a product gap rather than a failing existing
membership invariant. The deployed ledger has not been inspected.

The existing explicit `message_bot` path already provides a same-workspace,
pairwise bus conversation, a handoff link in the originating chat and a
terminal outcome notice under ADR-0016 amendment 1. This decision reuses that path.

On 2026-10-09 the operator proposed that each bot have its own private chat
window, and that a call to bot A from another bot's private chat appear as a
reminder in A's own chat. This decision adopts that product direction: the source chat shows the handoff, the recipient's private chat
shows an incoming-work notice, and the pairwise bus remains the execution
conversation. This is not a claim about Grok Bot's internal implementation.
The owner accepted the rules below and requested implementation in [issue #11](https://github.com/TolemyW/deskmates/issues/11).

## Decision

1. **A non-member address in a one-member web chat can request a separate
   handoff.** For bot-authored `thread_post` messages and final replies in such
   a chat, resolve strict `@name` tokens against that workspace's bots. Current
   members retain ordinary mention routing; `@everyone` retains its existing
   member-only meaning. Unknown names and self-mentions do not create work.
   Human join-by-mention, group chats, bus threads and externally mapped chats
   retain their existing routing. This extends ADR-0005 decision 3 without
   permitting bots to add chat members.

2. **Use the existing direct-message rules.** A recognized non-member is
   eligible only when configured in the author's `messageAllowlist`. Hand off
   the posted body and attachments to the pairwise bus thread, on the background
   lane, with the originating run and message recorded. Membership of the
   original chat stays unchanged. An ineligible or unrecognized address gets
   a visible, non-waking diagnostic in the originating chat; it is never
   silently presented as delivered. Diagnostics do not reveal other workspaces.

3. **Delivery is durable and bounded.** Process each source-message/recipient
   pair at most once, including after restart. Commit the source message,
   handoff attribution and resulting routing changes atomically, then publish
   notifications. Preserve relay depth, source-chat pause and turn-budget
   limits, destination-bus pause and turn-budget limits, and wake coalescing.
   A suppressed handoff reports why it did not wake the recipient. A repeated
   mention in one message creates one handoff; a separately posted message is
   a separate request. No historical messages are replayed on upgrade.

4. **The result reaches the original chat.** Reuse ADR-0016's delegation
   tracking and bounded, untrusted-wrapped outcome notice. Attribute both the
   bus message and recipient run to the source handoff. Terminal success,
   silence, failure and stop remain distinguishable. Repeated processing of
   the same terminal event must not duplicate the outcome or its wake.

5. **The UI distinguishes an address from a delivery.** A syntactic highlight
   alone is not a success signal. Show the handoff link or the non-delivery
   diagnostic beside the exchange, driven by Gateway facts. The tool response
   reports the same facts for `thread_post`; final replies receive the visible
   diagnostic without requiring another model turn merely to discover it.

6. **Each bot has one stable private-chat entry point.** The Gateway resolves
   a canonical one-member web chat for a bot within its workspace. Contacts,
   the chat list and incoming-work notices use that same destination. Resolve
   or create it atomically so simultaneous handoffs and opening Contacts cannot
   create duplicate private inboxes. For existing data, adopt the most recently
   updated eligible one-member web chat once (with a deterministic ID tie-break)
   and persist the choice; preserve other conversations and their history. Do
   not choose a new destination whenever another old chat receives activity.
   If the human explicitly turns the canonical chat into a group, preserve
   that group and atomically clear the binding; the next private-chat lookup
   creates a fresh one-member chat. A bot's private chat means a one-bot
   conversation under existing workspace visibility, not a new per-human or
   per-bot access boundary.

7. **Incoming work is visible in the recipient's private chat without a
   second execution.** After a successful cross-chat handoff, show one durable
   incoming-work card in the recipient's canonical private chat. Apply this
   to both the new mention handoffs and explicit `message_bot` calls originating
   in another one-member web chat. Name the calling bot, show a bounded request
   excerpt, and link the exact source message, handoff conversation and related
   run when available. Distinguish queued, running, waiting, completed, failed,
   stopped and cancelled using persisted routing/run facts; a run completing
   does not imply human acceptance of the work. Coalesced handoffs follow the
   run actually delivering their message. Suppressed delivery stays a source
   diagnostic, not an incoming task falsely marked as running.

   This card is an operator-facing activity record displayed with the chat,
   not a second copy of the request in `thread_messages` or the model payload.
   It does not wake the recipient, consume a conversation turn, add a member,
   or change the execution lane. The bus run handles the work once; decision
   4 still reports the outcome in the originating chat. Update the same card
   as work progresses, with one durable identity per handoff and recipient;
   retries and reconnects cannot duplicate it. Show a new-activity indicator
   in the recipient's chat-list entry, without switching the operator's open
   chat or showing a blocking modal. Offline activity is reconstructed on
   reconnect. Read state belongs to the signed-in operator and does not mark
   another operator's notifications read.

### Example operator experience

In the `databricks_fan` private chat:

> Handed off to team_chief: review whether the conclusion needs updating.
> Open handoff

In the `team_chief` private chat:

> databricks_fan requested your help from its private chat.
> Review whether the conclusion needs updating. Status: queued.
> View original message · Open handoff

The incoming card changes status as the actual work progresses. The outcome
appears in the originating `databricks_fan` chat under decision 4; the reminder
does not create a second task in `team_chief`'s private-chat session.

## Alternatives considered

- Add the recipient to the current chat automatically. This keeps the whole
  exchange in one transcript but changes the one-member chat into a group,
  delivers its previous transcript to the new member and supersedes the
  explicit prohibition in ADR-0005 decision 1. Not selected in this revision;
  the operator's proposed recipient-side reminder provides visibility while
  preserving the original private chat.
- Keep member-only routing and add a visible warning. This exposes the failure
  but still requires the operator or bot to initiate another handoff.
- Rely only on prompt guidance to call `message_bot`. Useful guidance does not
  give final replies a deterministic delivery result.
- Deliver and execute the request again in the recipient's private chat.
  Rejected: the reminder would start a second run with a separate session for
  work already assigned in the bus conversation.

## Verification

The deterministic routing change is recorded as `privateHandoffVersion: 1` in
run configuration. No model-quality improvement is claimed. Test paths below
are relative to `packages/`; the browser fixture and evidence are linked below.

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | Private bot replies can hand off to same-workspace non-members; ordinary membership routing remains intact | `gateway/src/threads/private-handoffs.test.ts`, `gateway/src/api/direct-message-routes.test.ts`, existing `router.test.ts` | Eligible addresses with recorded outcome / eligible addresses |
| 2 | Allowlist and workspace resolution remain enforced; failures are visible and membership stays unchanged | `gateway/src/threads/private-handoffs.test.ts`, `gateway/src/api/direct-message-routes.test.ts` | Silent non-delivery = 0; unintended membership changes = 0 |
| 3 | Source/recipient deduplication, atomic rollback, HTTP request replay, source/bus caps and coalescing are preserved | `gateway/src/threads/private-handoffs.test.ts`, `gateway/src/api/direct-message-routes.test.ts` | Duplicate handoffs = 0; cap-bypassing wakes = 0 |
| 4 | Recipient outcomes reach the source chat, retaining attribution and untrusted wrapping | `gateway/src/api/direct-message-routes.test.ts`, existing `gateway/src/threads/delegation-outcomes.test.ts` | Duplicate terminal notices/wakes = 0 |
| 5 | Handoff facts and diagnostics distinguish delivery from a highlighted address | `sidecar/src/posted-message.test.ts`, `gateway/src/threads/private-handoffs.test.ts`, browser fixture | False delivery claims = 0 |
| 6 | The canonical private chat is adopted once and persisted; group promotion clears the binding while preserving history | `gateway/src/threads/private-handoffs.test.ts`, `gateway/src/api/thread-list-routes.test.ts`, `web/src/features/contacts/contacts.test.tsx`, `web/src/features/chats/thread-rail-inboxes.test.tsx` | Duplicate canonical inboxes = 0; group destinations = 0 |
| 7 | One activity card follows actual run state, supports reconnect and operator-scoped unread state, and creates no run/model message | `gateway/src/api/direct-message-routes.test.ts`, `gateway/src/threads/private-handoffs.test.ts`, `web/src/features/chats/incoming-handoffs.test.tsx`, browser fixture | Reminders per handoff = 1; reminder-created runs = 0 |

HTTP request replay is keyed by the sidecar's `requestId`, scoped to its run;
reuse with different content is rejected. Older sidecars may omit the key and
retain their previous transport behavior. A separately submitted request with
a new key is a new message. Source-message/recipient deduplication applies in
both cases. This does not replay old messages on upgrade.

## Current evidence

Implementation and local verification are recorded in
[the 2026-10-09 receipt](../design/private-chat-handoffs-results-2026-10-09.md).
The real Gateway/UI browser fixture is
[`spikes/private-chat-handoffs/server.ts`](../../spikes/private-chat-handoffs/server.ts).
T0/T1 and browser checks use fake execution and do not establish real-model,
container, production deployment or historical-incident acceptance.

## Amendment 1 (2026-10-11): one private entry, immediate welcome and shared pins

Status: accepted by the product owner in GitHub issues #47 and #48. Implementation and release
evidence remain separate.

### Context

Decision 6 introduced a canonical private chat but left two product seams. The **New chat** form
could still create another one-member thread, which the rail exposed under **Other chats**. A new
Bot also had no thread until somebody opened it. Separately, frequently used conversations could
not be held at the top of the rail. Issue #48 first proposed per-person pins; the owner replaced
that proposal with workspace-shared pins and ordering on 2026-10-11.

### Decision

8. **New creates groups, not private chats.** The Chats **New** action offers a group of two to
   six existing Bots, or links to the New Bot flow. It never creates a one-member thread. A Bot's
   ordinary one-member destination is resolved through decision 6; a Member's personal posting
   path remains the side chat of ADR-0022 amendment 1. Older extra one-member chats are retained
   with their transcript and shown as earlier conversations under that Bot. There is no
   catch-all **Other chats** section and no migration that deletes, merges or re-members history.

9. **Creating a Bot creates its private chat and queues a welcome run atomically.** The Bot row,
   canonical one-member web thread, binding and queued run are committed together. The HTTP
   create returns before model work starts. The run uses the interactive lane and a distinct
   `welcome` trigger, receives the Bot's name, role and canonical instruction files through the
   normal sidecar context, and publishes its final reply into the private chat. It has the same
   run configuration snapshot, ledger, usage, pricing, status stream and failure semantics as
   other model runs. A failed, cancelled, stopped or silent welcome may be retried explicitly;
   the Bot and chat are never rolled back. Existing Bots gain a canonical chat on Gateway start
   but do not receive a retroactive welcome.

10. **Pins are presentation shared by the workspace.** A pin references an existing `chat`
    thread in that workspace. Pin and unpin are Member actions and are visible to every workspace
    member. The order is the durable order in which currently pinned threads were pinned; there
    is no hard limit. Pins do not change membership, routing, owner, lane, permissions, messages
    or Bot behavior. Private chats and groups may be pinned from a rail row or chat header.
    Search still filters pinned rows. The pinned section folds and scrolls when long. Bus threads
    and retained earlier one-member histories are not first-version pin targets.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 8 | New accepts only two-to-six-Bot groups or opens New Bot; canonical and Member side-chat entry points remain; every extra one-member transcript stays reachable below its Bot and Other chats is absent | T0 web `thread-rail-inboxes.test.tsx`, `thread.test.tsx`; existing Gateway private/side-chat route tests | New one-member threads = 0; unreachable retained one-member chats = 0 |
| 9 | API Bot creation commits Bot, canonical thread, binding and queued welcome together, returns before execution, publishes run status, and retry creates one new normal run only after an unsuccessful terminal welcome | T1 Gateway `bot-welcome-routes.test.ts`; T0 sidecar `context.test.ts`; T0 web `chat-pane.test.tsx` | Bots without canonical chats = 0; welcome runs missing config/usage attribution = 0 |
| 10 | Pin rows are workspace-scoped and ordered without a cap; every Member sees and changes the same state; foreign/bus threads are refused; row/header controls are keyboard accessible; search and long-section scrolling remain | T1 Gateway `thread-pin-routes.test.ts`; T0 web `thread-rail-pins.test.tsx`, `chat-pane.test.tsx`; desktop/mobile light/dark visual fixture | Pin-caused routing/run changes = 0; cross-workspace pins = 0 |

### Consequences

- `RunTriggerKind` and the forward-only `runs.trigger_kind` constraint gain `welcome`; it is not a
  human message and therefore does not fabricate transcript input or a human actor.
- The workspace owns pin order. This intentionally differs from per-person read watermarks in
  decision 7: a pin is team navigation, while unread state remains operator-specific.
- Thread creation through the API remains available for channel adapters and Member side chats;
  decision 8 constrains the Chats New flow, not those established contracts.

## Amendment 2 (2026-10-14): welcome delivery and other one-member conversations

Status: proposed (issue #122, batch 2026-10-14). Decisions 11 and 12 correct presentation and
the retry guard of decisions 8 and 9; they change no run status, prompt or ledger row.

### Context

Decision 9 made a failed, cancelled, stopped or silent welcome retryable. `silent` means an empty
final reply (ADR-0005 decision 3), but a welcome may greet through `thread_post` and then end with
an empty reply. On v0.6.4 such Bots showed their greeting together with "could not send its
welcome message" and **Retry welcome**, inviting a duplicate greeting and extra model work.
Decision 8 also called every extra one-member chat an *earlier* conversation, so a task chat
created today was listed under **Earlier conversations** below an older canonical chat.

### Decision

11. **A welcome is delivered when its greeting is in the canonical chat.** A welcome run counts
    as delivered when its private chat holds a bot-authored message by that Bot carrying the
    run's id (`thread_messages.run_id`), whatever its final status; a `succeeded` welcome is
    delivered by its final reply. Generic run visibility (`visibleOutcome`, or a `message_bot`
    post elsewhere) does not count. One predicate, `welcomeDelivery` in contracts, decides it
    for the Gateway retry route and the Chats composer. A delivered welcome shows no failure
    banner, and `POST /api/bots/:id/welcome` refuses it as `invalid_transition`. A welcome that
    ended `failed`, `cancelled` or `stopped` after posting is reported as such ("partial") and is
    not retried either. Only a terminal welcome with no delivered greeting (`silent` with nothing
    posted, or a failure before any post) stays retryable. Stored statuses and metrics are
    unchanged.
12. **Additional one-member chats are "other conversations", not "earlier".** The rail nests a
    Bot's additional one-member chats (retained histories and task chats) under that Bot as
    **Other conversations**, in the list's recency order. The label states no chronology. They
    remain readable, and opening one starts no run. There is still no catch-all section outside
    a Bot.

### Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 11 | `welcomeDelivery` is `delivered` for a succeeded welcome or any welcome with an attributable bot message in its own thread, `partial` for a failed/cancelled/stopped welcome with one, `undelivered` only without one; the retry route refuses delivered and partial welcomes and accepts exactly one of two concurrent retries; the composer agrees on load, after either SSE arrival order and after reload | T0 contracts `welcome.test.ts`; T1 Gateway `chat-lifecycle-routes.test.ts`; T0 web `chat-pane-welcome.test.tsx` | Duplicate welcome runs after a delivered greeting = 0; false "could not send" banners = 0 |
| 12 | Extra one-member chats are listed under their Bot as Other conversations in every locale; opening one creates no run | T0 web `thread-rail-inboxes.test.tsx` | Unreachable one-member chats = 0 |
