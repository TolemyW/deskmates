# M4 task management: first implementation plan

Date: 2026-10-04
Base: main `1707ddad60e03799d89cb266457ae81976c3f517`
Decision: [ADR-0021](../adr/0021-workspace-task-management.md)

## Scope and sequence

1. Establish shared task contract and architecture decision before implementation.
2. Add a forward-only SQLite migration, workspace-scoped store, strict validation,
   version-conflict handling and authenticated operator HTTP routes.
3. Add Tasks navigation, list/detail, owner and status editing, blocker/next-step
   fields, chat/run/output linking and a separate human acceptance action.
4. Exercise lifecycle, persistence, foreign-reference rejection, authentication,
   no-dispatch invariant, conflict and stale-response behavior with deterministic
   Gateway/Web tests. Run full available T0/T1, backend/Web types, lint and builds.
5. Review the resulting diff and provide exact evidence and remaining limits.

## First-version contract

- GET/POST `/api/workspaces/:workspaceId/tasks`: `{tasks}` / `{task}`.
- GET/PATCH `/api/workspaces/:workspaceId/tasks/:id`: `{task}`.
- POST `/api/workspaces/:workspaceId/tasks/:id/accept`, body `{version}`: `{task}`.
- Create starts planned. PATCH carries version; status excludes accepted.
- Blocked requires reason and next action. Delivered requires an artifact reference.
- Acceptance requires delivered and an explicit operator action.
- Task edits are management only. Link existing chats/runs/paths; continue work
  from their existing surfaces. No new model or sidecar task tools in this slice.

## Explicit exclusions

Organizations/tenancy/roles, per-bot security, task dependencies/DAG scheduling,
automatic output extraction or status inference, sidecar task APIs, agent tool
integration, immutable artifact snapshots, model-quality claims, realtime task
streaming, paid model runs, deployment, remote pushes and PR publication.

## Evidence discipline

The isolated working tree copies only files verified against the selected GitHub
tree via Git blob hashes. Production packages, scripts, acceptance, evaluation
and configuration inputs are included; unrelated historical `spikes/` contents
are not materialized and are excluded by the repository's default test/lint
configuration. Keep the full GitHub tree inventory outside the deliverable.
Existing dependency cache is reused locally with package links pointing at this
working tree, without installing or mutating the previous checkout.

Docker and browser localhost access were unavailable in the prior cloud pass.
Do not bypass restrictions. Record live UI/container stages as unrun unless this
environment provides a supported route. Deterministic UI tests are not a visual
or container acceptance pass. M4's deferred M3 runtime/statistical gates remain
separate and retain their original outcomes.
