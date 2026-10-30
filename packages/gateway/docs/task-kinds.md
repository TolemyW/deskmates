# Task templates, kinds, the kind view and related tasks

[ADR-0021 amendment 4](../../../docs/adr/0021-workspace-task-management.md) (issue #3 E1 and D2).
A template is data that names a **kind** of work (a support ticket, a research report). Creating a
task from a template stamps its kind; the kind view shows how that kind of work is getting done;
related tasks show which tasks of the kind belong together. Nothing here starts, wakes or cancels
a run.

## Templates

`task_templates` holds a workspace's own templates; the built-ins are constants in
`src/tasks/builtin-templates.ts` with ids `builtin:<kind>`:

| Kind | Stages | Fields | Target | Review |
|---|---|---|---|---|
| `support-ticket` | triage → resolve → confirm | customer (required, relates), channel (`web`), priority (`P3`) | 24 h | human |
| `research-report` | discovery (≥ 10 logged sources) → draft → peer review → deliver | audience | none | peer bot |
| `coding-task` | plan → implement → tests pass → review → deliver | repository (relates), branch | none | peer bot |
| `functional-test` | plan cases → execute with evidence → report | target (relates), environment | none | human |

Criteria are labelled `<stage>.<n>` (`triage.1`). Stages may require a checkpoint. The contents
and numbers are the coordinator's first choice and unmeasured; they are a strategy change to be
evaluated with the long-horizon harness (issue #3 E2).

| Route | Role | What |
|---|---|---|
| `GET /api/workspaces/:workspaceId/task-templates[?archived=1]` | Member | Built-ins, then the workspace's own |
| `POST /api/workspaces/:workspaceId/task-templates` | Admin | Create; `kind` unique per workspace, never a built-in's |
| `PATCH /api/workspaces/:workspaceId/task-templates/:id` | Admin | Versioned edit; the kind key never changes; built-ins are 403 |
| `DELETE /api/workspaces/:workspaceId/task-templates/:id` | Admin | Archive (`{version}`); stamped tasks are unchanged |

Each write is audited as `task_template.create`, `.update` or `.archive`.

## Creating a task from a template

`POST /api/workspaces/:workspaceId/tasks` takes `templateId` and `fields`. The fields are checked
(known keys, required ones present, at most 200 characters, defaults filled) and stored in
`task_field_values`. The task gets `kind` and `kind_json`: a snapshot of the stages, criteria,
review role, target and field definitions, so later template edits change no task. One section,
starting `--- Template:`, is appended to the description: the stages with labelled criteria, the
fields, the target, the review role, and a request that `task_checkpoint` units and
`task_deliver` `outstanding` items start with the label. That description is the only way the
template reaches a bot (the existing dispatch message carries it). No checkpoint is seeded, no
default prompt changes, and a task without a template is exactly as before. `PATCH` may correct
`fields`; the description is not rewritten.

`GET .../tasks/:id` returns `kindProgress` for a templated task: each criterion `met`, `open` or
`unreported` from the checkpoints and deliveries (the last mention by label wins), the current
stage, required checkpoint stages no checkpoint reported, and named discrepancies (delivered while
a checkpoint is missing or a criterion is open).

## The kind view

`task_transitions` records every status and owner change from this migration on (field, from, to,
actor, time). An escalation is a move into `blocked`; a reassignment an owner change from one bot
to another value.

`GET /api/workspaces/:workspaceId/task-kinds` lists kinds with totals and open counts.
`GET /api/workspaces/:workspaceId/task-kinds/:kind[?days=30&stalledMinutes=60]` (days at most 90)
returns, at one instant:

- counts by status and a daily series (UTC) of created, delivered, accepted, cancelled, escalated;
- completion rate (delivered or accepted over all but cancelled) and acceptance rate;
- time to done (creation to delivery) p50/p90 by nearest rank, within and breached target;
- overdue (open past the target) and at risk (past 80 % of it);
- stalled by reason: `waiting_approval` (a linked run has a pending approval), `waiting_human`
  (blocked), `awaiting_acceptance` (delivered longer than the window ago), `no_activity` (an open
  task whose linked runs, checkpoints and deliveries show nothing for the window, and no linked run
  queued or executing);
- escalations, reassignments, and known plus estimated cost from the linked runs (ADR-0032) over
  the drill-down's tasks;
- a drill-down row per task, newest first, at most 200 (`truncated` says when there are more).

Members, Admins and Owners read it; Guests do not. It carries task records and numbers only, never
message, approval or run-summary text or thread links.

## Related tasks

`GET /api/workspaces/:workspaceId/tasks/:id/related` returns at most 10 tasks of the same kind with
their reasons: equal normalised values of a relating field, and text similarity of the title, the
description without the template section, and the latest delivery summary of a run outside any
private chat. With `EMBEDDING_URL` set (ADR-0041) the similarity is a cosine over one vector per
task in `task_text_vectors`, keyed by model and the text's SHA-256, embedded 16 at a time and
recorded in `retrieval_calls` with corpus `task` and purpose `index`; a failed call falls back to
the lexical path (`method: "lexical_fallback"`). Without it, a token Jaccard over words and CJK
bigrams (`method: "lexical"`). Possible duplicates (cosine ≥ 0.9, Jaccard ≥ 0.6) are flagged;
nothing is merged. The thresholds are guesses. No run reads this list.

## Tests

T0 `src/tasks/task-templates.test.ts`, `task-kind-progress.test.ts`, `related-tasks.test.ts`; T1
`src/api/task-kind-routes.test.ts`.
