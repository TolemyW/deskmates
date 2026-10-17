// Run audit routes (issue #11, ADR-0042): what one run changed, and the operator's "this run was
// wrong" mark. The run guard has already resolved `:id` to a run in the caller's workspaces.
//
// `GET /api/runs/:id/changes` is the one route the run drawer adds: the run's approvals with
// their decisions, its task checkpoints and artifacts, the learned-memory entries it wrote, its
// mark and whether retention pruned its ledger. Everything else the section shows (`learned`,
// `filesChanged`, `sitesVisited`, the frozen model, skill set and SOUL version) is on the run row,
// and the memory the run was given is `GET /api/runs/:id/memory-versions`.

import { DeskmatesError, type RunChanges, type RunId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { runMemoryWrites, runTaskArtifacts, runTaskCheckpoints } from "../ledger/run-changes.js";
import { RunMarkStore } from "../ledger/run-marks.js";
import { prunedAt } from "../ledger/run-retention.js";
import { requestActorId } from "./actor.js";

function noteOf(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body))
    throw new DeskmatesError("validation", "body must be a JSON object", { field: "body" });
  const note = (body as Record<string, unknown>).note;
  if (note === undefined || note === null) return undefined;
  if (typeof note !== "string")
    throw new DeskmatesError("validation", "note must be a string", { field: "note" });
  return note;
}

export function registerRunAuditRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const marks = new RunMarkStore(ctx.db);

  app.get<{ Params: { id: string } }>("/api/runs/:id/changes", async (request) => {
    const run = ctx.runs.mustGet(request.params.id as RunId);
    const mark = marks.get(run.id);
    const pruned = prunedAt(ctx.db, run.id);
    const changes: RunChanges = {
      approvals: ctx.approvals.forRun(run.id),
      checkpoints: runTaskCheckpoints(ctx.db, run.id),
      artifacts: runTaskArtifacts(ctx.db, run.id),
      memoryWritten: runMemoryWrites(ctx.db, run.id),
      ...(mark ? { mark } : {}),
      ...(pruned ? { prunedAt: pruned } : {}),
    };
    return changes;
  });

  /** Mark the run wrong, or replace the note of its mark (decision 3). */
  app.put<{ Params: { id: string } }>("/api/runs/:id/mark", async (request) => {
    const run = ctx.runs.mustGet(request.params.id as RunId);
    const note = noteOf(request.body);
    return {
      mark: marks.mark(run.id, {
        ...(note !== undefined ? { note } : {}),
        markedBy: requestActorId(request, request.body),
      }),
    };
  });

  /** Remove the mark; the run's learned items are consolidation input again. */
  app.delete<{ Params: { id: string } }>("/api/runs/:id/mark", async (request) => {
    const run = ctx.runs.mustGet(request.params.id as RunId);
    return { removed: marks.unmark(run.id) };
  });
}
