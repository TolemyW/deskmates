# ADR-0021: Operator-maintained tasks in a workspace

Date: 2026-10-04
Status: Accepted (product owner, 2026-10-10, including amendment 2 task_deliver; management and bot delivery have shipped on the stable deployment)
Scope: M4 first implementation; not a release or milestone acceptance

Implementation update (2026-10-04): the owner-approved management-first slice
merged as PR #3 at main `6bf09f1`. CI run `37191471153` passed 2,710 root T0/T1
and 277 Web tests. These are implementation checks, not live UI, runtime,
real-model or statistical acceptance. See
[the M4 status ledger](../design/m4-status-2026-10-04.md).
The initial local-development slice is now integrated; the Proposed decision
status is retained pending separate acceptance of the ADR. No deployment is
implied by the merge.

## Context

A run records an execution attempt, not whether a requested outcome was delivered
or accepted. Threads retain the conversation, but an operator needs a small durable
list of work, its responsible bot, blockers and output references. The owner asked
to implement management first. This is not an organization platform or a replacement
for thread routing, approvals, continuation or the SDK loop.

## Decision

1. **Tasks are workspace-scoped operator records.** Persist title, description,
   optional owner bot, state, blocker and next action, thread/run references and
   artifact references in Gateway SQLite. Owner assignment is descriptive, never
   an access-control boundary. All referenced bots, threads and runs must belong
   to the same workspace. Existing workspace/run/thread data is preserved.

2. **Management never dispatches execution.** Create and edit through authenticated
   operator routes only. Changes neither start nor cancel runs, post messages,
   grant approval, resume a parked run, or change model context. The UI states
   this limitation. Sidecar task tools, automatic task extraction, scheduler
   integration and mid-run steering are deferred. A linked run's success never
   changes task status. The existing thread `close-task` memory action closes
   task-scoped memory notes (ADR-0011); it does not accept these management
   records, and accepting a management task does not close memory notes.
   Amendment 2 lifts the deferral of sidecar task tools for delivery only
   (`task_deliver`); "management never dispatches execution" stands.

3. **Delivery and acceptance are separate facts.** States are `planned`,
   `in_progress`, `blocked`, `delivered`, `accepted`, `cancelled`. New tasks are
   planned. A blocked task requires both a reason and an actionable next step.
   Delivery requires at least one artifact reference and records delivery time;
   it does not certify file contents or outcome correctness. Acceptance is an
   explicit operator-only action from delivered, recording time and the generic
   `human:web` operator label, not an independently authenticated individual.
   Accepted/cancelled records can be reopened to planned or in progress; reopening
   clears delivery/acceptance metadata. Acceptance is not a PATCH status option.

4. **References reuse existing surfaces.** Threads and runs open their existing
   views. Artifact label/path and optional run reference point to current
   workspace bytes through ADR-0014's authenticated preview/download route.
   Apply its lexical path policy on reference writes; actual filesystem policy
   and availability are checked on reading. No immutable snapshot, checksum,
   file existence, or bot-reported provenance is implied by linking an artifact.

5. **Edits are bounded and conflict-aware.** Every edit and acceptance carries
   the loaded integer version and atomically advances it. Stale versions fail
   without partial writes. Validate and bound text/reference collections, reject
   unknown fields, and retain unsaved UI drafts when a conflict requires reload.
   First-version input caps: title/artifact label 200 characters, description
   20,000, blocker/next action 2,000 each, artifact path 4,096, reference ID 200,
   100 unique thread references, 100 unique run references and 50 artifacts.
   These are defensive product bounds, not measured optimums; changes require
   reviewing payload size and operator editing needs, not an agent strategy trial.
   A response for an old task/workspace must not replace the newly selected view.

6. **The first UI is a task list and detail editor.** Workspace selection scopes
   both. The list exposes owner, state and blockers; the detail exposes next
   action, links and explicit acceptance. Refresh reads authoritative state;
   this iteration does not promise realtime task subscriptions. Drafts are
   ephemeral and not stored across reload/disconnection.

## Verification

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | SQLite persistence survives reopen; cross-workspace references and wrong-scoped reads/writes fail | T0/T1 Gateway task store/routes tests; migration tests | none |
| 2 | Task mutation creates no runs/messages/provider calls; run tokens cannot use operator routes | T1 task routes tests | none |
| 3 | Invalid blocked/delivered states fail; only delivered can be accepted; reopening clears acceptance | T0/T1 task store/routes tests; Web task journey test | none |
| 4 | Invalid paths and foreign references fail; valid links use existing authorized surfaces | T1 task routes tests; Web task tests; existing file-preview tests | Artifact availability/immutability not asserted |
| 5 | A competing update loses without partial mutation; invalid payloads do not write; stale responses ignored | T0/T1 task tests; Web conflict/navigation tests | none |
| 6 | Create, detail, owner/status edits and explicit acceptance are usable; scope navigation resets view | Web task/router tests; supported live UI review still pending | none |
| A1 | Cookie acceptance stores `user:<id>`; bearer acceptance stores `human:web`; a client actor field is refused without a write; 0028 preserves legacy rows and refuses any other label | T1 `auth-routes.test.ts` (TASK-01), `migration-0028.test.ts`; T0 Web `tasks.test.tsx` label | none |
| A2a | The supported keyword subset checks outputs as tabled; an unsupported keyword, a wrong keyword shape, a schema over 16 KiB or nested deeper than 16 levels is refused at write without a change; null clears the schema | T0 `gateway/src/tasks/output-schema.test.ts`; T0 `tasks.test.ts` ("stores, replaces and clears an output schema"); T1 `task-deliver-routes.test.ts` ("validates operator schemas") | none |
| A2b | `task_deliver` is offered only when an open task is linked to the run or its thread, and the start request names those tasks and schemas; it is L1 and asks no approval; a run with no linked task sees no new tool | T0 `scheduler/sidecar-tools.test.ts` (task_deliver); T1 `tasks/deliverable-start.test.ts`; T0 `tasks.test.ts` (deliverable list); sidecar `task-tools.test.ts`, `risk-tier.test.ts` | Effect on agent behaviour not measured (no paired eval run) |
| A2c | Another workspace's task is 404, an unlinked run 403, a closed task 409, an unsafe path 403, no artifact 400, a schema mismatch 400 with every error in `details.errors`; none writes; only the run's own token reaches the route, never the operator listener, and a run token cannot set a schema or accept | T1 `api/task-deliver-routes.test.ts`; T0 `tasks.test.ts` (refusals); `operator-auth.test.ts` semantics unchanged | none |
| A2d | Success sets `delivered`, time, `deliveredBy: bot:<id>`, output, appends the run, writes a ledger `log` event and publishes `task_delivered`; it creates no run or message and kicks no scheduler; acceptance stays the human route; an operator PATCH records its actor; leaving `delivered` clears deliverer and output; 0041 keeps earlier rows and refuses an unknown deliverer label | T1 `task-deliver-routes.test.ts` (success); T0 `tasks.test.ts` (transitions, migration 0041) | none |
| A2e | The task detail shows the deliverer, the schema and the output as inert text; output markup is not rendered | T0 Web `features/tasks/tasks.test.tsx` (bot delivery) | Supported live UI review pending |

## Amendment 1 (2026-10-05, proposed with ADR-0022 P1): acceptance names the signed-in person

A1. Decision 3's `human:web` label recorded that the shared operator credential identifies no
individual. With ADR-0022 sessions, acceptance records the authenticated principal instead:
`user:<id>` for a signed-in person, and still `human:web` when the shared operator credential
is used. The accept route takes no actor from the client (any extra body field is a 400).
Migration 0028 widens the `accepted_by` CHECK to admit `user:<id>` and keeps every historical
`human:web` acceptance unchanged; no old act is attributed to a new account. Management still
starts no run.

Its Verification row is item A1 in the table above.

## Amendment 2 (2026-10-09): a bot delivers a task through `task_deliver`

Amends decision 2. The owner decided on 2026-10-09 (issue #21) that this needs no
standalone ADR. "Management never dispatches execution" stands: no task write starts,
wakes, cancels or resumes a run, posts a message or grants an approval. The deferral of
sidecar task tools is lifted for delivery only; automatic extraction, scheduler
integration and mid-run steering stay deferred. Decision 3's acceptance is unchanged:
only a human accepts.

A2a. **A task may carry an output schema.** Operator create and edit routes accept an
optional `outputSchema`, a JSON object of at most 16 KiB using only `type`, `required`,
`properties`, `enum`, `items`, `additionalProperties` and the annotations `title`,
`description` and `$schema`. Any other keyword is refused at write, so no stored
constraint goes unchecked. The check is a pure, dependency-free rule in the Gateway; it
never calls a model and never judges whether the output is correct.

A2b. **`task_deliver({taskId, summary, artifacts: [{label, path}], output?})` is a
sidecar tool.** A run is offered it only when an open task (not accepted or cancelled) is
linked to the run itself or to the run's thread; the start request names those tasks and
their schemas. A run with no linked task sees no new tool. Linking a task to a thread is
therefore the one way management now changes model context: later runs in that thread are
offered the tool. The tool is L1, a Gateway-side record that a human still accepts.

A2c. **The Gateway checks every delivery.** `POST /internal/runs/:runId/tasks/:taskId/deliver`
is authenticated by that run's token only; run tokens still never reach operator routes.
The task must belong to the run's workspace and list the run or the run's thread, else
the delivery is refused: a bot cannot deliver work it was never given. The owner bot is
not consulted; a link is routing, not a permission between bots (ADR-0004). At least one
artifact is required, each passing ADR-0014's lexical path policy and stamped with the
delivering run. With a schema, `output` is required and must conform; every failure is
returned to the bot so it can correct and call again. Accepted and cancelled tasks must
be reopened by an operator first.

A2d. **What a delivery records.** The task moves to `delivered` with delivery time,
`deliveredBy: bot:<id>` and the output; the run is appended to the run references; the
run's ledger gets a `log` event with the summary; a `task_delivered` event is published
on the bus. An operator who declares delivery by PATCH is recorded as `user:<id>` or
`human:web`. Leaving `delivered` clears the deliverer and the output, as it already clears
the delivery time. Migration 0041 is forward-only and adds nullable columns; an earlier
row's deliverer stays unknown, never guessed.

A2e. **The task detail shows the deliverer, the schema and the output** as inert text.

Its Verification rows are items A2a to A2e in the table above. These are deterministic
local checks. No real model has called the tool, and offering it is a strategy-relevant
change for runs with linked tasks; its effect on agent behaviour is unmeasured until a
paired evaluation runs.

## Amendment 3 (2026-10-13, proposed from the owner-confirmed contracts of issues #64, #74 and #63): explicit triggers, formal delivery and checkpoints

Amends decisions 2, 3 and 6 and amendment 2. The owner confirmed on 2026-10-13 (issue #64) that
creating a task offers Immediately, Scheduled or Manual, that there is no task draft lifecycle,
and that ordinary edits never rerun work; and (issue #74) that a bot's formal delivery is verified
by the server and published to Files without a human confirmation, while partial delivery never
completes a task. Issue #63 asks that each wake carry authoritative identity and that exhaustion
and continuation keep evidence pointers. Decision 2's "management never dispatches execution" is
superseded **only** for the three explicit dispatch acts of A3a; every other task write, a link, a
refresh and reopening the editor still starts, wakes, cancels and resumes nothing. Run success
still never changes task state, delivery is still not acceptance, and workspace budgets belong to
their own decision (issue #61): this amendment adds no budget, per-task quota or scheduler bypass.

A3a. **Three explicit dispatch acts, nothing else.** `POST /api/workspaces/:id/tasks` takes a
`trigger`: `immediate`, `scheduled` (with a schedule, A3c) or `manual`. The Web form offers the
three and defaults to Immediately. A request without `trigger` is `manual`, so an API client that
predates this amendment never dispatches by accident. The other two dispatch acts are an explicit
`POST /api/workspaces/:id/tasks/:taskId/run` (the Run action) and a due scheduled occurrence. A
task saved with any trigger is an ordinary record: there is no draft state, draft action or
publish step. Dispatch needs a responsible (owner) bot of the workspace; an immediate or scheduled
create without one, or Run on a task without one, is a `validation` error that writes nothing. A
closed (accepted, cancelled) or deleted task cannot be run.

A3b. **One submission per intended execution, keyed.** Every dispatch act writes one
`task_submissions` row: task, kind (`immediate`, `manual`, `scheduled`), key, the task's scope
version (A3f), the authenticated actor (`user:<id>`, `human:web`, `service:<id>` or `schedule`),
the execution thread, the posted message and a `dispatch` outcome (`posted`, `skipped_overlap`,
`missed`). The key is unique per task. Create and Run take a client `idempotencyKey` (8 to 128
characters of `[A-Za-z0-9._:-]`); repeating a create key in the workspace returns the existing
task and its submission with 200 and writes nothing, so a double click, a lost response or a
retry after a restart makes one task and one submission. A repeated Run key returns the existing
submission; a new key is an intentional later execution. A scheduled occurrence's key is
`schedule:<schedule version>:<occurrence time>`.

A3c. **Dispatch reuses the thread router and normal admission.** The execution thread is the
task's first linked `chat` thread that has the owner bot as a member; when there is none, the
dispatch creates a one-member chat with the owner bot and links it to the task. The dispatch posts
one must-reply human message, authored by the actor, that mentions the owner bot and carries the
task's title, id and description, with `externalId = task-submission:<submission id>`, so a replay
appends nothing. The router creates the run rows (ADR-0005; the lane follows the thread) and every
created run is linked to the task. Admission is unchanged: queue quotas, lanes, the browser lock,
approvals, deadlines and any budget gate apply. The task shows what really happened: no run yet,
queued, running, waiting (approval, browser, continuation or another parked state, shown as
"paused or blocked" with its run status) and the terminal status, never a claim that work ran.

A3d. **Schedules are explicit, per task, and version-aware.** `task_schedules` holds at most one
schedule per task: `once` at a UTC instant, or `repeat` with a five-field cron expression read in
a named IANA time zone (default: the Gateway's `CRON_TIME_ZONE`, else UTC). The Gateway stores
`next_fire_at` (UTC) and a schedule version; the task view shows the time zone, the expression or
instant and the next occurrence. A Task schedule runner ticks once a minute like the bot cron
runner (whose entries are not moved, duplicated or changed). For each enabled schedule with
`next_fire_at <= now` it acts on the latest due occurrence only:
- **Missed ticks** are not replayed. An occurrence more than 10 minutes late (a stopped Gateway, a
  long pause) is recorded once as `missed` and the schedule advances. The window is a guess.
- **Overlap is a skip.** While a run of an earlier submission of the task is not terminal, the
  occurrence is recorded as `skipped_overlap` and starts nothing, as for bot cron.
- **One-time vs repeating.** A `once` schedule is disabled after its occurrence fires, misses or
  is skipped; a `repeat` schedule advances to its next match after now.
- **Races.** Firing compares and sets `(task, schedule version, next_fire_at)` in one transaction
  with the submission insert. An edit that replaces, disables or removes the schedule bumps the
  schedule version, so an occurrence of the old schedule cannot fire after the edit commits, and
  the occurrence key makes a duplicated tick or restart write nothing.
Saving a scheduled task never runs it now. Editing a schedule is an explicit schedule change, not
a rerun. A due-date or deadline field never creates a schedule.

A3e. **Deletion stops future dispatch and keeps history.** `DELETE
/api/workspaces/:id/tasks/:taskId` with the loaded version marks the task deleted (time and actor)
and disables its schedule in one transaction. The row, its links, submissions, deliveries,
publications, checkpoints, threads, messages, runs and workspace bytes are kept; already admitted
runs are neither cancelled nor resumed. A deleted task leaves the list, cannot be read for editing,
run, scheduled, delivered or checkpointed, and is offered to no run as deliverable. Its Files
publications stay listed and name the task as deleted. Permanent erasure is not a task action.

A3f. **Scope version.** `tasks.scope_version` advances only when an operator edit changes the
title, the description or the output schema. A start request names each deliverable task's scope
version and the sidecar sends it back on delivery without the model choosing it; a delivery for an
older scope is refused (`invalid_transition`, reason `stale_scope`) so the bot re-reads the task.

A3g. **Formal delivery is verified, can be partial, and need not carry a file.** `task_deliver`
takes `taskId`, `summary`, zero to 50 artifacts, `outstanding` (up to 50 short criteria still open
or blocked) and `output`. The Gateway verifies every artifact through the workspace before it
writes anything (ADR-0014 amendment A4); one failed artifact refuses the whole call with a reason
per path. A delivery with no outstanding item is `complete`: the task moves to `delivered` (output
schema enforced as before). One with outstanding items is `partial`: verified artifacts are
published, a planned task moves to `in_progress`, and the task is never marked delivered. A
non-file task delivers with a summary and, when its schema asks, an output, and no placeholder
file. Each delivery is a `task_deliveries` row: task, run, attempt, bot, scope version, kind,
summary, outstanding list and Gateway time. Publication is not acceptance, and acceptance stays
the human route of decision 3; automatic publication needs no human confirmation.

A3h. **Checkpoints are durable, attributable and not deliveries.** `task_checkpoint({taskId,
completed: [{unit, outcome, evidence: [paths]}], outstanding, note})` is offered with
`task_deliver` and is L1. The Gateway binds the run, the attempt and the bot from the run's token
and row, never from model text, applies the lexical path policy to evidence paths and stores the
checkpoint in `task_checkpoints`. A checkpoint changes no task state and publishes nothing to
Files; its paths stay pointers for continuation and chat.

A3i. **Every wake names its authoritative identity.** The sidecar opens each wake, including
approval and continuation resumes, with a Gateway-sourced line naming the run id, the attempt,
the bot and every linked open task (id, title, scope version). The host handoff file names the
same identity. The model is told to use these ids, not ids recalled from older history.

A3j. **Exhaustion keeps evidence pointers.** At turn exhaustion the host handoff is written even
when the last assistant turn has no prose. It lists the files the attempt wrote or edited through
its file tools, the latest checkpoint per linked task and an explicit line when no prose summary
exists. It records pointers only; it does not judge or complete work.

A3k. **Continuation separates completed, outstanding and missing evidence.** A continuation wake
carries, per linked task, the latest checkpoint's completed units with evidence, completed units
that name no evidence (shown as missing evidence), and outstanding units. The wake states that an
empty or thin summary is not permission to repeat earlier submissions or external actions: the
bot checks the completed list and evidence first.

A3l. **Task view: declared state beside measured execution.** The task detail returns an
`execution` block read at one Gateway instant (`observedAt`): submissions newest first with their
runs' Gateway timestamps and statuses, open approvals on those runs, the schedule with its next
occurrence, the deliveries and the latest checkpoint. Bot-supplied text or times never become
freshness. The UI shows the declared state and the execution side by side and names a discrepancy
(an active run while the task is planned, a delivered task with outstanding items) without
changing either.

A3m. **Audit.** Run, schedule change and deletion are written with `AuditLog.record` in their
transaction as `task.run`, `task.schedule_set` and `task.delete`. An immediate create records one
`task.run`. Ordinary task edits remain the task's own versioned history.

Its Verification rows are items A3a to A3m in the table below. Pickers for linking runs and
threads by name (issue #64, 2026-10-12 comment) are not part of this amendment.

### Verification (amendment 3)

| Item | Concrete meaning | Test | Metric |
|---|---|---|---|
| A3a | Immediate create makes one submission and one queued run; scheduled and manual creates make none; no-trigger create is manual; immediate without an owner bot writes nothing; PATCH, link edits and reads create no run or message | T1 `gateway/src/tasks/task-triggers.test.ts` | none |
| A3b | Repeating a create key or a Run key returns the same task or submission and writes nothing; a new Run key makes a second submission | T1 `task-triggers.test.ts` ("is idempotent") | none |
| A3c | Dispatch posts one must-reply message mentioning the owner, creates or reuses the execution thread, links the run, and a busy lane leaves the run queued | T1 `task-triggers.test.ts` ("dispatches through the router") | none |
| A3d | Once and repeat schedules fire one occurrence; a duplicate tick or restart writes nothing; a late occurrence is missed; a live run skips; an edit invalidates the old occurrence; time zone sets the next occurrence | T1 `gateway/src/tasks/task-schedule.test.ts` | none |
| A3e | Deletion keeps the row, runs and publications, disables the schedule, refuses run, edit and delivery, and hides the task from the list and from deliverable tasks | T1 `task-triggers.test.ts` ("deletes softly") | none |
| A3f | Only title, description and schema edits bump the scope version; a stale-scope delivery is refused without a write | T1 `api/task-deliver-routes.test.ts` ("refuses a stale scope") | none |
| A3g | A complete verified delivery moves to delivered; a partial one never does; a non-file delivery needs no artifact; one unverifiable artifact refuses the whole call | T1 `api/task-deliver-routes.test.ts`; T0 sidecar `task-tools.test.ts` | none |
| A3h | A checkpoint records the run, attempt and bot from the token, refuses a bad path, changes no task state and publishes nothing | T1 `api/task-deliver-routes.test.ts` ("records a checkpoint") | none |
| A3i | Every wake prompt, including resumes, starts with the identity line naming the run, attempt and linked tasks | T0 sidecar `context.test.ts` ("names the execution identity") | Effect on behaviour not measured (no paired eval) |
| A3j | An exhausted attempt with no prose still writes a handoff listing written files and stating that no summary exists | T0 sidecar `run-once.test.ts` ("keeps evidence pointers") | none |
| A3k | The continuation wake lists completed, missing-evidence and outstanding units and the no-repeat instruction | T0 sidecar `context.test.ts` ("renders the continuation checkpoint"); T1 `api/task-deliver-routes.test.ts` ("records a checkpoint", latest checkpoint on the next wake) | Effect on behaviour not measured (no paired eval) |
| A3l | The task detail returns `observedAt`, submissions with run status and Gateway times, the schedule and deliveries; the Web shows declared and execution state side by side with a discrepancy note | T1 `task-triggers.test.ts` ("reports execution"); T0 Web `features/tasks/tasks.test.tsx` | Live UI review pending |
| A3m | Run, schedule change and deletion each write one audit row in their transaction | T1 `task-triggers.test.ts` ("audits") | none |

## Consequences

Contracts gains task types. Gateway gains migration 0027, a task store and
operator routes. Web gains Tasks navigation and a bounded editor. No sidecar,
model, container image or scheduling policy change is required. Local deterministic
checks establish only this implementation's tested behavior. M3 revised-scope
closure remains intact; its deferred runtime/statistical gates are not promoted
to passes or closed by this feature. Release/PR publication requires separate
authorization; Docker/model/live UI gates retain their actual execution status.
Amendment 2 later adds one sidecar tool, an internal route and migration 0041; it needs
no container image or scheduling policy change.
