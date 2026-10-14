# Operator-maintained tasks (ADR-0021)

**Tasks** opens `#/tasks` in the selected workspace; `#/tasks/:id` opens its detail editor.
The list shows title, owner, state and blockers, with a status filter and an explicit refresh.
Refreshing the list also reloads owner choices while preserving the current editor draft.
Changing workspace or task destroys the previous editor; late reads, writes and failures cannot
replace the new selection or navigate back to an old creation. If a task deep link is absent in
the selected workspace, its detail reports the error while that workspace's list stays usable.

Operators can create a planned task, edit description/owner/status/blocker/next action, and link
existing conversations, runs and artifact paths. Conversation/run fields accept IDs or copied
app links. All references must belong to the task's workspace; the Gateway validates them.
These are bookkeeping actions: they do not send messages, start/stop runs or steer active work.
A successful run does not deliver or accept a task.

Blocked requires both a reason and next action. Delivered requires an artifact reference, then
exposes a separate **Accept delivery** action for the human operator. Acceptance uses the shared
`human:web` operator label, not an independently authenticated individual. Accepted/cancelled
records are read-only until explicitly reopened as Planned or In progress, which clears delivery
and acceptance metadata. Artifact controls reuse the authenticated bounded text preview and
download (ADR-0014); they read current bytes, not frozen or verified delivery versions.

Edits and acceptance send the loaded version. A conflict retains the unsaved draft and requires
an explicit reload before retrying. Reload is labelled **Reload and discard draft** when dirty.
Drafts are ephemeral: leaving the page, switching workspace, reload or disconnect discards them.
Task data has no live SSE subscription in this first version. The standalone demo supports this
same operator flow in memory; it is not a persistence or Gateway-validation test.

Deterministic coverage lives in `src/features/tasks/tasks.test.tsx`, `src/api/task-client.test.ts`, the
router tests and demo tests. Browser/visual acceptance is a separate, unrun gate for this change.
