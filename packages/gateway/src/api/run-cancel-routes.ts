// `POST /api/runs/:id/cancel` (issue #15): an operator stops a run. The route names a transition
// the design already has (`cancelled` from every non-terminal state, design v0.3 §4); the work is
// in `Scheduler.cancel`. The guard has already resolved the run to the caller's tenant.

import { type RunId, decidedByHuman } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { requireOwnRun } from "./side-chat-guard.js";

export function registerRunCancelRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request) => {
    const id = request.params.id as RunId;
    requireOwnRun(ctx, request, ctx.runs.mustGet(id), "cancel a run");
    return { run: scheduler.cancel(id, decidedByHuman(requestActorId(request, request.body))) };
  });
}
