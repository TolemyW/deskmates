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

Delivery rechecks the run's terminal status inside the write transaction, after file
verification. A cancellation during verification therefore refuses the pending write.
An identical retry of the latest delivery returns its original receipt and task version,
including its file publications, without another delivery row, ledger event or notification.
The comparison binds run, attempt, scope, normalized payload and verified file digests;
changed content or a task edit/reopen remains a new delivery. Replay hashes and committed
task versions persist across restarts. Historical rows without replay metadata are kept
unchanged and are not guessed to be a retry.

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

Paths and refusals (issue #39 item 5, `src/tasks/task-paths.ts`). A relative artifact or
checkpoint evidence path is resolved against the directory the run started in (ADR-0038:
`/work/bots/<bot>` in per-bot mode, `/work` in shared mode), `.` and `..` are normalised, and the
result must still pass the lexical policy; the stored path is the resolved one. Checkpoint
evidence may also be a git commit hash (7 to 40 hex characters) or an http(s) URL, stored as given
with `evidenceKinds` (`path`, `commit`, `url`) beside `evidence`; nothing fetches or verifies them,
and a checkpoint stored before kinds existed has none (all its entries are paths). An artifact
must be a file, so a commit or URL there is refused. A refusal for a missing or malformed field
(`summary` included), a missing or non-conforming `output`, a refused path or a failed file
verification carries `details.workDir` and `details.example`, a minimal valid call whose `output`
follows the task's `outputSchema`; the sidecar prints both in the tool result. The sidecar's
`summary` parameter is optional so that a call without it reaches this refusal.


## Progress and result history

Each new checkpoint records the task scope version at recording time. The sidecar sends
the version from its start request; a stale version is refused without a checkpoint write. Operator details
retain older checkpoints with their version; the UI and continuation context mark an older
or unknown version as historical evidence to revalidate. Criteria progress uses only records
from the current scope. A legacy checkpoint has unknown scope; it is not silently stamped
with the current version.

On a schema-less complete delivery, omitting `output` preserves the current structured
result; explicit `output: null` clears it. Tasks with an output schema still require a valid
output. Every new delivery stores its structured result snapshot, which remains readable
through task details and the delivery history after subsequent changes. Historical deliveries
without a snapshot omit `output`; the migration never fabricates history from today's result.
