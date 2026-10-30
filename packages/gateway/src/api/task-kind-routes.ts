// Task templates, the kind view and related tasks (ADR-0021 amendment 4). Templates are written
// by a workspace's Owners and Admins, each change audited; the views are reads for its Owners,
// Admins and Members (`route-policies/task-kinds.ts`). Nothing here starts, wakes or cancels a run.

import {
  DeskmatesError,
  type RelatedTaskList,
  type TaskKindList,
  type TaskKindStats,
  type TaskTemplate,
  type TaskTemplateList,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { actorLabel } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { RelatedTasks } from "../tasks/related-tasks.js";
import { KIND_VIEW, TaskKindView } from "../tasks/task-kind-stats.js";
import { TaskTemplateStore } from "../tasks/task-templates.js";

type WorkspaceRoute = { Params: { workspaceId: string } };
type TemplateRoute = { Params: { workspaceId: string; id: string } };

/** A bounded positive integer query value, or the default when absent. */
function boundedInt(raw: unknown, key: string, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new DeskmatesError("validation", `${key} must be an integer from 1 to ${max}`, { key });
  return value;
}

export function registerTaskKindRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const templates = new TaskTemplateStore(ctx.db);
  const view = new TaskKindView(ctx.db, templates);

  app.get<WorkspaceRoute & { Querystring: Record<string, unknown> }>(
    "/api/workspaces/:workspaceId/task-templates",
    async (request): Promise<TaskTemplateList> => ({
      templates: templates.list(request.params.workspaceId as WorkspaceId, {
        archived: request.query.archived === "1" || request.query.archived === "true",
      }),
    }),
  );

  app.post<WorkspaceRoute>(
    "/api/workspaces/:workspaceId/task-templates",
    async (request, reply) => {
      const workspaceId = request.params.workspaceId as WorkspaceId;
      const actor = actorLabel(request.principal);
      const template = ctx.db.transaction((): TaskTemplate => {
        const created = templates.create(workspaceId, request.body, actor);
        ctx.audit.record({
          action: "task_template.create",
          actor,
          workspaceId,
          targetKind: "task_template",
          targetId: created.id,
          after: created,
        });
        return created;
      })();
      return reply.code(201).send({ template });
    },
  );

  app.patch<TemplateRoute>("/api/workspaces/:workspaceId/task-templates/:id", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const actor = actorLabel(request.principal);
    const template = ctx.db.transaction((): TaskTemplate => {
      const { before, after } = templates.update(workspaceId, request.params.id, request.body);
      ctx.audit.record({
        action: "task_template.update",
        actor,
        workspaceId,
        targetKind: "task_template",
        targetId: after.id,
        before,
        after,
      });
      return after;
    })();
    return { template };
  });

  app.delete<TemplateRoute>("/api/workspaces/:workspaceId/task-templates/:id", async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const actor = actorLabel(request.principal);
    const template = ctx.db.transaction((): TaskTemplate => {
      const archived = templates.archive(workspaceId, request.params.id, request.body);
      ctx.audit.record({
        action: "task_template.archive",
        actor,
        workspaceId,
        targetKind: "task_template",
        targetId: archived.id,
        before: { kind: archived.kind, name: archived.name },
      });
      return archived;
    })();
    return { template };
  });

  app.get<WorkspaceRoute>(
    "/api/workspaces/:workspaceId/task-kinds",
    async (request): Promise<TaskKindList> => view.kinds(request.params.workspaceId as WorkspaceId),
  );

  app.get<{ Params: { workspaceId: string; kind: string }; Querystring: Record<string, unknown> }>(
    "/api/workspaces/:workspaceId/task-kinds/:kind",
    async (request): Promise<TaskKindStats> =>
      view.stats(request.params.workspaceId as WorkspaceId, request.params.kind, new Date(), {
        windowDays: boundedInt(
          request.query.days,
          "days",
          KIND_VIEW.windowDays,
          KIND_VIEW.maxWindowDays,
        ),
        stalledMinutes: boundedInt(
          request.query.stalledMinutes,
          "stalledMinutes",
          KIND_VIEW.stalledMinutes,
          KIND_VIEW.maxStalledMinutes,
        ),
      }),
  );

  app.get<TemplateRoute>(
    "/api/workspaces/:workspaceId/tasks/:id/related",
    async (request): Promise<RelatedTaskList> =>
      new RelatedTasks({
        db: ctx.db,
        embedding: ctx.retrieval.embeddingClient,
        usage: ctx.retrieval.usage,
      }).related(request.params.workspaceId as WorkspaceId, request.params.id),
  );
}
