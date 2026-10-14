# Product interaction review: bots, conversations, memory and task execution

Date: 2026-09-30
Status: assessment and proposals; not an accepted ADR or implementation plan
Reviewed source: `1b15bc7` on main. The existing uncommitted memory research document was not edited.

## Evidence and limits

This review follows the actual Web components, their API clients, Gateway routes,
contracts and context assembly. It is a source-level interaction review, not a
claim of a live browser walkthrough. Testbox could not be reached over SSH during
the preceding progress review. The documented deployed release is v0.2.17; main
also contains later proposals and release-gate changes.

The preceding review ran backend and Web typechecks, lint, T0/T1 (201 files,
2,154 tests) and the separate Web suite (25 files, 191 tests), all passing.
The first T0/T1 invocation was blocked by the execution sandbox's local-listener
restriction; the invocation allowing local listeners passed. These checks do not
establish usability, real-provider integration or real-model quality. No Docker,
model campaign or production mutation was performed for this interaction review.

Four small probes directly executed the existing pure functions: mention preview,
workspace path parsing, failure recovery labeling and memory-index allocation.
Their results are recorded with the findings below. No new production code or
regression tests were added.

## Overall assessment

Deskmates has more of a control-plane interface than a complete agent work product.
Its pages expose stored objects and runtime events, but users need a connected
path from assigning work to receiving a reliable result. The main missing product
concept is a task with an accountable owner, current state, intervention points
and deliverables, spanning multiple messages, runs and attempts.

Four distinctions need to be explicit:

- A bot being registered is different from being configured and ready for work.
- A conversation is a communication space; a message is not necessarily a work order.
- A run ending is different from a task being delivered or its result being verified.
- Memory being stored is different from being retrieved, supplied to the model or useful.

The existing strengths should be retained: authoritative thread transcripts,
persisted run accounting, reconnect reconciliation, drafts and conflict handling
in established editors, inline approvals, provenance and versioned memory, and
workspace-level browser takeover. The review does not justify replacing the SDK,
putting model calls in the Gateway or introducing access control between bots.

## Findings

### Bot management

**B1 — The creation form's Role does not configure behavior. Priority: immediate.**
`management.tsx` and `thread-rail.tsx` collect a role, and `registry-routes.ts`
stores it. `scheduler/run-lifecycle.ts` sends the bot name and home directory,
but no role, to the sidecar. `sidecar/context.ts` uses SOUL.md or a generic
missing-SOUL fallback. There is no production read of `bot.role` that turns it
into the bot's instructions. A newly created "researcher" can therefore look
configured while still using the generic fallback. This finding does not imply
that existing bots with separately installed SOUL files lack their instructions.

Make the relationship explicit: editable display description versus actual
instructions. Creation should prepare instructions, show capabilities and
missing prerequisites, and offer a bounded test before marking the bot ready.
Do not silently reinterpret existing role labels as executable instructions.

**B2 — Configuring a bot depends on running its execution environment. Priority: immediate.**
`api/memory-routes.ts::executeBotFile` rejects file access when the workspace
is not running and rejects writes while workspace runs are live. Saving SOUL
also clears all of that bot's thread sessions through `commitSoulChange`.
The UI says the bot uses the change on its next run, without exposing the
session reset. Another bot's work can prevent this bot from being configured.

Store editable configuration independently of container uptime, with a visible
draft/effective version and application at an appropriate run boundary. Explain
when a change starts a fresh session. ADR-0011 amendment A5 points toward a
canonical Gateway copy, but is not implemented in this source.

**B3 — There is no practical bot lifecycle in the UI. Priority: next.**
`management.tsx` renders every bot as a large card containing model fields,
SOUL and raw approval-rule fields. It lacks search, a dedicated bot page,
pause/archive/duplicate, a test conversation and recent task outcomes. Names
and roles are create-time only (`bots/bots.ts`); the name must match an ASCII
identifier. Cron configuration exists in the API but not this screen.

Use a compact roster with availability and outstanding work, then a bot detail
page for instructions, capabilities, memory, schedules and history. Separate a
stable mention handle from an editable display name. Pausing should describe
what happens to queued work, running work and scheduled triggers separately.

### Group conversations

**C1 — Posting information and ordering execution are coupled. Priority: immediate.**
ADR-0005 routes a message without a recognized mention to all members in turn.
The same applies to a misspelled mention with no valid target. The existing
picker reduces mistakes, but does not separate an update, a question, a work
assignment and a broadcast. Progress messages also consume the bot message
budget, creating tension between visibility and avoiding caps.

The pure probe for `@cheif please continue` with members `chief` and `researcher`
returned no recognized recipient and one unknown name. `ThreadRouter.route`
then takes the sequential broadcast path. The preview displays both the
broadcast explanation and a warning that the unknown name wakes nobody.

Proposed direction: visible recipients and optional conversation policies
(direct reply, coordinator-led work, deliberate discussion); informational
updates should not accidentally create new assignments. This changes ADR-0005
and needs a new decision and paired evaluation, not a UI-only default change.

**C2 — Groups have members but no accountable work structure. Priority: immediate.**
The thread contract has membership, title, caps and active/paused status. It has
no first-class task owner, accepted assignments, dependencies, result checks or
pending handoffs. A chief is a prompt convention. A list of members and desktops
cannot answer who owes the next result or which failed expert is blocking it.
The retained ADR-0016 trial evidence is an example of this gap.

Keep discussion in the transcript and add a task summary: goal, owner,
assignments, actual state, outstanding decisions and linked deliverables.
Labels must distinguish model-reported progress from tool receipts and operator
acceptance; no invented completion percentages.

**C3 — Running conversations do not expose the meaning of follow-up messages. Priority: immediate.**
`chat-pane.tsx` permits another send while a bot is running, but displays no
choice or receipt distinguishing queued follow-up from an interruption or
replacement instruction. The scheduler's two-lane policy is not a steering UI.
There is no user-facing run cancellation/continuation API in `api/run-routes.ts`
or the Web client. A message saying "stop" is not a dependable control.

Define the controls and outcomes: send a queued update; cancel queued work;
stop running work with recorded partial results; explicitly continue retained
work. Do not promise arbitrary safe pause/resume until the SDK path is verified.

**C4 — Conversation organization and reading are incomplete. Priority: next.**
`thread-rail.tsx` is a flat list without search, unread markers, pin/archive or
rename controls. Group and bot-to-bot bus conversations use the same list.
`chat-pane.tsx` renders plain text, including Markdown syntax, and only recognizes
certain absolute file paths. New messages unconditionally scroll to the bottom,
even when the user is reading earlier content. The composer has no attachment
upload or quoted-reply flow. Messages and histories have no UI pagination.

Provide searchable conversations, meaningful titles, read state and archive;
preserve reading position; render sanitized Markdown with safe link handling;
support typed attachments. Group templates can reuse a membership configuration
without introducing another security or container boundary.

### Memory management

**M1 — The user sees overlapping memory concepts without a clear source of truth. Priority: immediate.**
The Knowledge screen still edits the physical MEMORY.md file. The Learned memory
screen separately edits entries in SQLite. `sidecar/context.ts` injects both the
file and the pinned index into the first user turn. `/memory/export` exports
trusted bot experience while the physical file remains separate operator notes;
the Knowledge page's export uses its current file draft. These are materially
different objects carrying similar names.

Present explicit categories: human instructions, workspace facts, bot experience
and current task context, with source and scope. If legacy operator notes stay,
name them accordingly and show how they interact with learned entries.

**M2 — Experience and task closure are API-only flows. Priority: immediate.**
The only production callers of consolidation and task-to-episode closure are
the operator routes `/api/bots/:id/memory/consolidate` and
`/api/threads/:id/close-task`. The Web client and screens expose neither. There
is no automatic consolidation trigger in current source. ADR-0011 amendment A1
specifies one, but the document is ahead of implementation. Users cannot finish
the intended learning loop through the UI, and empty experience tabs give no
useful explanation.

Connect task closure, experience consolidation and a visible status/history.
Explain whether experience is waiting for eligible evidence, confirmation or a
scheduled consolidation. Retain the intended treatment of untrusted content;
do not fix an empty tab by silently promoting untrusted memories.

**M3 — General memories can crowd out all current task notes. Priority: immediate.**
`contracts/memory.ts::assemblePinnedIndex` allocates up to 120 workspace lines,
then 80 bot lines, and only the remainder to task state. A pure probe with
120 one-line workspace facts, 80 one-line bot facts and one live task note
produced `{workspace:120, bot:80, task:0, totalLines:200}`. The UI does not show
this omission. This establishes the allocation behavior, not a measured model
failure in production. Recency ranks facts; relevance to the current request
is not used for the pinned index. Line limits also do not bound token volume.

Reserve a task-context budget and expose inclusion/exclusion reasons. Budget
and ranking changes are strategy changes requiring paired evaluation. A run
should link to the actual memory versions supplied; that is exposure evidence,
not proof that the model relied on them causally.

**M4 — Forget is irreversible, while the interaction resembles a routine row action. Priority: immediate.**
The Learned memory screen calls `forgetMemoryEntry` immediately on one click.
`memory/versions.ts` and its tests confirm that all historical bodies are
redacted, and undo then throws. Undo is shown for ordinary edits but absent on
forgotten entries. The distinction is not explained before the destructive act.
The forgetting path also does not invalidate already resumed SDK sessions;
previously injected text is not erased from their existing history by this call.

Separate exclusion from future retrieval from permanent erasure. If permanent
erasure is retained, explain the exact effect before confirmation. Display when
edits affect future runs and the limits for an already running/resumed session.

**M5 — Memory inspection and editing are weaker than the older editors. Priority: next.**
`learned-memory.tsx` shows eight storage-oriented columns, default-includes
forgotten entries, and mixes task notes and episodes into the workspace tab.
There is no search, active-only filter, version diff, conflict comparison or
view of the entries supplied to a chosen run. Edits have no expected-version
parameter, unlike SOUL and legacy MEMORY editors. The reload path also lacks
an ordering/cancellation guard when workspace requests overlap. That race is a
source-identified risk, not a browser-reproduced incident.

Default to an understandable summary and active entries. Add source, effective
scope, last-use evidence and history on demand, with optimistic concurrency and
safe navigation while editing. "Trusted" should explain provenance/authority,
not imply the fact was checked and found correct.

### Running work and receiving results

**R1 — Runtime diagnostics occupy the place of task supervision. Priority: immediate.**
`run.tsx` leads with IDs, lane, trigger, timestamps and usage. Tool calls/results
are primarily expandable JSON. `thread-view.ts` ignores run-event frames for
the transcript, so tool activity or assistant events do not become a readable
live task narrative unless a bot explicitly posts progress. There is no global
running/queued/blocked task inbox, and background runs have no dedicated list
screen. The chat's generic states do not explain the next required action.

Show current stage, last evidence-backed action, waiting reason, elapsed time,
partial outputs and available interventions. Keep raw events in a diagnostic
drawer. Make a unified attention queue link to the same authoritative approval
and task records rather than inventing a second decision system.

**R2 — The recovery label makes an unsupported task-level claim. Priority: immediate.**
`thread-view.ts::transcriptTimeline` marks a failed run as recovered whenever
the same bot has any later succeeded or silent run in that thread. A pure
probe with one failed run followed by an unrelated silent run returned
`recovered:true`. The old assignment need not have been completed.

Use the literal fact "the bot has run since" until an explicit continuation or
task resolution links the outcomes. Process health and task recovery are
different states. Likewise, present `succeeded` as a run outcome rather than an
unqualified claim that the user's goal was satisfied.

**R3 — Approval decisions lack an understandable impact preview. Priority: immediate.**
`approval-card.tsx` displays L2, tool name, origin, argument summary and the
trigger instruction. "Always" commits immediately, with no preview of the
generated matcher's future scope; Deny requires an extra step. The management
screen asks users to type tool names and argument patterns to manage policy.

Describe the proposed action, affected object/account, outgoing content and
exact future scope of a reusable rule. Show a diff or preview when available;
explain who decided and how to revoke. Preserve existing human/bot decision
authority while making delegation and rule persistence understandable.

**R4 — Deliverables are text paths rather than stable product objects. Priority: next.**
`path-links.ts` recognizes only ASCII path characters. The pure probes returned
`/work/final` as the link for `/work/final report.md`, and no link for
`/work/最终报告.md`. `MessageRow` renders ordinary attachments as name/type/ref
text. Downloads use the live workspace file route, so availability depends on
the container and current file contents; there is no delivered-version concept
in this flow. ADR-0014 intentionally caps downloads at 1 MiB, which is also
restrictive for ordinary document deliverables.

Introduce typed deliverables with an immutable submitted version, preview,
download, source task/run and clear size support. A local working file and the
version delivered to the user should be distinguished. Safe preview and storage
need design work; raw HTML must not become executable just to improve rendering.

**R5 — Desktop emphasis and global takeover scope do not align. Priority: next.**
The chat devotes a rail to each member's desktop, although the shared browser
can be irrelevant to shell/database tasks. Taking control from a bot card holds
the whole workspace, not just that bot; the dialog explains this after entering
control. Closing the dialog does not itself hand control back.

Default the side panel to task details and outputs; make desktops an optional
inspection tab. Before takeover, state which bots' browser work will wait and
keep a persistent return-control affordance visible after closing the viewer.
Do not pretend per-bot screens are independent browsers or isolation boundaries.

## Comparable product patterns

These are official documented interaction patterns, not claims that other
products have solved all agent reliability problems or match Deskmates's topology.

- [Grok Bot management](https://docs.x.ai/grok-bot/bots) treats the bot as a
  durable teammate with an editable profile, operational description, duplicate
  and hide flows. [Its collaboration guide](https://docs.x.ai/grok-bot/chat-and-collaboration)
  describes replies to specific messages, attachments, visible handoffs and
  steering work in progress. It does not establish Deskmates's exact join-order
  wake algorithm; that remains Deskmates's own policy. This qualification was
  already recorded in the repository's 2026-09-22 competitor review.
- [Grok Bot routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
  connect an owner and schedule to test runs, pause controls and recent outcomes.
  This is a useful reference for turning Deskmates's API-only cron support into
  an operable feature after a one-off task is reliable.
- [OpenClaw command queues](https://docs.openclaw.ai/concepts/queue) explicitly
  distinguish steering active work, queuing a follow-up, collecting messages and
  interrupting work, with runtime-dependent fallback behavior. Borrow explicit
  delivery semantics; do not imply Deskmates's current SDK integration already
  supports the same controls.
- [Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
  describes planning, breaking work into subtasks, visible execution and
  previewable/downloadable outputs. The relevant pattern is the complete
  delegation-to-deliverable experience, not its execution environment.
- [Microsoft Copilot Studio testing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-test-bot)
  combines a test conversation, execution tracing and saved diagnostic snapshots.
  Its documentation also warns that the test pane does not reproduce every
  published/background behavior. Deskmates needs both a bot configuration/test
  loop and validation in its real deployment path.
- [Slack's agent surfaces](https://docs.slack.dev/ai/) provide split view,
  app threads, streaming and suggested prompts. The relevant pattern is clear
  conversation context and feedback during work; Slack's surfaces alone do not
  establish a multi-agent coordination policy.
- [Claude memory controls](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
  expose review/edit/delete and conversational corrections with documented
  timing. Deskmates needs similar clarity about what is remembered and when
  a correction takes effect.
- [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)
  make persistent context explicit through labeled, described blocks and shared
  references. Borrow visibility and attribution, not an access-control model
  that contradicts Deskmates's shared-workspace architecture.

## Proposed product structure

Use the workspace as the persistent context selector. It remains the shared
computer/trust domain, not a newly added project or team security layer.

Primary navigation within that context:

1. Work: active/queued tasks, waiting decisions and recent results.
2. Conversations: private bot conversations and groups, with task summaries.
3. Bots: roster, readiness and dedicated configuration/test/history pages.
4. Knowledge and memory: clearly distinguished human instructions, reference
   material, learned facts, experience and task context.

Connections, schedules, usage and environment configuration belong in contextual
detail/settings. Desktop viewing and run diagnostics are tools opened from the
work they explain. A separate global attention view can aggregate workspaces.

The task model can be small: goal, owner, parent/assignment links, status,
pending decisions, deliverables and linked runs/attempts. It should record
work and user intent, not introduce a new custom reasoning loop. Routine tasks
should be assignable in natural language without a mandatory setup form or
extra confirmation. Keep uncertain model-reported completion separate from
checked receipts and explicit user acceptance.

## Recommended sequence and acceptance

**First: remove misleading behavior and restore control.** Address B1/B2, M2,
M4, R2/R3 and run stop/continuation semantics. Treat M3's starvation as an
explicit strategy defect to evaluate. Show unsupported controls as unavailable
with the prerequisite, not as silently nonfunctional features.

**Second: deliver one coherent user journey.** A user creates a bot, tests its
instructions, delegates one task to a group, sees accountable assignments,
handles one blocked action, receives an artifact and corrects one learned fact.
No API calls, shell intervention or hidden fixture preparation by the tester.
Introduce the minimal task model and contextual bot/memory/run views needed for
that journey before adding more unrelated feature pages.

**Third: scale and validate.** Add search/archive, schedules, compact history,
memory inspection and reproducible real-provider scenarios. Evaluate routing,
memory ranking and instruction changes with the existing paired protocol.

Release acceptance should include these concrete scenarios:

| Scenario | Required observation |
|---|---|
| Create bot on a stopped workspace | Instructions can be prepared; missing prerequisites are visible; test run receives the saved version |
| Change one bot while a peer works | Edit is retained as a draft/effective-next version without breaking the peer or silently resetting context |
| Misspell a recipient | Exact delivery behavior is explicit; no accidental broadcast under the adopted future policy |
| Send an update during execution | UI identifies queued versus applied; cancel/stop targets a known task/run |
| Expert exhausts its budget | Partial work survives; delegator sees the blocker and can continue, stop or reassign under the adopted policy |
| Later unrelated run succeeds | Earlier failed task is not relabeled recovered |
| Long conversation receives a new reply | User reading history keeps their position and sees a new-message affordance |
| Memory is edited in two operator tabs | Conflicting edits do not silently overwrite; effective timing is visible |
| Memory is forgotten | Permanent deletion is explicit; existing-session limitations are accurately shown |
| Memory index is full | Current task context is handled by the adopted evaluated policy; omissions are inspectable |
| Task finishes and experience is eligible | Closure/consolidation can complete through the supported UI/automatic path and show provenance |
| Report uses spaces/Chinese names or exceeds 1 MiB | Supported delivery succeeds, or a clear predeclared limit prevents an unusable promised artifact |
| Take over and close desktop viewer | All affected browser work and the retained human hold remain visible; handback is accessible |

Measure user task completion, intervention count, time spent blocked, incorrect
routing, unresolved failures, artifact retrieval and report correctness. Button
click tests and container success remain necessary lower layers; they cannot
serve as the final product acceptance by themselves.

Changes to wake semantics, task ownership/continuation, canonical bot configuration
and memory injection must follow the ADR process. This review does not authorize
or implement those changes. Pure presentation and accurate labels can be fixed
without silently changing the architecture.
