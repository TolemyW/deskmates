// `GET /api/runs/:id/timeline`: the run's per-attempt startup timeline (ADR-0037 decision 5),
// derived on read from the whole ledger, never from a page of it. An operator route with the same
// policy as the run's context metrics; a run token never reaches it.

import { type MessageId, type RunId, buildRunTimeline } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";

export function registerRunTimelineRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { id: string } }>("/api/runs/:id/timeline", async (request) => {
    const id = request.params.id as RunId;
    const run = ctx.runs.mustGet(id);
    const trigger =
      run.triggerKind === "thread_message"
        ? ctx.messages.get(run.triggerRef as MessageId)
        : undefined;
    return buildRunTimeline({
      runId: run.id,
      status: run.status,
      attempt: run.attempt,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      submittedAt: trigger?.ts ?? null,
      events: ctx.events.list(id),
    });
  });
}
