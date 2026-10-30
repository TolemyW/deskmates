// Operator task routes. Ordinary task writes never reach a scheduler or sandbox. The explicit
// dispatch acts of ADR-0021 amendment 3 are an immediate create and `POST .../run`; each writes
// one keyed submission and posts through the thread router after its transaction commits.
import {
  DeskmatesError,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  TASK_STATUSES,
  type TaskDetailResponse,
  type TaskListPage,
  type TaskStatus,
  type TaskSubmitResponse,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { type DispatchResult, TaskDispatcher } from "../tasks/task-dispatch.js";
import { taskExecution } from "../tasks/task-execution.js";
import { kindProgress, progressReports } from "../tasks/task-kind-progress.js";
import { TaskTemplateStore } from "../tasks/task-templates.js";
import { createTaskRequest, runTaskRequest } from "../tasks/validate.js";
import { requestActorId } from "./actor.js";
import { parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord } from "./validate.js";

/** A workspace's tasks: 25 a page, at most 100 (#113). */
export const TASK_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };
/** The longest task search accepted. */
const TASK_QUERY_MAX = 200;

type WorkspaceRoute = { Params: { workspaceId: string } };
type TaskRoute = { Params: { workspaceId: string; id: string } };

export function registerTaskRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler?: Scheduler,
): void {
  const dispatcher = new TaskDispatcher(ctx, () => scheduler?.kick());
  const templates = new TaskTemplateStore(ctx.db);

  // One page of the workspace's tasks, status and search applied on the server, with the honest
  // total and the whole workspace's counts by status for the metric cards (#113).
  app.get<WorkspaceRoute & { Querystring: Record<string, unknown> }>(
    "/api/workspaces/:workspaceId/tasks",
    async (request): Promise<TaskListPage> => {
      const workspaceId = request.params.workspaceId as WorkspaceId;
      const { offset, limit } = parseOffsetQuery(request.query, TASK_PAGE);
      const { status, q } = request.query;
      if (
        status !== undefined &&
        status !== "" &&
        !(TASK_STATUSES as readonly unknown[]).includes(status)
      )
        throw new DeskmatesError("validation", "Unknown task status", { field: "status" });
      if (q !== undefined && (typeof q !== "string" || q.length > TASK_QUERY_MAX))
        throw new DeskmatesError("validation", "Invalid task search", { field: "q" });
      const page = ctx.tasks.page(
        workspaceId,
        {
          ...(status ? { status: status as TaskStatus } : {}),
          ...(typeof q === "string" && q ? { q } : {}),
        },
        offset,
        limit,
      );
      return {
        tasks: page.tasks,
        offset,
        limit,
        total: page.total,
        statusCounts: ctx.tasks.statusCounts(workspaceId),
      };
    },
  );

  app.post<WorkspaceRoute>("/api/workspaces/:workspaceId/tasks", async (request, reply) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const checked = createTaskRequest(request.body);
    // A3a: dispatch needs a responsible bot; refuse before anything is written.
    if (checked.trigger !== "manual" && !checked.input.ownerBotId)
      throw new DeskmatesError("validation", "Immediate and scheduled tasks need an owner bot", {
        key: "ownerBotId",
      });
    if (checked.trigger === "immediate") ctx.quotas.assertQueueRoom(requestTenant(request));
    const actor = actorLabel(request.principal);
    const authorId = requestActorId(request, {});
    let dispatched: DispatchResult | undefined;
    const outcome = ctx.bus.batch(() =>
      ctx.db
        .transaction((): { response: TaskSubmitResponse; created: boolean } => {
          // A3b: a repeated create key answers with what exists and writes nothing.
          const key = checked.idempotencyKey;
          const found = key === undefined ? null : ctx.tasks.findByCreateKey(workspaceId, key);
          if (found) {
            const task = ctx.tasks.mustGet(workspaceId, found.id);
            const submission = dispatcher.findByKey(task.id, `create:${key}`);
            return { response: { task, ...(submission ? { submission } : {}) }, created: false };
          }
          let task = ctx.tasks.create(workspaceId, checked.input, {
            ...(key === undefined ? {} : { createKey: key }),
            ...(checked.schedule === undefined ? {} : { schedule: checked.schedule }),
            // ADR-0021 A4c: a template stamps the kind and copies its criteria.
            ...(checked.templateId === undefined
              ? {}
              : { template: templates.mustGet(workspaceId, checked.templateId) }),
            ...(checked.fields === undefined ? {} : { fields: checked.fields }),
          });
          if (checked.schedule !== undefined)
            ctx.audit.record({
              action: "task.schedule_set",
              actor,
              workspaceId,
              targetKind: "task",
              targetId: task.id,
              after: task.schedule,
            });
          if (checked.trigger !== "immediate") return { response: { task }, created: true };
          dispatched = dispatcher.submit({
            workspaceId,
            taskId: task.id,
            kind: "immediate",
            key: `create:${key ?? task.id}`,
            actor,
            authorId,
          });
          task = dispatched.task;
          ctx.audit.record({
            action: "task.run",
            actor,
            workspaceId,
            targetKind: "task",
            targetId: task.id,
            after: { submissionId: dispatched.submission.id, kind: "immediate" },
          });
          return { response: { task, submission: dispatched.submission }, created: true };
        })
        .immediate(),
    );
    if (dispatched) dispatcher.publish(dispatched);
    return reply.code(outcome.created ? 201 : 200).send(outcome.response);
  });

  app.get<TaskRoute>(
    "/api/workspaces/:workspaceId/tasks/:id",
    async (request): Promise<TaskDetailResponse> => {
      const task = ctx.tasks.mustGet(request.params.workspaceId as WorkspaceId, request.params.id);
      return {
        task,
        execution: taskExecution({ db: ctx.db, tasks: ctx.tasks, dispatcher }, task, new Date()),
        ...(task.kind
          ? { kindProgress: kindProgress(task.kind, task.status, progressReports(ctx.db, task.id)) }
          : {}),
      };
    },
  );

  app.patch<TaskRoute>("/api/workspaces/:workspaceId/tasks/:id", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const actor = actorLabel(request.principal);
    const scheduleChange = asRecord(request.body).schedule !== undefined;
    // An edit that declares delivery records the authenticated principal as `deliveredBy`
    // (ADR-0021 amendment 2); like acceptance, the client never names the actor. A schedule in
    // the body is an explicit schedule change (A3d), audited; nothing is dispatched.
    const task = ctx.db.transaction(() => {
      const updated = ctx.tasks.update(workspaceId, request.params.id, request.body, actor);
      if (scheduleChange)
        ctx.audit.record({
          action: "task.schedule_set",
          actor,
          workspaceId,
          targetKind: "task",
          targetId: updated.id,
          after: updated.schedule,
        });
      return updated;
    })();
    return { task };
  });

  app.post<TaskRoute>("/api/workspaces/:workspaceId/tasks/:id/accept", async (request) => ({
    // The acceptor is the authenticated principal, never a client-supplied actor (ADR-0022 P1).
    task: ctx.tasks.accept(
      request.params.workspaceId as WorkspaceId,
      request.params.id,
      request.body,
      actorLabel(request.principal),
    ),
  }));

  // A3a, A3b: the explicit Run action. A repeated key returns its submission and writes nothing.
  app.post<TaskRoute>("/api/workspaces/:workspaceId/tasks/:id/run", async (request, reply) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const input = runTaskRequest(request.body);
    const actor = actorLabel(request.principal);
    const authorId = requestActorId(request, {});
    const key = `run:${input.idempotencyKey}`;
    const existing = dispatcher.findByKey(request.params.id, key);
    if (!existing) ctx.quotas.assertQueueRoom(requestTenant(request));
    const result = ctx.bus.batch(() =>
      ctx.db
        .transaction(() => {
          const task = ctx.tasks.mustGet(workspaceId, request.params.id);
          const found = dispatcher.findByKey(task.id, key);
          if (found) return { submission: found, task, duplicate: true } as DispatchResult;
          ctx.tasks.checkVersion(task, input.version);
          if (input.feedback !== undefined) {
            if (task.status !== "delivered")
              throw new DeskmatesError(
                "invalid_transition",
                "Only a delivered task can be revised",
              );
            ctx.tasks.update(
              workspaceId,
              task.id,
              { version: task.version, status: "in_progress" },
              actor,
              { revision: true },
            );
          }
          const done = dispatcher.submit({
            workspaceId,
            taskId: task.id,
            kind: "manual",
            key,
            actor,
            authorId,
            ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
          });
          ctx.audit.record({
            action: "task.run",
            actor,
            workspaceId,
            targetKind: "task",
            targetId: task.id,
            after: { submissionId: done.submission.id, kind: "manual" },
          });
          return done;
        })
        .immediate(),
    );
    dispatcher.publish(result);
    const response: TaskSubmitResponse = { task: result.task, submission: result.submission };
    return reply.code(result.duplicate ? 200 : 201).send(response);
  });

  // A3e: soft deletion. Future triggers stop; history, runs and publications stay.
  app.delete<TaskRoute>("/api/workspaces/:workspaceId/tasks/:id", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const actor = actorLabel(request.principal);
    const task = ctx.db.transaction(() => {
      const deleted = ctx.tasks.softDelete(workspaceId, request.params.id, request.body, actor);
      ctx.audit.record({
        action: "task.delete",
        actor,
        workspaceId,
        targetKind: "task",
        targetId: deleted.id,
        before: { title: deleted.title, status: deleted.status },
      });
      return deleted;
    })();
    return { deleted: true, taskId: task.id };
  });
}
