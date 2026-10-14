// `task_deliver` and `task_checkpoint` (ADR-0021 amendments 2 and 3): the task writes a run may
// make, under the run-token scope of `/internal/runs/:runId/*`. A delivery's files are verified
// through the workspace before anything is written (ADR-0014 A4) and published idempotently;
// neither route starts or wakes a run, posts a message or accepts a task.
import type { RunId, TaskCheckpointResponse, TaskDeliverResponse } from "@deskmates/contracts";
import { DeskmatesError } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { verifyWorkspaceFiles } from "../files/file-verification.js";
import { deliverTaskInput } from "../tasks/validate.js";
import { asRecord } from "./validate.js";

type TaskParams = { Params: { runId: string; taskId: string } };

function bodyFor(request: { body: unknown; params: { taskId: string } }): Record<string, unknown> {
  const body = asRecord(request.body);
  if (body.taskId !== undefined && body.taskId !== request.params.taskId)
    throw new DeskmatesError("validation", "taskId in the body differs from the path");
  return { ...body, taskId: request.params.taskId };
}

export function registerTaskInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post<TaskParams>(
    "/internal/runs/:runId/tasks/:taskId/deliver",
    async (request): Promise<TaskDeliverResponse> => {
      const runId = request.params.runId as RunId;
      const input = deliverTaskInput(bodyFor(request));
      const run = ctx.runs.mustGet(runId);
      // Everything that needs no workspace read is refused first, so a bad call costs no exec.
      const scope = ctx.tasks.deliveryScope(runId, input);
      const verified = await verifyWorkspaceFiles(
        ctx,
        scope.workspaceId,
        input.artifacts.map((a) => a.path),
      );
      return ctx.bus.batch(() =>
        ctx.db.transaction(() => {
          const { task, delivery } = ctx.tasks.deliver(runId, input, verified);
          ctx.events.append({
            runId,
            kind: "log",
            payload: {
              tool: "task_deliver",
              taskId: task.id,
              summary: input.summary,
              kind: delivery.kind,
              artifacts: input.artifacts.length,
              published: delivery.publications.length,
              outstanding: delivery.outstanding.length,
              hasOutput: input.output !== undefined,
            },
          });
          ctx.bus.publish({
            type: "task_delivered",
            ...(run.threadId ? { threadId: run.threadId } : {}),
            workspaceId: task.workspaceId,
            task,
            runId,
            summary: input.summary,
          });
          return { task, delivery };
        })(),
      );
    },
  );

  app.post<TaskParams>(
    "/internal/runs/:runId/tasks/:taskId/checkpoints",
    async (request): Promise<TaskCheckpointResponse> => {
      const runId = request.params.runId as RunId;
      ctx.runs.mustGet(runId);
      const checkpoint = ctx.db.transaction(() => {
        const recorded = ctx.tasks.recordCheckpoint(runId, bodyFor(request));
        ctx.events.append({
          runId,
          kind: "log",
          payload: {
            tool: "task_checkpoint",
            taskId: recorded.taskId,
            completed: recorded.completed.length,
            outstanding: recorded.outstanding.length,
          },
        });
        return recorded;
      })();
      return { checkpoint };
    },
  );
}
