// `GET /api/runs/:id/context`: per-run context metrics for the operator (M3 context plan,
// Phase 1): turns, peak and p95 input window, cache hit ratio, compactions, the system prompt's
// section sizes and hash, and what the model proxy saw of the system prompt per request.
// Computed on read (`ledger/run-context.ts`); an operator route, never reachable by a run token.

import type { RunId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { runContextMetrics } from "../ledger/run-context.js";

export function registerRunContextRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<{ Params: { id: string } }>("/api/runs/:id/context", async (request) => {
    const id = request.params.id as RunId;
    ctx.runs.mustGet(id);
    return runContextMetrics(ctx.events.list(id), ctx.modelRequests.list(id));
  });
}
