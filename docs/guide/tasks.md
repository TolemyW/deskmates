# Tasks

What it is: a small, durable list of work in a workspace. A task records what is wanted, which
bot is responsible, what blocks it, where the results are, and whether a person has accepted the
outcome. A run records an attempt; a task records whether the outcome was delivered and accepted.

Where you find it: **Tasks** in the sidebar, for the current workspace. The list on the left
filters by status; the detail on the right edits one task. **New task** creates one.

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
back and clears its delivery and acceptance record.

## Create and edit

Give a task a title and description, optionally an owner bot, links to threads and runs of this
workspace (paste IDs or app links, one per line), and artifact references (a label and an
absolute path under `/work/` or `/home/<bot>/`). An optional output schema describes the
structured result you expect; the screen shows it, but it is set through the operator API (for
example by an external agent, see [Using Deskmates from another agent](using-deskmates-from-another-agent.md)).

Every save carries the version you loaded. If someone else saved first, your save is refused,
your draft is kept, and you reload before saving again. The list does not update live: use
**Refresh task list** to see others' changes.

## Delivery

A bot can deliver a task when the task is linked to its run or to the chat it runs in. It names
its artifacts and, when the task has an output schema, an output that must match the schema. The
task moves to **Delivered** and shows who delivered it, the summary and the output as plain text.
A person can also set a task to delivered.

## Acceptance

When a task is delivered, **Review the delivery** offers **Accept delivery**. Open the linked
artifacts first: delivery does not certify the files or the result. Acceptance records who
accepted and when. Only a person accepts; a bot or an external agent cannot.

## What this cannot do

- Saving a task does not start or steer a run. Task management never dispatches execution: it does
  not start, wake, cancel or resume a run, post a message or grant an approval. To get work done,
  write to the bot in a chat (linking the task to that chat lets later runs there deliver it).
- A linked run's success never changes a task's state.
- The owner bot is descriptive, never an access-control boundary. A link is routing, not a
  permission between bots.
- An artifact reference points to the file's current bytes. No snapshot, checksum or proof that
  the file exists is kept.
- There are no live updates, no automatic task extraction from chats, and no scheduling from
  tasks.
- Task management is merged and tested offline. Actual browser review, runtime and real-model
  acceptance are still pending (see the [M4 status ledger](../design/m4-status-2026-10-04.md)).
