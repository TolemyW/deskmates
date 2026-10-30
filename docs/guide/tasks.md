# Tasks

What it is: a small, durable list of work in a workspace. A task records what is wanted, which
bot is responsible, what blocks it, where the results are, and whether a person has accepted the
outcome. A run records an attempt; a task records whether the outcome was delivered and accepted.

Where you find it: **Tasks** in the sidebar (Work), for the current workspace. The list on the
left filters by status; the detail on the right edits one task. **New task** creates one.

Owners and Admins create and edit tasks, start their work, request changes and accept deliveries.
Members read tasks, their deliveries and execution records; Guests do not see tasks.

## States

| State | Meaning |
|---|---|
| Planned | New tasks start here. |
| In progress | Someone is working on it. |
| Blocked | Needs both a reason and an actionable next step. |
| Delivered · awaiting acceptance | Results were handed in: at least one artifact reference, with the delivery time. |
| Accepted by human | A person reviewed the delivery and accepted it. |
| Cancelled | No longer wanted. |

Accepted and cancelled tasks are read-only. **Reopen as planned** (or in progress) brings one
back and clears its current delivery and acceptance status; earlier delivery evidence stays in the
task's history.

## Create and edit

Give a task a title and description, optionally an owner bot, links to threads and runs of this
workspace (paste IDs or app links, one per line), and artifact references (a label and an
absolute path under `/work/` or `/home/<bot>/`). An optional output schema describes the
structured result you expect; the screen shows it, but it is set through the operator API (for
example by an external agent, see [Using Deskmates from another agent](using-deskmates-from-another-agent.md)).

Every save carries the version you loaded. If someone else saved first, your save is refused,
your draft is kept, and you reload before saving again.

The open task follows its own activity: when a message arrives in one of its linked chats, or one
of its linked runs finishes, the task, its execution records and the list refresh by themselves,
and after a lost connection they refresh on reconnect. If you have unsaved edits or an open
revision form at that moment, nothing is overwritten: the task shows a conflict and keeps your
draft until you choose to reload. Changes from elsewhere that touch no linked chat or run still
need **Refresh task list**.

## Delivery

A bot can deliver a task when the task is linked to its run or to the chat it runs in. It names
its artifacts and, when the task has an output schema, an output that must match the schema. The
task moves to **Delivered** and shows who delivered it, the summary and the output. A person can
also set a task to delivered.

A structured output is shown as compact cards, one per field: numbers and short values side by
side, longer text and warnings at full width. A field's title and description come from the output
schema when it has them; otherwise the field's key is shown. Values are shown exactly as delivered,
as plain text; Deskmates does not guess labels or units. The note under the output says what to
do: check the results, units and limitations against the delivered file before accepting.

## Acceptance

When a task is delivered, **Review the delivery** offers **Accept delivery** and **Request
changes**. Open the linked artifacts first: delivery does not certify the files or the result.
Acceptance records who accepted and when. Only a person accepts; a bot or an external agent
cannot.

**Request changes** asks for your feedback and sends it to the responsible bot as one revision.
Cancelling the form sends nothing. If sending fails, or the Gateway refuses the feedback, the form
stays open with your text so you can fix it and send again.

## Templates and task kinds

A template describes one **kind** of work: its stages, the done criteria of each stage (labelled
like `triage.1`), the stages that need a checkpoint, who reviews the work, an optional target time
and the fields each task carries. Four built-in templates come with every workspace:

| Template | Stages | Fields | Target |
|---|---|---|---|
| Customer support ticket | triage → resolve → confirm | customer (required), channel, priority | 24 hours |
| Research report | discovery (at least 10 logged sources) → draft → peer review → deliver | audience | none |
| Coding task | plan → implement → tests pass → review → deliver | repository, branch | none |
| Functional test | plan cases → execute with evidence → report | target, environment | none |

These are first choices, not measured best practice. Owners and Admins can create their own on
**Tasks → Templates** (**New template**), copy a built-in into a new kind and change it, edit their own
(each save is versioned) and archive one. Built-in templates cannot be edited. Members can read
templates; Guests cannot.

To use one, pick it under **Template** when you create a task and fill in its fields. The task
gets the kind and the fields, and a section listing the stages and labelled criteria is appended
to its description. That description is the only way the template reaches the bot: choosing no
template changes nothing, and no bot's instructions change. Bots report progress against the
labels with checkpoints and partial deliveries; the task page shows each criterion as met, open
or not reported, the current stage, and any discrepancy (for example, delivered while a required
checkpoint is missing). Nothing is corrected automatically. A later template edit does not change
tasks already created from it.

## Templates and execution records

**Templates** on Tasks opens template management in a dialog. Creating from a template,
criteria progress and related tasks retain their existing behaviour. The independent
**Task kinds** statistics page and the execution-monitor prototype have been withdrawn;
old addresses redirect to Tasks. Execution records remain on each task under
**Technical activity details**.

**Related tasks** on a task page lists tasks of the same kind that share a relating field (the
same customer, repository or target) or have similar text, with the reason and score. Very
similar tasks are marked **Possible duplicate**; nothing is merged or closed for you. Text from a
private chat is never used. When the deployment has an embedding service configured, similarity
uses it; otherwise it compares words.

## What this cannot do

- Creating with Immediately, choosing Start work, or a due schedule explicitly dispatches work
  to the responsible Bot. Saving an ordinary edit does not start or steer a run or grant an
  approval. Manual tasks wait until you choose Start work.
- Request changes asks for feedback, then explicitly sends it to the responsible Bot as one
  revision. Previous delivery records and verified file references stay in history. Cancelling
  the feedback form sends nothing. A failed submission keeps the feedback for retry.
- A linked run's success never changes a task's state.
- The owner bot is descriptive, never an access-control boundary. A link is routing, not a
  permission between bots.
- A formal delivery checks artifact existence, size and checksum and records that check. An
  artifact preview reads the file's current bytes, not an immutable snapshot; neither the file
  check nor a successful run proves the result is correct. Review qualifications and the
  structured output before accepting.
- The task view refreshes by itself only for activity in its linked chats and runs; other
  changes need **Refresh task list**. It does not extract tasks automatically from chats. Task schedules are explicit; accepting or cancelling the
  current task suppresses future execution until it is reopened.
- Whether templated tasks finish better is not measured yet; the built-in templates, the target,
  the stall window and the duplicate thresholds are starting guesses.
- Task management is merged and tested offline. Actual browser review, runtime and real-model
  acceptance are still pending (see the [M4 status ledger](../design/m4-status-2026-10-04.md)).
