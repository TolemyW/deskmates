# Operator-maintained tasks (ADR-0021)

**Tasks** opens `#/tasks` in the selected workspace; `#/tasks/new` creates a goal and
`#/tasks/:id` opens a read-first detail. The default surface leads with the goal,
responsible Bot, schedule, latest bounded result and the next available action.
The list shows title, owner, state and blockers, with a status filter and an explicit refresh.
Refreshing the list also reloads owner choices while preserving the current editor draft.
Changing workspace or task destroys the previous editor; late reads, writes and failures cannot
replace the new selection or navigate back to an old creation. If a task deep link is absent in
the selected workspace, its detail reports the error while that workspace's list stays usable.

Operators can create a planned task, expand **Edit goal** to edit description/owner/status/blocker/next action, and link
existing conversations, runs and workspace files through labelled pickers. The Gateway validates
that every reference belongs to the task's workspace. A new task defaults to **Manual**, so its
untouched form is valid; choosing **Immediately** requires an owner and **Scheduled** also requires
a schedule. Optional template fields remain available, as do the existing named conversation,
run and file pickers under **Advanced options**. The creation trigger may start or schedule work,
while later edits never rerun it. An unsaved goal disables **Start work**.
A successful run does not deliver or accept a task.

**Templates** opens template management from Tasks. Members can read templates; Owners and
Admins can create, copy, edit and archive them. Closing the dialog discards its unsaved editor.
The separate Task kinds statistics screen is withdrawn; its addresses redirect to Tasks.
No Gateway endpoints, task records or execution behaviour are removed.

Blocked requires both a reason and next action. A manual change to Delivered requires an
artifact reference; a formal verified delivery can instead report a non-file result. Delivery
exposes **Accept delivery** and **Request changes** at the top. Request changes returns the task
to In progress without dispatching it; edit and save, then explicitly run again if needed.
Acceptance uses the shared
`human:web` operator label, not an independently authenticated individual. Accepted/cancelled
records are read-only until explicitly reopened as Planned or In progress, which clears delivery
and acceptance metadata. Artifact controls reuse the authenticated bounded text preview and
download (ADR-0014); they read current bytes, not frozen or verified delivery versions.

Version, actor audit, output schema, raw output and retained links live under closed
**System details**. Full submissions, checkpoints and all deliveries stay under
**Technical activity details**. Task kind progress and related tasks remain in a separate
disclosure. Task-owned one-Bot conversations are reached from Tasks/Activity rather than the
Chats rail; canonical, private and group chats stay in Chats. A task goal and time never
automatically become long-term instructions or change learned-memory policy.

On wide screens the list has a bounded width and the goal sits beside activity/results.
Smaller screens retain one-column reading order.

Edits and acceptance send the loaded version. A conflict retains the unsaved draft and requires
an explicit **Reload and discard draft** before retrying; reload is not a routine primary action.
Drafts are ephemeral: leaving the page, switching workspace, reload or disconnect discards them.
Task data has no live SSE subscription in this first version. The standalone demo supports this
same operator flow in memory; it is not a persistence or Gateway-validation test.

Deterministic coverage lives in `src/features/tasks/tasks.test.tsx`, `src/api/task-client.test.ts`,
the router tests and demo tests. Browser/visual acceptance remains a separate gate.

On narrow screens, opening or creating a task shows that task directly, with a
Back to tasks link. The list and page-level creation controls do not precede the
selected detail. Wide screens retain the list/detail layout; the list-only page
puts search and status filtering in a single toolbar.

Search and status filters are retained within each workspace when moving between
the task list and a selected task. Task editing state remains isolated per task.
