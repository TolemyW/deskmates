# Workspace task management (ADR-0021)

Migration `0027` adds operator-maintained tasks without rewriting existing rows.
The authenticated operator listener serves:

- `GET/POST /api/workspaces/:workspaceId/tasks`: one page `{tasks, offset, limit, total,
  statusCounts}` / 201 `{task}`. `?status=&q=&offset=&limit=` filters, searches title and owner
  and pages on the server, most recently updated first, 25 a page, at most 100; `statusCounts`
  counts the whole workspace by status (#113).
- `GET/PATCH /api/workspaces/:workspaceId/tasks/:id`: `{task}`.
- `POST /api/workspaces/:workspaceId/tasks/:id/accept`, body `{version}`: `{task}`.

New tasks are `planned`; other states are `in_progress`, `blocked`, `delivered`,
`accepted`, and `cancelled`. Blocked records require nonempty `blockedReason` and
`nextAction`. Delivery requires at least one artifact reference; it records a
declaration, not a verified file or immutable snapshot. Only the separate accept
route changes a delivered record to accepted, with the authenticated actor and acceptance
time: `user:<id>` for a signed-in person, or the historical generic `human:web` label when
the shared operator credential is used (it does not establish an individual person's
identity). Migration 0028 keeps existing `human:web` acceptances unchanged. Accepted/cancelled tasks are frozen until explicitly
reopened to planned or in progress. Leaving delivered or reopening clears delivery
and acceptance metadata. A list returns latest updates first.

Every edit/acceptance requires the loaded positive integer `version`, advancing it
atomically. A stale version is 409 `invalid_transition` with
`details.reason: "version_conflict"`; validation failures leave the whole record
unchanged. Unknown fields, direct PATCH acceptance and caller-supplied acceptance
attribution are rejected. First-version limits are 200-character titles/artifact
labels/reference IDs, 20,000-character descriptions, 2,000-character blocker/next
steps, 4,096-character paths, 100 unique thread/run IDs per list, and 50 artifacts.

Owner bots, threads, runs and optional artifact run references must exist in the
same workspace. Ownership is descriptive, never a bot permission. Artifact paths
pass `workspaceFileRoot`'s lexical ADR-0014 policy; availability and symlink/file
policy are checked only when the existing download/preview surface reads current
workspace bytes. No task mutation starts, wakes, cancels or resumes a run, posts a
message, closes memory notes, changes model context, or accesses the sandbox.
Linked run success does not deliver or accept work. Apart from `task_deliver` below,
no task API is exposed on the sandbox listener or through sidecar tools.

## Bot delivery (ADR-0021 amendment 2)

Migration `0041` adds `output_schema_json`, `output_json` and `delivered_by`, keeping
every earlier row (its deliverer is NULL, never guessed). Operator POST/PATCH accept an
optional `outputSchema` (null clears it): a JSON object of at most 16 KiB using only
`type`, `required`, `properties`, `enum`, `items`, `additionalProperties` and the
annotations `title`, `description`, `$schema`; any other keyword is a 400, so no stored
constraint goes unchecked. The check is `src/tasks/output-schema.ts`, a pure rule with no
dependency. A PATCH that declares delivery records the authenticated actor as `deliveredBy`.

`POST /internal/runs/:runId/tasks/:taskId/deliver`, body `{summary, artifacts: [{label, path}],
output?}`, run token only, answers `{task}`. The task must be in the run's workspace (else 404)
and list the run or the run's thread (else 403 `forbidden`); the owner bot is not consulted.
Accepted and cancelled tasks are 409. At least one artifact is required; each passes the same
lexical path policy and is stamped with the delivering run, replacing an earlier artifact with
the same path. With an `outputSchema`, `output` is required and must conform, else 400
`validation` with `details.errors` listing every failure (at most 20). Success sets `delivered`,
`deliveredAt`, `deliveredBy: bot:<botId>` and `output` (at most 64 KiB), appends the run to
`runIds`, writes a `log` ledger event `{tool: "task_deliver", taskId, summary, artifacts,
hasOutput}` and publishes `task_delivered` `{workspaceId, task, runId, summary}` (with the run's
`threadId` when it has one). It starts, wakes and kicks nothing; acceptance stays the operator
route. A run is offered the tool only when `TaskStore.deliverableFor` finds an open task linked
to it or its thread; the start request names those tasks in `deliverableTasks` (at most 20).
