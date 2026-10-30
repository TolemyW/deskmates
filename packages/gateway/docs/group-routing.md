# Group routing and direct handoffs (M2 foundation)

Explicit mentions wake their recipients in parallel, and so does `@everyone`
(ADR-0005 amendment 4; a bot's `@everyone` skips its author). A human message
with `roundMode: "sequential"` and `@everyone` walks members in join order
instead, for that message only. Unaddressed messages walk members in join order
(under `walk-v1`); the next member sees earlier replies and can stay silent.

**Literal mentions (ADR-0056).** Backtick code spans, fenced code, Markdown quote
lines and escaped at-signs (`\@name`) are text, not addresses; they also produce
no unknown-name diagnostics, private handoffs or human mention invitations.
A bot broadcasts with `@everyone` in its leading address list, for example
`@everyone review these findings` or `@alice, @everyone review these findings`.
A later occurrence in a report does not broadcast. Human broadcast placement
and ordinary individual handoffs outside literal regions keep their behavior.

**Request rounds (amendment 4).** Every human message that wakes anyone in a
chat thread, and every bot `@everyone`, is a durable round
(`thread_rounds`, keyed by the message id) with its member snapshot and the
runs related to each member (`created`, `coalesced` into a queued wake, or
`retry`). A bot's round records the round of its posting run as its parent.
Member states are derived from the latest related run. Routing never reads
rounds, and no round blocks another. `GET /api/threads/:id/rounds` lists them
newest first; `POST /api/threads/:id/rounds/:messageId/cancel` cancels that
round and its descendants (a run shared with another open round keeps
running); `POST /api/threads/:id/rounds/:messageId/members/:botId/retry`
re-wakes a failed or stopped member once. `GET /api/runs` adds
`roundMessageIds` and the current `activitySummary` (ADR-0033) to each run. Migration `0009` stores the walk and its member snapshot so a
Gateway restart can continue it. Bot authors are excluded from their own
unaddressed walks. A member that already received a queued message successfully
needs no duplicate wake. Explicit wakes coalesce per bot/thread. A group unaddressed message waits as a
durable walk; a single-member chat also reserves its next queued run immediately
to preserve the existing operator API. Parked approvals
retain ownership of that bot/thread session.

**An unaddressed request gets one owner (ADR-0005 amendment 2).** The paragraph
above is `walk-v1`. `DESKMATES_GROUP_ROUTING` selects the routing and every run
records it as `groupRouting`; `owner-v1` is the default. Under `owner-v1`, in a
thread with more than one member:

- An unaddressed human message is an offer (`thread_routing_walks.mode =
  'first_taker'`). It goes to one member at a time, the thread's owner first,
  then join order, and ends when the member it woke posts anything from that
  run: a `thread_post`, a final reply or a `message_bot` handoff. Members not
  yet offered are not woken; they read the message with their next wake. A
  member that ends silent, failed or cancelled has not taken it.
- The taker becomes `threads.owner_bot_id`, with a `log` event
  `{source: "group_owner", threadId, messageId, ownerBotId, changed}` on its
  run and a `thread_members` SSE frame. A human who addresses exactly one bot
  in a thread with no owner also names it. Removing the owner clears it. The
  owner is a routing fact: no route, tool or approval checks it.
- An unaddressed bot message in a `chat` thread wakes nobody. `@everyone`, from
  a human or a bot, still walks every member, and a `bus` thread still wakes
  its other member. A delegator does not depend on being mentioned: the
  delegation outcome notice below wakes it.
- An offer every member passed on ends with one `system` message, "No member
  replied to message #N: …", naming how each member ended. It wakes nobody.
- Each wake carries routing context version 2: the members in join order with
  their `role`, which one is the recipient, which one is the owner, and for an
  offer who was asked before and who is next (`src/threads/delivery.ts`,
  `RunLifecycle.deliveryGroup`). A run in a `chat` group also gets
  `groupGuidance: "owner-v1"`, which makes the sidecar state the group norm;
  the flag is stored in the run's configuration so a resumed process gets the
  same prompt.

`POST /internal/runs/:runId/messages` answers a `thread_post` with `routing`:
the message's seq, the members it mentions, whether it is `@everyone`, the
`@names` no member has, and member names written as `@ name` with a space
(`mentionDiagnostics` in `contracts`). The sidecar words it as the tool's
result under both routings; who is woken is unchanged.

`GET /api/threads/:id` and the two membership routes return `groupRouting`
next to the thread so the composer can say what an unaddressed message will
do. One-member chats behave the same under both values.
`npm run delegation-metrics` reports what unaddressed requests cost: runs
offered, the silent share, requests nobody took and time to first reply.

**Triaged rounds (ADR-0005 amendment 6, proposed).** `DESKMATES_GROUP_ROUTING=round-v1`
keeps everything `owner-v1` does and changes how a human request to the group is
routed; `owner-v1` stays the default, and no paired evaluation of `round-v1` has
been run yet (`npm run group-rounds`, below). In a `chat` thread with more than one
member:

- A human message that mentions no bot, or mentions `@everyone`, opens its round
  (mode `offer` or `parallel`, every member in the snapshot) and a plan
  (`thread_round_plans`, phase `triage`), and queues a `round_triage` model job of
  the owner, or of the first member (`src/model-jobs/round-triage.ts`). The job
  starts even while that bot's lane is busy. `roundMode` is not used. An explicit
  `@bot` still wakes the bot directly, and a bot's `@everyone` keeps amendment 4.
- When the job succeeds, its validated answer (`thread_round_assignments`) wakes
  the assigned members at once, each run related to the round; unassigned members
  show `skipped`; the closer becomes the owner. When it fails, returns no valid
  plan, or there is no job, the plan records `fallback` with the reason and the
  message is routed as `owner-v1` routes it (offer owner first, or every member
  for `@everyone`). A cancelled job wakes nobody; a round cancel takes the job and
  the closer wake with it.
- When the latest related run of every assignee is terminal, the closer is woken
  once (or its queued wake is reused) with `{source: "round_close"}` on that run;
  not when it was the only assignee, or the thread is paused or past its deadline.
- Worker and closer wakes carry `routing.round` (the plan, and for the closer how
  each part ended); the sidecar renders it in the first user turn, so the system
  prompt equals an `owner-v1` group run's (`src/threads/round-delivery.ts`).
- The turn budget counts the bot messages of one triaged round as one
  (`RoundPlanStore.botCountByRound`); relay depth and the loop breaker count every
  message. `@ name` with a space is a mention of that member, so the `thread_post`
  answer's `spaced` list is empty. A final reply with an `@name` no member has is
  recorded on its run (`finalReplyRouting`, `{source: "final_reply_routing"}`) and
  delivered as `routing.lastReply` to the bot's next wake in the thread.
- `GET /api/threads/:id/rounds` adds `plan` (phase, assignments, closer, closer run
  and status, synthesis message ids, reason) to a triaged round.

A human mentioning a same-workspace non-member joins it with `last_seen_seq = 0`,
subject to the six-member chat limit. Bots cannot add members. These checks route
messages; they do not isolate bots from their shared workspace.

Bot messages inherit the maximum relay count in the actually delivered batch
plus one, excluding their own messages and history before the latest delivered
human message. Coalescing therefore cannot lower a chain's depth. Counts above
five are stored but do not wake recipients. Reaching the thread's bot-message
budget cancels unstarted thread wakes, completes old pending walks, pauses further
routing, and records a system alert plus a `cap_breached` ledger event. Already
running work may finish. A new human message resets the budget without reviving
the cancelled chain. Silent runs create no bot
message and consume no turn budget.

`message_bot` is offered for thread, cron and webhook runs. It resolves an exact
bot name (case-insensitive), checks the caller's routing allowlist, reuses a bus
with exactly the caller and target, and records the handoff against the caller's
run. The chat handoff is informational and wakes nobody. A queued target run is
still subject to caps and lane scheduling; a recorded message is not a promise
that its recipient has executed.

**Delegation outcome notices (ADR-0016 amendment 1).** A run woken by a message
that mentions its bot, from a bot upstream of it in the wake chain, is a
delegation (`src/threads/delegation-outcomes.ts`); a walk of an unaddressed
message is not. When it ends `succeeded`, `silent`,
`failed` or `stopped`, the Gateway posts one `system` message in the thread the
delegation was made from and wakes only the delegator: the delegate's name, the
outcome, and the reply's seq, the bounded error or the handoff path. A
`message_bot` handoff made from a chat thread is announced in that chat thread
as well, with the reply quoted inside the bot wrapper (`wrapUntrusted`, now in
`contracts`), because that session cannot see the bus thread. A report back up
the chain ("done @chief") is not a delegation, so the delegator's read of it is
not announced back. A paused thread, or a chain already at the relay cap, gets
the message without a wake. Each notice is a `log` event
`{source: "delegation_outcome", outcome, delegatorBotId, messageIds}` on the
delegate run; `npm run delegation-metrics -- --db <file>` computes missed
replies and stuck delegators from those rows. `turns_exhausted` keeps its
continuation request as its notice, and `cancelled` has none.

A `silent` run that posted through `thread_post` is announced as having replied.
A run's delegations are every message in the slice it was delivered
(`deliveredFromSeq` to `deliveredSeq`, both on the run row) that delegates to
its bot, so a mention that coalesced into a run the bot already had queued is
still a delegation of that run.
When the work's last word mentions the delegator, the delegate has already woken
it, and the notice in the delegation's thread is appended without a wake; the
notice in a `message_bot` handoff's chat thread always wakes.
A delegate whose last message mentions a bot other than its delegator has handed
the work on: that message is not its answer. A run woken by the notice of a
delegation it made, or by that teammate's own report, is still working on the
delegation it was given (`workOf`; a notice names its run in
`thread_messages.run_id`), so its end is what the first delegator is told. The
outcome is read from the last thing the delegate said on the work in any of its
runs. While a teammate it asked, or another of its own runs on the same work,
has not finished, a run that ends without an answer is not announced, and a
later run that adds nothing to an outcome already announced is not announced
again; the ledger gets `{source: "delegation_outcome_deferred", reason}`.

Message writes, final replies, and direct handoffs buffer live events until the
outer database transaction commits. Transcript rows precede the corresponding
wake/status notifications; a rolled-back operation publishes nothing.
