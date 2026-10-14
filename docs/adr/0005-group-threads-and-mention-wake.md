# ADR-0005: Threads have members; bots wake each other by mention inside a thread

Date: 2026-09-20
Status: Accepted (product owner, 2026-09-20; decisions 1 to 11 as written, open items deferred to M2)
Source: product request for Grok Bot style group chat, 2026-09-20; builds on ADR-0002 and ADR-0004. Where this ADR had to choose a behaviour that the design does not already fix, it copies Grok Bot's documented behaviour; see Precedent.

## Context

Design v0.3 models a conversation as a thread that belongs to exactly one bot (`threads.bot_id`). Bot-to-bot communication is a separate mechanism, the Bot Bus: `message_bot(to, text, attachments)` writes a `bot_messages` row and starts a background run on the target bot. Multi-bot collaboration is described only in the chief-of-staff shape, a star topology where the dispatch logic lives in the chief's `SOUL.md`.

The product wants a group chat: a human creates a thread with several bots, talks to them in one place, and the bots can address and wake each other inside that same thread, with the whole exchange visible to the human. That needs three things the current design does not have: a thread with more than one bot in it, a transcript that is not any single bot's SDK session, and a rule for who is woken by a message.

Everything else is already in place. ADR-0002 gives per-`(bot, thread)` SDK sessions and `resume`. ADR-0004 puts a group of bots on one machine, so a woken bot sees the same files and login state the previous speaker used. The two-lane scheduler and the ledger already treat every wake as a run. The Bot Bus already has a relay cap.

## Precedent: what Grok Bot does

Taken from xAI's Grok Bot documentation and hands-on write-ups, 2026-09. Items marked *adopted* are copied below; items marked *not adopted* say why.

| Grok Bot behaviour | Source | Here |
|---|---|---|
| A group holds two to six Bots. The name is generated and editable. | [docs: chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) | adopted |
| A human can bring a new Bot into a group mid-conversation with an `@`-mention. | [mem0 guide](https://mem0.ai/blog/grok-bot-guide) | adopted |
| "Write normally to let the Bots decide who responds." Behind the scenes "the group host still wakes each member in turn"; every Bot may consider the message even when only one answers. | [docs](https://docs.x.ai/grok-bot/chat-and-collaboration), [Copes deep dive](https://flaviocopes.com/grok-bot/) | adopted, including its cost |
| `@bot` hands the request to one teammate; mention several only when the request needs each of them. `@everyone` is for group-wide updates, used sparingly. | [docs](https://docs.x.ai/grok-bot/chat-and-collaboration) | adopted |
| Bots post into the group and pass work among themselves; the human sees every handoff in the conversation. | [docs](https://docs.x.ai/grok-bot/chat-and-collaboration) | adopted |
| A Bot can send an asynchronous message directly to another Bot, "which wakes, handles the request, and can reply later; you see the handoff in the conversation." | [Cursor docs: work with Grok Bot](https://cursor.com/docs/grok-bot/work) | adopted |
| Guidance: "Ask for a single owner at each stage; parallel handoffs create duplicate work and noisy updates." For sequential work, message one owner Bot and tell it which specialist to call. | [Cursor docs](https://cursor.com/docs/grok-bot/work), [Copes](https://flaviocopes.com/grok-bot/) | adopted as operator guidance, not mechanism |
| No documented cap on bot-to-bot turns. Early users report Bots that "repeat each other, start unnecessary loops, or spend usage discussing work instead of doing it." | [Copes](https://flaviocopes.com/grok-bot/) | not adopted: this ADR keeps the relay cap the design already has and adds a per-thread budget, because the reports are the failure mode the caps exist for |
| Bot-to-group handoff messages are text-only; images go Bot-to-Bot directly. | [Cursor docs](https://cursor.com/docs/grok-bot/work) | not adopted: thread messages carry attachments; there is no reason to copy a limitation |
| Slack-style reply threads under a message for feedback on one result or one approval; reactions for lightweight acknowledgement. | [Cursor docs](https://cursor.com/docs/grok-bot/work) | not adopted here: separate UI feature, see open items |
| A group can include any of the account's Bots. | [docs](https://docs.x.ai/grok-bot/chat-and-collaboration) | not adopted: here a thread stays inside one workspace, because the workspace is the trust domain (ADR-0004) |

## Decision

1. **A thread is a conversation with members, scoped to one workspace.** `threads` loses `bot_id` and gains `workspace_id`, `kind` and `turn_budget`. `thread_members` lists the bots in it, in join order. A thread with one member is what M0 calls a chat; there is one code path, not two.

   `kind` is `chat` (created by a human through a client) or `bus` (created by a bot through `message_bot`). It decides the scheduling lane, see 7.

   A `chat` thread holds at most six bots (Grok Bot's limit; revisit if a scenario needs more). Its title is generated from the members and editable. A human adds a member mid-conversation by mentioning a bot of the same workspace that is not yet a member; the bot joins with `last_seen_seq = 0`, so its first wake delivers the whole transcript, truncated by the sidecar's context assembly like any long payload. Bots cannot add members; they can only mention members.

2. **The transcript belongs to the Gateway.** `thread_messages` is the truth: every human message, every bot message, in order, with author. Each bot still has its own SDK session per thread (`bot_sessions`), and that session is the bot's private memory of the conversation. The two are reconciled by delivery: when a bot is woken, its trigger payload is the slice of `thread_messages` it has not seen yet, each message labelled with its author. `thread_members.last_seen_seq` records where each bot is.

   This keeps the source of truth in the control plane, consistent with the knowledge base decision in design v0.3 §3.6.

3. **Bots post messages; posting is an action.** A bot in a thread wake has a `thread_post(body, attachments)` tool and may call it any number of times during the run, for progress, questions or handoffs. When the run ends, the `reply` field of its structured summary (design v0.3 §3.2) is posted as a final message; an empty `reply` means the bot chose to stay silent and the run is recorded as `silent` in the ledger. Mentions are structured (`mentions_json`): the Gateway parses `@<bot-name>` from web and bot text against the member list, plus `@everyone`; channel adapters map native mentions. Unknown names and self-mentions are ignored.

4. **Who is woken by a message.**

   | Message | Wakes | How |
   |---|---|---|
   | mentions one or more bots | each mentioned member | in parallel, one run each |
   | `@everyone`, or no mention at all | every member | in turn, in join order: member *n+1* is woken only after member *n*'s run has ended, so it sees whether *n* already answered and may stay silent |
   | mentions nobody in a one-member thread | the member | same as the row above with one member |

   The in-turn walk is per message. A `chat` thread walks one unaddressed message at a time; a second unaddressed message queues behind the current walk. Explicitly mentioned wakes are not held back by a walk in progress. This is Grok Bot's routing, adopted with its known cost: an unaddressed message in a six-bot thread is up to six runs before anyone useful answers. The workaround is the same as Grok Bot's, address one owner bot; see open items for a cheaper triage.

   Every wake is a run with `trigger_kind = thread_message` and `trigger_ref` = the message id.

5. **The Bot Bus is a thread.** `message_bot(to, body, attachments)` stays as the tool a bot calls from any run, including cron and webhook runs that have no human in them. It is implemented as: find or create the `bus` thread whose members are the caller and `to`, append the message with `to` mentioned, wake `to`. The target handles it in its own run and may reply later by posting in the bus thread with the caller mentioned. If the calling run belongs to a `chat` thread, that thread gets a `system` message "handed off to `to`" linking the bus thread, so the human sees the handoff where they are looking, as in Grok Bot. `bot_messages` is removed before it is ever created.

   The per-bot allowlist in the bot definition still governs `message_bot`; inside a `chat` thread, membership is the allowlist, a bot may mention any member. Both are routing configuration. Neither is access control, per ADR-0004.

6. **Two caps stop runaway conversations.**

   | Cap | Scope | Default | On breach |
   |---|---|---|---|
   | `relay_count` | one message chain: a message posted from a run inherits the triggering message's count plus one; human messages are 0 | 5 | message is stored, its mentions wake nobody, alert |
   | `turn_budget` | one thread: bot-authored messages since the last human-authored message | 8 | same, plus the thread is marked `paused` and the human is notified; the next human message resets the count |

   `relay_count` bounds depth (A → B → C → …). `turn_budget` bounds volume, which `relay_count` alone does not, because A and B can each start a fresh chain every turn. Silent runs post nothing and count against neither. `bus` threads have no human to reset them; breaching the budget there is an operator alert. Grok Bot ships without such caps and its users report exactly the loops these prevent.

7. **Lane follows the thread, not the trigger.** Wakes from a `chat` thread go to the bot's interactive lane, because a human is watching. Wakes from a `bus` thread go to the background lane. This replaces the v0.3 §3.4 rule "bot messages go to the background lane". One run per lane per bot is unchanged: a human who mentions two bots gets two parallel runs; a bot mentioned while it is already running is woken again after that run ends.

8. **Wakes coalesce per `(bot, thread)`.** If a wake for bot B in thread T is already queued, a further mention adds nothing; the queued run delivers everything past `last_seen_seq` when it starts. If B is running in T, the mention becomes one new wake after the run finishes, however many mentions arrived meanwhile. The chief pattern therefore needs no waiting primitive: the chief mentions two experts and ends its run; each expert replies mentioning the chief; the chief is woken once with both replies, or twice if the replies straddle its run boundary.

9. **Messages from other bots enter the model as labelled messages, not as instructions.** The sidecar wraps each delivered message with its author and kind. Whether the model treats a bot's request as something to act on is up to the receiving bot's `SOUL.md`. This is a prompt-level distinction, not a boundary: a bot hijacked by page content can still ask another bot to act, and ADR-0004 already accepts that within one workspace. The defences stay where they are: L2 approval on outward side effects, egress allowlist on exfiltration, ledger attribution on who did what.

10. **Every hop is traceable.** `thread_messages.run_id` links a bot message to the run that posted it; `runs.trigger_ref` links a run to the message that woke it. A group exchange replays as: human message → run(A) → message(A, mentions B) → run(B) → message(B, mentions A) → run(A). Attribution, token usage and approvals stay per run and therefore per bot.

11. **Threads do not cross workspaces in this ADR.** All members of a thread are in `threads.workspace_id`. Grok Bot lets a group hold any of the account's Bots; here a cross-workspace thread would be the one channel through which content moves between trust domains without a human reading it first. Deferred, not rejected; see open items.

### Data model

Replaces the `threads` and `bot_messages` lines of design v0.3 §4:

```
threads          id, workspace_id, kind(chat|bus), channel, title, turn_budget,
                 status(active|paused), created_at, updated_at
thread_members   thread_id, bot_id, last_seen_seq, joined_at
thread_messages  id, thread_id, seq, author_kind(human|bot|system), author_id,
                 body, attachments_json, mentions_json, relay_count, run_id, ts
bot_sessions     bot_id, thread_id, sdk_session_id, updated_at
```

`runs.trigger_kind` gains `thread_message`; `runs.status` gains `silent` as a terminal state alongside `succeeded`. `bot_messages` is dropped.

### Sidecar contract

The trigger payload for a `thread_message` wake is `{thread, messages: [{seq, author_kind, author_id, body, attachments}], relay_count}`. The sidecar renders the messages into the first user turn of the session, or of the resumed session, with author labels; exposes `thread_post`; and reports `reply` in the end-of-run summary. Mention parsing, wake routing, the in-turn walk, caps and lane choice are all Gateway concerns; the sidecar never decides who is woken.

## Open items

- **Cheaper triage for unaddressed messages.** The in-turn walk costs one full run per member. Two possible levers, both knobs to be measured per the measurement doc, not assumed: run the "should I answer" decision on `CHEAP_MODEL` before assembling full context; or an optional per-thread owner that is woken alone when nobody is mentioned. Grok Bot has neither and tells users to address one owner instead. Decide after `acceptance/m2-group` shows the real cost.
- **Streaming instead of re-wake.** The SDK accepts an async input stream, so a mention that arrives during a run could be fed into the live session rather than queued for a new run. Evaluate in M2 if re-wake latency is visible in the group chat.
- **Reply threads and reactions.** Grok Bot has Slack-style replies under a message and reactions for acknowledgement. Not in this ADR; if added, `thread_messages` gains `parent_id` and nothing in routing changes.
- **Cross-workspace threads.** Deferred per decision 11. If added later, it needs its own ADR that says what a human sees before a message crosses.
- **Default `turn_budget` of 8** is a guess. Calibrate on `acceptance/m2-group` and the X01 benchmark task.
- **Bot name uniqueness** is assumed per workspace for mention parsing. Confirm in the `bots` table constraints.

## Consequences

- Design v0.3 changes: §3.2 (summary gains `reply`; `thread_post` tool), §3.4 lane table (bot messages take the thread's lane), §3.7 (Bot Bus is a thread; group threads; in-turn wake), §4 (data model above), and the change table gains a row pointing here. These edits are a separate commit from this ADR.
- AGENTS.md rule "Two scheduling lanes per bot" is reworded: interactive lane takes chat-thread wakes and approval replies; background lane takes cron, webhook and bus-thread wakes.
- M0 implements the thread model with one member so there is no migration later. Wake routing, the in-turn walk, caps, coalescing, `thread_post` and the group UI are M2. Channel mapping (a Slack channel is a `chat` thread whose members are the bots in it) is M3.
- `packages/contracts` gains `ThreadMessage`, `Mention` and the `thread_message` trigger payload. `packages/gateway` replaces the Bot Bus module with a thread router. `packages/sidecar` gains the payload renderer and the `thread_post` tool. `packages/web` gains the group thread view with per-bot attribution, per-bot typing state, and the handoff system message.
- Operator docs carry Grok Bot's guidance verbatim in spirit: one owner per stage; address a bot when you know who should act; unaddressed messages cost a run per member.
- Test strategy §11 gains rows: T0 for mention parsing, routing (parallel vs in-turn), both caps, coalescing and lane choice; T1 for a three-bot exchange through the fake SDK with ledger linkage asserted, including a silent member; `acceptance/m2-chief` is rewritten to run inside a group thread and a new `acceptance/m2-group` covers a human mentioning two bots at once and an unaddressed message that only one member answers.
- Multi-bot concurrency inside one workspace, already M2's stated risk, becomes routine rather than occasional: one human message can start two runs that open two tabs in one browser. Open question 8 in design v0.3 (lock granularity) is now on the M2 critical path.
- Cost is bounded by the caps plus the member count. Per human message, a thread runs at most `turn_budget` message-producing bot runs, plus up to one silent run per member for an unaddressed message, plus whatever runs were already in flight when the budget was reached.

## Definitions added on review (2026-09-20)

Decisions 1 to 11 are unchanged. These fix meanings the text left open; each default marked "guess" is calibrated as stated.

- **When `last_seen_seq` advances.** It is set to the highest delivered `seq` when the run reaches `succeeded` or `silent`. On `failed` or `cancelled` it does not move, so the next wake redelivers the same slice (at-least-once delivery). A parked run (`waiting_*`) leaves it untouched until the resumed run finishes.
- **Risk tier of `thread_post` and `message_bot`.** L1. They write only to the Gateway database. Delivery to an external channel (Slack, Telegram) is the channel adapter's side effect; the M3 channel ADR decides whether posting into an externally mapped thread becomes L2.
- **In-turn walk and a busy member.** The walk waits while the member's interactive lane has a run in `queued` or `running`, then wakes it. Parked runs do not occupy a lane, so a member whose run is `waiting_approval` is woken as a new run. The walk never skips a member.
- **What "alert" means on a cap breach.** A `system` message in the thread naming the dropped mention ("relay cap reached: A's mention of B was not delivered") plus a `cap_breached {cap, thread_id, message_id}` ledger event. For `bus` threads the ledger event is the operator alert; there is no human in the thread to read the system message.
- **Payload truncation on join.** The delivered slice is capped at `THREAD_PAYLOAD_MAX_TOKENS` (default 16000, a guess). Older messages are dropped oldest-first and a system line "N earlier messages omitted" is prepended.
- **Calibrating `turn_budget`.** Run benchmark X01 and `acceptance/m2-group` at K = 5, record bot messages between consecutive human messages, and choose the smallest budget under which at least 95% of successful exchanges finish without pausing. Track `budget_pause_rate` in production and recalibrate when it exceeds 5%.
- **Bot name uniqueness.** `UNIQUE (workspace_id, name)` on `bots`.

## Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 1 | `threads.workspace_id` not null; `thread_members` ordered by `joined_at`; a `chat` thread rejects a seventh member; a mention of a same-workspace non-member adds it with `last_seen_seq = 0` and its first payload is the whole transcript subject to truncation; bots cannot add members | T0 membership rules (§4.2); T1 join-by-mention in `acceptance/m2-group`; T0 truncation | `payload_truncation_rate` |
| 2 | `thread_messages` is append-only with dense `seq` per thread; a woken bot receives exactly the rows with `seq > last_seen_seq`; `last_seen_seq` advances as defined | T1 thread cases (§4.2); T1 redelivery after a failed run | none |
| 3 | `thread_post` is L1 and emits a `thread_post` event carrying `thread_id`; empty `reply` ends the run as `silent` with no message row; `mentions_json` is computed by the Gateway from the member list; unknown names and self-mentions produce no entry | T0 mention parser (§4.2); T1 sidecar summary `reply` (§4.3); T0 tier table (§4.3) | `silent_run_cost_share` |
| 4 | mentioned members wake in parallel with one run each; unaddressed messages walk members in join order, one message at a time, with explicit mentions not held back; every wake is a run with `trigger_kind = thread_message`; busy members handled as defined | T0 routing (§4.2); T1 in-turn walk with two `silent` runs (§4.2); `acceptance/m2-group` | runs per unaddressed message (upper bound = member count) |
| 5 | `message_bot` finds or creates the `bus` thread with exactly the two members; target wakes on the background lane; the caller's `chat` thread gets a `system` handoff message; `bot_messages` does not exist | T1 `message_bot` (§4.2); T0 static schema | none |
| 6 | `relay_count` inherits +1 from the triggering message, human messages are 0, a message with count > 5 is stored and wakes nobody; `turn_budget` counts bot messages since the last human message, breach pauses the thread and the next human message resets; silent runs count against neither; breach alert as defined | T0 both caps (§4.2); T1 caps incl. pause and reset (§4.2); fault row "two bots message each other in a loop" (§5) | `budget_pause_rate`; `cap_breach_rate` |
| 7 | wake lane = thread `kind`, not author kind; one run per lane per bot | T0 lane choice (§4.2, §11 row) | none |
| 8 | at most one queued wake per `(bot, thread)`; mentions arriving during a run produce exactly one further wake whose payload holds every unseen message | T1 coalescing, three mentions → one wake (§4.2) | wakes per (bot, thread, human message) |
| 9 | a bot-authored message is rendered with author label and kind, never as a human turn; whether the bot complies is a prompt-level property and is measured, not guaranteed | T1 sidecar payload renderer (§4.3); T3 injection corpus delivered as bot-authored messages | `bot_message_hijack_rate`: share of corpus items where the receiving bot attempts the injected L2 or egress action; reported per model, no pass threshold at M2 |
| 10 | every bot-authored `thread_messages.run_id` is non-null and every `thread_message` run has `trigger_ref`; the chain human → run → message → run is walkable in both directions with zero orphan rows | T1 bidirectional trace (§4.2); production invariant: an SQL check that counts orphan rows and must return 0 | orphan count |
| 11 | creating a thread or mentioning a bot from another workspace is rejected with a typed error | T1 cross-workspace rejection (§11 row) | none |
| data model | migration applies from empty and from the previous schema; `runs.status` accepts `silent` and the state machine has it as terminal | T0 state machine (§4.1); T1 migrations (§4.2) | none |
| sidecar contract | payload shape validated by a `contracts` zod schema; sidecar never computes mentions or wakes | T0 contracts validators (§4.1); T1 "sidecar does not parse mentions" (§4.3) | none |
| cost bound | with adversarial `SOUL.md` files that always mention every other member, runs per human message ≤ `turn_budget` + member count + runs already in flight | T1 adversarial thread with the fake SDK (§4.2) | runs per human message |
| open items | each is a knob to be measured per measurement §5.2, none is assumed | `acceptance/m2-group`, X01 | `silent_run_cost_share`, `budget_pause_rate`, re-wake latency |


### Implementation clarification — final-reply idempotency and routing context (2026-09-23)

Decision 3 publishes a logical final message once: when the same run already persisted
that body in the same thread through a tool, completion references that message instead
of publishing it again. Equality trims only outer whitespace. Distinct progress/final
bodies, different runs and different threads remain separate. The deduplication log,
completion state and cursor update share one transaction; rollback emits no ghost events.
This does not deduplicate repeated tool calls or reinterpret an empty final reply.

Decisions 2 and 9 permit factual recipient labels alongside the delivered slice. The
Gateway supplies the recipient, original wake sequence and per-message addressing from
stored mentions. The sidecar does not parse mentions or decide who wakes. Those labels
confer no authority on bot content; whether to act still follows the receiving SOUL and
human instructions. Version 1 is recorded in run configuration and the additive stdin
fields remain optional for older Gateways.

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 3, idempotent final publication | Same run/thread/body produces one logical message, one routing action and one budget charge; distinct replies survive; failed completion rolls back dedup events | `m2-group-foundation.test.ts`: duplicate, rollback and different body/run/thread cases | duplicate transcript messages and dedup ledger count |
| 2, 9, recipient context | Recipient and each retained message's addressing survive coalescing, truncation and stdin without promoting bot content | `threads/router.test.ts`, `context.test.ts`, `start-run-request.test.ts` | chief/expert case success and missing expert replies in the focused paired T3 probe |


### Operator membership controls (2026-09-24)

The product owner requested explicit add and remove controls in the group chat UI.
These extend decision 1's human-managed membership without changing the existing
human join-by-mention path or the wake rules in decision 4.

- An authenticated operator can add existing bots of the same workspace to a
  `chat` thread through a candidate picker. A batch is atomic and existing members
  are idempotent. The thread retains one to six members. Adding a member alone
  posts no message and creates no run; the next addressed or group message wakes it.
- An operator can remove a member from a `chat` thread while retaining its bot
  definition, historical messages and run records. The last member cannot
  be removed. Removal conflicts while that bot has a nonterminal run in the thread
  (including parked runs), or an unfinished routing walk still targets it.
  Membership controls do not cancel work or edit pairwise `bus` threads.
- A removed bot can be invited again by the picker or a human mention. It rejoins
  at the end of the member order with `last_seen_seq = 0`, like a first invitation.
  Removal clears the active SDK session reference for this bot/thread; rejoining
  starts a new session from the retained Gateway transcript. Workspace files and
  stored session transcript files are not deleted.
  Removal affects routing, not access to the shared workspace, login or files.
- Successful explicit changes emit a `thread_members` event after the transaction
  commits. Clients reload authoritative thread detail and reconcile on reconnect.
  Old bot messages continue to show their authors after a member leaves.

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 1, explicit addition | Operator adds same-workspace bots atomically, cap six, idempotent, no message or wake; human mention invitation still works | Gateway membership route tests; existing router join-by-mention tests; web membership picker tests | Unexpected runs per membership mutation (zero) |
| 1, removal and rejoin | Keep at least one member; preserve history and bot; conflict on nonterminal runs or pending walk target; rejoin from sequence zero | Gateway membership route tests and web conflict/last-member tests | Removed-member wakes from pre-existing work (zero) |
| 1, live membership | Committed changes refresh other clients; late responses cannot replace another thread; historical author labels survive removal | Web membership SSE, history and navigation tests | Stale membership after reconnect |

## Amendment 2 — an unaddressed request gets one owner (2026-09-30)

Status: direction set by the product owner on 2026-09-30 ("a bot should step up as
chief on its own, as in Grok Bot, instead of the human naming one"; goal: "bots
delegate on their own and pass work and information between them"). The routing
strategy below ships as the knob value `owner-v1`; the original decision 4 stays
available as `walk-v1`. Which value is the default was left to the paired
real-model runs recorded in
`docs/design/group-owner-routing-results-2026-09-30.md`. By the rule written
there before the first campaign, the default is `owner-v1`: it answered as often
as the walk (24 of 24 each), in about half the runs and tokens. Implemented on
branch `group-owner`; landing it and releasing it are the owner's.

### What was wrong

Decision 4 copied Grok Bot's routing: an unaddressed message wakes each member in
turn. It did not copy what makes that routing produce an owner there. Four gaps,
all visible in the code on 2026-09-30:

- A woken bot is told "no explicit recipient" and nothing else. It is not told who
  the other members are or what any of them is for; the `role` of a bot never
  reaches the sidecar. A bot cannot hand a request to a teammate it does not know
  exists, so a chief exists only when an operator scripts one into a `SOUL.md` and
  the human writes `@chief`. Every chief case under `acceptance/` does both.
- The walk continues after a member has answered. The remaining members each cost
  a full run whose only useful outcome is to stay silent.
- Every unaddressed message a bot posts, including the final reply to the human,
  starts another walk over all other members. `acceptance/m2-group` calls these
  "derivative observation walks" and asserts that they are silent.
- When every member stays silent, nothing is posted. The human cannot tell a walk
  in progress from a request nobody took.

Grok Bot's own documentation offers no election mechanism. It asks the human to
"describe the shared outcome and who owns the next step", recommends "a single
owner at each stage", and says Bots "pass work, assign ownership, and only pull
you in for judgment calls". How its Bots learn about each other is not published;
that they are told who is in the group is an inference from the product, not a
documented fact.

### Decision

12. **A wake in a group carries the roster.** For a `chat` thread with more than
    one member, the routing context names every member in join order with its `role`,
    and marks the recipient and the current owner. These are Gateway routing
    facts, like the recipient label of the 2026-09-23 clarification: they confer
    no authority, the sidecar does not compute them, and they are recorded as
    routing context version 2 in the run configuration.

13. **The platform states the group norm once, for every bot.** In a `chat` thread
    with a roster, the sidecar's guidance says what a bot may do with a request
    that has no explicit recipient: take it (do it, or coordinate it when it needs
    other roles); hand it to a better-suited member by mentioning that member and
    saying what is wanted back; or end with an empty reply so the next member is
    offered it. Taking a request makes the bot its owner: it answers the human,
    delegates parts by mention with one owner per part, and acts on the delegation
    outcome notices of ADR-0016 amendment 1. The norm is prompt text and is
    measured, not guaranteed, exactly like decision 9.

14. **An unaddressed human message is offered to one member at a time and the
    offer ends with the first taker.** The walk of decision 4 stops as soon as the
    member it woke posts anything into the thread from that run (a `thread_post`,
    a final reply, or a `message_bot` handoff). Members not yet offered are not
    woken; they receive the message with their next wake, as any unseen message.
    A member whose run ends silent, failed, stopped or cancelled has not taken
    it, and the next member is offered. A member that another run had already
    delivered the request to is not woken for it again: it has taken it if that
    run wrote after the request, and passed otherwise. `@everyone` keeps decision
    4: every member is woken in turn, whoever answers.

15. **The taker is the thread's owner.** `threads.owner_bot_id` records it. It is
    also set when a human addresses exactly one bot in a thread that has no
    owner. It changes only when another member takes a later unaddressed human
    message, and is cleared when the owner leaves the thread. The owner is a
    routing fact and an accountability label. It is not access control: any
    member may still post, mention, decide approvals and be addressed.

16. **The owner is offered first.** The walk of an unaddressed human message
    starts with the owner, then the other members in join order. A follow-up to
    work in progress therefore costs one run when the owner takes it.

17. **An unaddressed message from a bot wakes nobody in a `chat` thread.** It is
    part of every member's next delivery. A bot that needs a teammate to act
    mentions it; a bot that needs everyone uses `@everyone`. The delegator still
    learns that delegated work ended through ADR-0016 amendment 1, which does not
    depend on the delegate mentioning it, and which follows work that is handed
    on a second time (ADR-0016, clarifications of 2026-09-30). A `bus` thread has
    two members and no human: there an unaddressed message still wakes the other
    member, and nothing in this amendment applies.

18. **A request nobody took is said so.** When the offer of decision 14 runs out
    of members in a thread with more than one, the Gateway posts one `system`
    message naming the request and how each member ended ("ended without a
    reply" or "failed"). It wakes nobody.

19. **A post says whom it addressed.** `thread_post` answers with the message's
    seq, the members it mentions, and what in it looks like an address and is not
    one: `@names` no member has, and member names written as `@ name` with a
    space. The sidecar words these facts as the tool's result. Nothing about who
    is woken changes; the parser of decision 3 stays strict. This exists because
    of decision 17: a taker whose hand-off mentions nobody has ended the offer
    and woken nobody, and the place to notice is the call that posted it. It
    applies under both routings.

Decisions 12 to 18 are one strategy and one knob, `DESKMATES_GROUP_ROUTING`
(`owner-v1` or `walk-v1`), recorded in `runs.config_json` as `groupRouting`. They
are not separable for an experiment: stopping at the first taker without the
roster would leave a taker unable to hand anything off.

### Alternatives considered

- **A cheap-model bid from every member in parallel, the Gateway picks the
  highest.** Removes the join-order bias and the serial wait. It needs a second,
  tool-less run shape and a scoring rule. Deferred: measure first whether the
  first member offered takes work it should have handed on.
- **A configured coordinator per thread, woken alone.** One run per request and
  no bias, but it is the human naming the chief, which is what the owner asked to
  remove. ADR-0005's original open item listed it; decision 15 gets the same
  routing without the configuration.
- **An explicit `claim` tool.** A bot that answers without calling it would own
  nothing, and the ledger already shows who posted from which run. Rejected for
  the same reason ADR-0016 amendment 1 reused `trigger_ref`.
- **A human mention always moves ownership.** Asking a specialist one question
  would take the task away from its coordinator. Rejected; the coordinator
  passing on the next offer corrects it at the cost of one run.

### Consequences

- An unaddressed human message costs between one run and one run per member,
  instead of always one per member, and an unaddressed bot reply costs none
  instead of one per other member.
- A member that answers "not mine" in words instead of an empty reply has taken
  the request and ends the offer. So has a member whose hand-off mentions nobody:
  on a real model one wrote `@ g_stock`, with a space, and the request stopped
  there, where the full walk would have carried it on. These are the strategy's
  main failure modes; decision 19 and the norm address the second, the
  acceptance case counts both, and a hand-off written into the final reply
  instead of `thread_post` gets no such feedback.
- The first member offered can take work that a later member would have done
  better. With no owner that is the first member in join order.
- A bot that relied on an unaddressed message reaching its teammates now has to
  mention them. `acceptance/m2-group` and the foundation suite are updated where
  they asserted the full walk.
- The cost bound of the original table tightens: per human message, at most
  `turn_budget` message-producing runs, plus one silent run per member for the
  offer, plus runs in flight. Derivative walks no longer add to it.

### Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 12 | a group wake's routing context is version 2 and lists every member with role, `you` and `owner` marks, in join order; a one-member thread, a `bus` thread, `walk-v1` and a run row with no knob get version 1 with no roster; the stdin schema keeps the fields | `gateway/src/m2-group-foundation.test.ts`, `sidecar/src/start-run-request.test.ts`, `sidecar/src/context.test.ts` | share of group runs with a roster (1.0 under `owner-v1`) |
| 13 | the guidance is present in a `chat` group run's system prompt and absent from a one-member or `bus` run; a resumed process gets the same flag; bot content stays wrapped as untrusted | `sidecar/src/context.test.ts`, `gateway/src/scheduler/run-lifecycle.test.ts` | task completion and handoff rate in `acceptance/m3-group-owner` |
| 14 | the walk completes when its active run posts or hands off; later members get no run and see the message on their next wake; silent, failed and cancelled runs advance it; a post from a run that started before the request existed does not answer it; `@everyone` still wakes every member | `threads/group-owner.test.ts` | runs per unaddressed human message (`delegation-metrics`) |
| 15 | `owner_bot_id` is set by the first taker and by a single human mention when unset, replaced only by a later taker, cleared on removal; owner status never blocks another member's post, mention or approval decision | `threads/group-owner.test.ts`, membership route tests | owner changes per thread |
| 16 | the walk's member order is owner first, then join order | `threads/group-owner.test.ts` | runs per follow-up message |
| 17 | an unaddressed bot message in a `chat` thread creates no run and no walk; in a `bus` thread it wakes the other member; the delegator is woken by the outcome notice | `threads/group-owner.test.ts`, `threads/delegation-outcomes.test.ts` | runs triggered by unaddressed bot messages (0 under `owner-v1`) |
| 18 | one `system` message when every offered member ended without taking, none in a one-member thread or an `@everyone` walk; it creates no run | `threads/group-owner.test.ts` | requests nobody took (`delegation-metrics`) |
| 19 | the `thread_post` response carries `routing` with seq, addressed names, `everyone`, unknown `@names` and spaced member names; `parseMentions` is unchanged; the tool result words them and keeps the old text for a Gateway that sends none | `contracts/src/thread.test.ts`, `gateway/src/m2-group-foundation.test.ts`, `sidecar/src/posted-message.test.ts` | hand-offs that woke nobody in `acceptance/m3-group-owner` |
| knob | `groupRouting` is in every run's configuration; `walk-v1` reproduces decision 4's routing and sends routing context version 1. The ADR-0016 notice corrections made with this amendment are not routing and apply under both values | `threads/router.test.ts` (a router with no options), `threads/group-owner.test.ts` ("walk-v1 is decision 4"), `config.test.ts` | none |

## Amendment 3 — a turn-budget pause has a reason, a notice and an operator switch (2026-10-12)

Status: Proposed (needs product-owner sign-off). Decision 6's caps and defaults are unchanged; this amendment says what a pause records, who is told, and how it ends.

### What was wrong

Found in the long-horizon campaign of 2026-10-11, where four peer bots worked for hours with no human in their group thread. A `turn_budget` breach sets the thread `paused`, cancels its queued runs and completes its pending walks. From then on exactly one thing sets it back to `active`: a human message (`ThreadRouter.postHuman`). Bot messages into a paused thread are stored and wake nobody; the scheduler never starts a queued run of a paused thread. In a group with no human, a breach is therefore a stop with no recovery, and the only signal is the breach alert, a `system` message about one dropped mention that nobody is there to read.

The campaign team measured 24 `cap_breached` events across 19 of 113 runs, on every bot, several on short coordination replies, and one run whose follow-up posts were blocked by the pause while the run was recorded `succeeded`. Their proposed ADR (numbered 0026 in their fork, not in this repository) is the source of decisions 20 to 25 below: the pause reason, the budget-reset sequence, the breach notice and the operator pause and unpause. Its decision 2, an automatic unpause by the approval escalation sweep, is not adopted (decision 26). That ADR itself stated that the sweep reaches only threads with a pending approval or continuation request, so the common case, a pause with nothing pending, stayed stalled under it too.

### Decision

20. **A pause records its reason.** `threads.pause_reason` is `turn_budget` or `operator`; the status, the reason and the seq of the message that caused it are written in one update. A thread that is `active` has no reason. Nothing infers the reason from other state.

21. **A breach tells the humans what happened and how to resume.** At a `turn_budget` breach the Gateway posts one `system` message in the thread: the budget was reached, which queued runs were cancelled and whose mentions were dropped, the thread is paused, and a human message or Resume in the UI resumes it. It replaces the per-mention alert of the Definitions for this cap and keeps its `cap_breached` ledger event. It wakes no bot and counts toward neither cap. The pause is also shown where humans look without opening the thread: the thread list and the operator inbox, and the human channels configured for the workspace (as ADR-0002 amendment 3 decision A8 does for approvals). In a `bus` thread the inbox entry joins the existing operator alert.

22. **Every unpause resets the budget origin.** `threads.budget_reset_seq` is added. The budget counts bot-authored messages with `seq` greater than both the last human message and `budget_reset_seq`. A human message moves the origin as before. An operator unpause appends one `system` notice ("resumed by <user>; turn budget reset"), then, in one update, clears the reason, sets the status `active` and sets `budget_reset_seq` to that notice's seq. Without the reset the first bot reply after an unpause would breach again at once.

23. **Operators can pause and resume a thread.** `PATCH /api/threads/:id` accepts `status: "paused"` and `status: "active"`, independent of the deadline field. A pause by an operator records reason `operator`, cancels the thread's queued runs with the error code `operator_pause`, and completes pending walks, like a breach. A live run finishes; a parked run stays parked. Resume follows decision 22 for either reason. Both are ledgered with the user who acted, and refused with a run token.

24. **A human message ends a `turn_budget` pause, not an `operator` pause.** A human message in a thread paused by an operator is stored and wakes nobody, and the composer says the thread was paused by an operator and offers Resume. A turn-budget pause ends on a human message as before.

25. **Resuming never resurrects cancelled work.** Runs cancelled by a breach or an operator pause stay `cancelled`; an unpause only lets new wakes start. The cancelled mentions are named in the notice of decision 21 so a human can repeat what still matters.

26. **There is no automatic unpause, and none is tied to approvals.** No timer, sweep, approval decision, approval reminder or bot message unpauses a thread. The campaign team's design let the approval escalation sweep unpause a turn-budget pause when a reminder was due. It is not adopted: ADR-0002 amendment 3 makes approval notices routing-inert and sends reminders to humans only, so there is no sweep posting into threads; and coupling the cost valve to approval timing would let an unrelated pending approval reopen bot-to-bot spending in a thread that was paused for looping. An automatic unpause, if wanted later, is its own decision with its own budget and measurement.

27. **A pause with nothing pending stops the conversation, not the team.** This is the common case: coordination replies breach, and no approval or continuation request is open.
    - Cron and webhook runs are not thread wakes. They run on schedule; a heartbeat-driven team keeps working.
    - A run that posts into a paused thread is told: the `thread_post` response of decision 19 says the thread is paused, with its reason, and that nobody was woken. A run delivered messages from a paused thread sees the paused state and reason in its routing context.
    - Parked runs in the thread resume on their decision or continuation as today; a pause holds back new wakes only.
    - The humans are told once per pause, by decision 21. The thread resumes when one of them writes or presses Resume.

    The per-thread `turn_budget` of decision 1 remains the knob for groups that expect long bot exchanges; changing its default is a strategy change and is measured.

### Alternatives considered

- **Unpause from the approval escalation sweep, with a budget reset** (the campaign team's decision 2). Rejected for decision 26's reasons; it also leaves the common no-pending case stalled.
- **Time-boxed automatic unpause with backoff.** Reopens the spending the pause exists to stop, with no witness. Rejected; the campaign team rejected it too.
- **Report only, no operator switch.** Shortens the time to notice, but an operator who wants to stop a thread that has not breached has no way to, and an unpause path with no matching pause is one-sided.
- **Let any bot message to the thread unpause it after a delay.** Bot content alone would resume spending. Rejected.

### Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 20 | after a breach the thread row has `status = paused`, `pause_reason = turn_budget` and the breaching seq, written by one statement; an active thread has a null reason | T1 `threads/router.test.ts` breach case; T0 store test that pause and reason are one update | none |
| 21 | a breach appends exactly one `system` notice naming the cancelled runs and dropped mentions and how to resume; it creates no run; bot count and relay count are unchanged by it; the thread list, inbox and a fake channel plugin each receive the pause once | T1 `threads/router.test.ts`; T1 inbox and channel delivery with the harness | `budget_pause_rate`; time from pause to first human action |
| 22 | after an operator unpause the next bot reply does not breach; the thread breaches again only after `turn_budget` more bot messages; a human message after the reset moves the origin past it; a `system` message never counts as bot volume; no state with `active`, null reason and an unstamped reset after an operator unpause is reachable | T1 `threads/router.test.ts`; T0 `messages` count tests | re-breach on the first reply after an unpause (target 0) |
| 23 | `PATCH` with `status: "paused"` and no deadline succeeds, records reason `operator`, cancels queued runs with `operator_pause`, leaves a live and a parked run untouched; `status: "active"` follows decision 22; a run token is refused | T1 `api/thread-routes.test.ts`; T1 `operator-auth.test.ts` row | operator pauses per week |
| 24 | in an operator-paused thread a human message is stored and creates no run; in a turn-budget-paused thread it unpauses and wakes as decision 4 | T1 `threads/router.test.ts` | none |
| 25 | runs cancelled by a breach or an operator pause are still `cancelled` after any unpause, and no run is created for their mentions | T1 `threads/router.test.ts` | resurrected runs (target 0) |
| 26 | no code path other than a human message and the operator route sets a paused thread `active`: an approval decision, an expiry, a reminder, a scheduler pass and any number of bot messages leave it paused | T1 `threads/router.test.ts` and `approvals/expiry.test.ts`; T0 static check that `setStatus(…, "active")` has only those two callers | unpauses not by a human (target 0) |
| 27 | in a paused thread a cron run of a member starts and ends normally; its `thread_post` response says paused, the reason and that nobody was woken; a delivered routing context carries the paused state; a parked run in the thread resumes on its decision | T1 `triggers/cron.test.ts` paused-thread case; T1 `m2-group-foundation.test.ts` post response; T1 sidecar `context.test.ts` | long-horizon campaign: paused thread-hours with no human notice (target 0) |

## Amendment 4 — `@everyone` consults members in parallel, and every request is a durable round (2026-10-13)

Status: Accepted by the product owner on 2026-10-13 (issue #110, comments of 09:05 and 09:13): human and Bot `@everyone` use parallel consultation; sequential discussion is an explicit per-message mode; the current round is highlighted in the UI without becoming an execution lock. The 50-character Activity summaries that read these rounds are ADR-0033.

### What was wrong

Decision 4 walks `@everyone` members one at a time, so a four-member consultation waits on its slowest member three times over, and a failed or parked member holds back everyone after it. There is no record of *which request* a run serves: the chat header shows a bot's latest run, so an old failure from another request can stand as the current state, and wake coalescing (decision 8) silently folds a second question into a queued run with no trace. The owner considered a "one unfinished parallel batch" lock and rejected it after research: a lock held until every member finishes blocks unrelated requests behind a parked approval and deadlocks a parent that waits for a nested consultation, and ADR-0022 amendment 5 removed quantity caps that such a lock would reintroduce.

### Decision

28. **`@everyone` wakes every eligible member at once.** A human or Bot message that mentions `@everyone` gets one wake per member immediately, as explicit mentions already do (decision 4, first row). A Bot's `@everyone` excludes its author. Admission is unchanged: one run per lane per bot, per-`(bot, thread)` sessions, the workspace browser lock, the workspace budget, `relay_count` and `turn_budget` all still apply. Unaddressed messages keep amendment 2 (`owner-v1`, or `walk-v1` by the knob); explicit `@bot` mentions are unchanged.

29. **Sequential discussion is explicit and per message.** A human message may carry `roundMode: "sequential"`. It applies only to that message and only when it mentions `@everyone`; it runs decision 4's in-turn walk in join order, so each member sees the answers before it. The web composer shows a 并行 / 依次 (Parallel / One by one) toggle once `@everyone` is typed, defaults to parallel and resets after each send. It is not a thread or workspace setting. A Bot's `@everyone` is always parallel; `thread_post` has no mode.

30. **Every accepted originating message is a durable round.** In the transaction that stores the message, the Gateway writes a `thread_rounds` row for: a human message in a `chat` thread that wakes anyone (by mention, `@everyone` or an unaddressed offer or walk), and a Bot message that mentions `@everyone`. The round records its thread, message, mode (`parallel`, `sequential` or `offer`), the ordered member snapshot it targets, and its parent round: the round of the run that posted it, if any. Its id is derived from the message id, so a redelivered post (same `externalId`) creates no second round, while a new message with identical text is a new round. Rounds are workspace-scoped and are presentation and attribution records: routing never reads them to decide who wakes.

31. **A round's runs are explicit relations, and coalescing keeps them.** Each wake made for a round member is related to it (`created`). When the member already has a queued wake in the thread, decision 8 still creates no second run; the round records a `coalesced` relation to that queued run, which delivers both messages. One run may therefore answer several rounds; nothing is merged silently. A member's outputs in a round are the bot messages its related runs posted in the thread after the round's message, whether by `thread_post` or as a final reply.

32. **There is no round lock and no quantity cap.** A round never blocks another round, thread or workspace. A parked approval releases its lane as before. A Bot that posts `@everyone` during its run is never its own target, and there is no in-run wait primitive: the parent ends its run and is woken by the replies (decision 8). Child rounds therefore never wait on a resource their parent holds, and nested rounds cannot deadlock.

33. **Member state is derived from the member's latest related run, never copied.** States: `pending` (no run yet, e.g. later in a sequential walk), `queued`, `running`, `awaiting_approval`, `paused` (a turn-exhausted continuation, ADR-0016), `replied` (a related run posted output), `silent`, `failed`, `cancelled`, `stopped`, `seen` (handled in an earlier run before this round reached it), `skipped` (an offer another member took first) and `removed` (no longer a member and no live related run). The round counts `n/m` complete over terminal member states. A run that is not related to the round never changes its state, so a failure from an earlier request cannot become the current status.

34. **Cancel targets one round and its descendants.** `POST /api/threads/:id/rounds/:roundId/cancel` cancels the non-terminal runs related to that round and to every round whose parent chain reaches it, completes their pending walks, and stamps the rounds cancelled. A run that also serves a round outside that set keeps running. A cancelled round takes no new relations, so a later coalesce or walk step cannot revive it, and a restart sees cancelled runs as terminal. Unrelated overlapping rounds are untouched.

35. **Retry is per member and idempotent.** `POST /api/threads/:id/rounds/:roundId/members/:botId/retry` creates one new wake for a member whose latest related run failed or was stopped, related as `retry`, with the round's message as its trigger. It is refused for a cancelled round or a removed member, and returns the existing run when a retry is already live. The failed run and its events stay in history.

36. **The current round is a presentation choice.** The chat shows the latest top-level round (no parent) above the transcript: who asked, when, the message, the mode, `n/m` complete and each member's state with a retry for a failed one. Earlier rounds stay reachable in Activity (ADR-0033). Prominence never admits, blocks or orders work.

### Alternatives considered

- **One unfinished parallel batch per thread or workspace.** Rejected by the owner after research: it blocks unrelated requests behind a parked or slow member and deadlocks nested consultations.
- **A fixed fan-out cap.** ADR-0022 amendment 5 removed quantity caps; per-lane admission, the turn budget and the relay cap already bound volume.
- **Rounds only for `@everyone`.** The status strip and Activity need the same identity for every human request, or the header falls back to "latest run per bot", which is what let old failures show as current.

### Consequences

- A four-member `@everyone` finishes in the time of its slowest member instead of the sum. Its cost is unchanged: one run per member.
- Parallel members do not see each other's answers in that round; a human who wants a relay discussion picks 依次.
- Two tables are added (`thread_rounds`, `thread_round_members`) plus one relation table (`thread_round_runs`); none is read by routing.

### Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 28 | a human `@everyone` in a four-member thread creates four queued runs at once; a Bot `@everyone` creates one per other member, none for its author; a slow, silent, failed or parked member does not delay the others; unaddressed and explicit-mention routing are unchanged | T1 `threads/rounds.test.ts`; existing `threads/group-owner.test.ts` | latency from request to last member start |
| 29 | `roundMode: "sequential"` with `@everyone` walks members in join order; without `@everyone` it changes nothing; the composer toggle appears only with `@everyone`, defaults to parallel and resets after send | T1 `threads/rounds.test.ts`; web `chats/round-mode.test.tsx` | share of `@everyone` rounds sent sequential |
| 30 | one round per accepted originating message with its ordered member snapshot and parent; a redelivered `externalId` adds no round; identical text twice is two rounds | T1 `threads/rounds.test.ts` | rounds per human message (1) |
| 31 | a member with a queued wake gets a `coalesced` relation to it and no second run; both rounds list that run; outputs are attributed by run and seq | T1 `threads/rounds.test.ts` | runs per round member |
| 32 | a Bot's `@everyone` mid-run starts the other members while the author still runs; a nested child round from a member completes while the parent round is open; an approval-parked member does not hold another round | T1 `threads/rounds.test.ts` nested and parked cases | none |
| 33 | member states derive from related runs; an earlier failed run of the same bot never shows in a later round; removal shows `removed` | T1 `threads/rounds.test.ts` | none |
| 34 | cancelling one round cancels its queued and running runs and its child rounds' runs, leaves an overlapping round and a shared run intact, and no later step revives it | T1 `threads/rounds.test.ts`; T1 `api/thread-round-routes.test.ts` | resurrected runs after cancel (0) |
| 35 | retry creates one `retry` relation for a failed member, is idempotent while live, refused for a cancelled round or removed member | T1 `api/thread-round-routes.test.ts` | retries per failed member |
| 36 | the strip shows the latest top-level round with `n/m` and member states; an older failed round never replaces it | web `chats/round-strip.test.tsx` | none |

## Amendment 5 — the message caps are workspace settings, and a loop breaker stands behind them (2026-10-14)

Status: Proposed (issue #61; implements the owner's confirmed direction of 2026-10-13, needs product-owner sign-off). Decision 6's defaults are unchanged. ADR-0016 amendment 2 does the same for the per-attempt turn cap and the continuation limit.

### What was wrong

Decision 6 fixes both caps in code: `relay_count` 5 (`RELAY_COUNT_MAX` in `contracts/thread.ts`) and a per-thread `turn_budget` stored at creation as 8 (`TURN_BUDGET_DEFAULT`), with no operator API to change either. The owner ruled on 2026-10-13 that work must not be cut off prematurely by chat-message or delegation counts; the agent loop judges completion, and the outer control is the money and time policy plus the user's Stop. ADR-0032 now supplies the money backstop (weekly and cumulative USD per workspace, off by default) and explicitly left these caps unchanged (its decision 10). The owner also required that removing a fixed cap must not open the door to runaway bot-to-bot exchanges: one SDK loop cannot see a relay cycle that runs through other bots and other threads, so a breaker has to live in the Gateway, separately from the caps.

The two caps measure different things and stay separate: `turn_budget` counts bot-authored messages in one thread since the latest human message (volume); `relay_count` is the hop depth of one message chain, inherited through `message_bot` and its `bus` thread (depth).

### Decision

37. **Both caps are workspace settings.** A workspace may store `turnBudget` and `relayCountMax`. Each is absent (inherit), an integer in range (`turnBudget` 1 to 100, `relayCountMax` 1 to 50) or `off`. Only an Owner or Admin of the workspace sets them (`PUT /api/workspaces/:id/limits`, role action `limits.set`); any member reads them (`GET`). Every change writes one `workspace.limits_set` audit row with before and after in the same transaction. The same endpoint carries ADR-0016 amendment 2's settings. A new workspace stores nothing, so its behaviour is exactly decision 6.

38. **Precedence, evaluated when a bot message is stored.** Turn budget: the workspace setting, else the thread row's `turn_budget` (8 unless the thread was created with another value). Relay cap: the workspace setting, else `RELAY_COUNT_MAX`. The check runs on the message being stored, so a change applies from the next bot message on; it never unpauses a paused thread or wakes a mention that was already dropped (amendment 3, decision 25). The same effective relay cap governs the `message_bot` delivery check and the outcome-notice cap of ADR-0016 decision 11.

39. **`off` needs the money backstop.** A cap may be set `off` only while the workspace has a weekly or cumulative monetary limit (ADR-0032 decision 1); otherwise the PUT is refused with `validation`. If the last monetary limit is cleared later, the stored `off` is kept but resolves to the default with source `default_no_backstop` until a limit is set again. Nothing here edits a budget.

40. **A loop breaker stands behind the caps and is not a workspace setting.** Three rules, all in the Gateway, all on every message a bot stores in a thread:
    - **Depth ceiling.** A message whose `relay_count` exceeds 50 wakes nobody, whatever the relay setting, `off` included. Because `relay_count` is inherited from the message that woke the posting run, including across `message_bot` into a `bus` thread and through the delivered slice of an outcome notice, this is the cross-thread rule: a cycle A → B → A that hops between threads still deepens one chain.
    - **Volume ceiling.** When a thread holds 100 bot-authored messages since its latest human message, it is paused as a `turn_budget` breach is, whatever the turn-budget setting, `off` included.
    - **Repetition.** When a bot stores a message whose normalized body (trimmed, whitespace collapsed, case folded) equals two earlier messages of the same bot in that thread since its latest human message, the thread is paused as a `turn_budget` breach is. Repetition is armed only in a thread whose effective turn budget or relay cap is relaxed (`off` or above its default), so a workspace on the defaults behaves exactly as before this amendment.

    A trip is recorded as `cap_breached {cap: "loop_breaker", rule, limit}` and announced with the breach notice of decision 6; a pause by the breaker ends like a turn-budget pause, on the next human message. The settings' ranges stop at the ceilings, so a configured cap always fires at or before the breaker. The thresholds are Gateway constants recorded in the breach event; changing them is a strategy change.

41. **Every breach names its limit and where it came from.** `cap_breached` carries `limit` (a number) and `source` (`workspace`, `thread`, `default`, `default_no_backstop` or `loop_breaker`). The breach notice keeps decision 6's wording first and names the limit and its source ("turn budget reached (12 bot messages, workspace setting)", "loop breaker tripped (50 hops)"). `GET /api/workspaces/:id/limits` returns the stored settings, the effective value and source of each limit, the defaults and the ceilings, and whether a monetary backstop is in force; the workspace settings page shows them in a Limits section next to the editor.

42. **No default changes here.** The owner's direction is to stop truncating by message count once the money backstop exists, and `off` is now available per workspace as an operator choice. Changing a default (8, 5) or making `off` the default is proposed, not decided: it is a strategy change and needs a paired run against the current baseline (`evals/compare.ts`, per duration bucket) that looks at useful artifacts completed and spend, not at whether the cap fired.

### Alternatives considered

- **Remove the caps outright now that the budget exists.** Rejected for this step: the budget is off by default, so a workspace without one would have no bound at all, and a default change is a strategy change the owner has not measured.
- **Per-thread settings in the UI.** The thread row already has `turn_budget`; exposing it per thread adds a second operator surface with no reported need. The workspace is the trust and money domain, so the policy lives there.
- **A breaker inside the sidecar.** One SDK loop sees its own turns only; a ping-pong is many short runs of different bots, each of which looks healthy.
- **A workspace-wide rate limit of bot-woken runs.** A rate punishes legitimate parallel work as much as a loop and needs its own calibration; the depth ceiling already crosses threads.

### Verification

| Decision | Concrete meaning | Test | Metric |
| --- | --- | --- | --- |
| 37 | a new workspace has no stored limits and every effective value equals decision 6's; PUT stores, clears and sets `off`; out-of-range, non-integer and unknown keys are 400; a Member is 403; each change writes one `workspace.limits_set` audit row with before and after | T0 `packages/gateway/src/limits/workspace-limits.test.ts`; T1 `packages/gateway/src/api/limit-routes.test.ts` | limit changes per week (audit) |
| 38 | with `turnBudget` 3 a thread pauses on the third bot message although its row says 8; with `relayCountMax` 2 the third hop wakes nobody, and `ThreadRouter.effectiveCaps`, which `message_bot` delivery and the outcome-notice cap read, returns 2; a change does not unpause a paused thread | T1 `packages/gateway/src/threads/loop-breaker.test.ts` | `budget_pause_rate`; `cap_breach_rate` |
| 39 | `off` is refused without a monetary limit and accepted with one; after the limit is cleared the effective value is the default with source `default_no_backstop` and the stored `off` survives | T0 `workspace-limits.test.ts`; T1 `limit-routes.test.ts` | none |
| 40 | with both caps `off`: a 51st hop wakes nobody (`rule: depth`), including across a `message_bot` bus thread; the 100th bot message pauses (`rule: volume`); a third identical body pauses (`rule: repetition`); on the defaults three identical short replies do not trip the breaker and the existing cap tests pass unchanged | T1 `loop-breaker.test.ts`; T1 `threads/router.test.ts`, `m2-group-foundation.test.ts` unchanged | loop-breaker trips per week, by rule |
| 41 | every `cap_breached` event has `limit` and `source`; the notice names counter and limit; GET returns settings, effective values with sources, defaults, ceilings and the backstop flag; the web Limits section renders them and saves | T1 `loop-breaker.test.ts`, `limit-routes.test.ts`; web `features/limits/limits-section.test.tsx` | none |
| 42 | the defaults 8 and 5 are unchanged: the existing cap tests pass without edits | T1 `threads/router.test.ts`, `m2-group-foundation.test.ts` | paired campaign required before any default change |
