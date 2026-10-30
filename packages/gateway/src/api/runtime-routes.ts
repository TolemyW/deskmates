// The upgrade drain (ADR-0029 decision 1): how many runs this Gateway would cut off if it stopped
// now, the drain that stops it starting more, and the restart breaker's held runs (decision 6).

import {
  DeskmatesError,
  type PlatformResumeResponse,
  type RunId,
  type RuntimeStatus,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { lastAddressPools } from "../host-resources/host-resources.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";

/**
 * `GET /api/runtime` → `RuntimeStatus`. A release script starts a drain, polls this until
 * `activeRuns` is 0 and then stops the Gateway; a run that cannot reach a safe point within the
 * drain budget makes it end the drain and retry later (ADR-0029 decision 3). `addressPools` is the
 * Docker address-pool headroom of the last host-resource check (ADR-0006 amendment 5 decision 14).
 *
 * Active means `running`, `stalled` or `waiting_approval_live`: a sidecar process is executing in
 * the workspace (a live approval wait is the PreToolUse hook blocking inside that process). Under
 * a drain each one parks at its next safe point as `waiting_platform`, and a restart parks them
 * the same way in `Scheduler.reconcile`. `queued` has no process yet and is started by the next
 * Gateway; `waiting_approval`, `waiting_browser` and `waiting_platform` are parked, their process
 * has exited, and they resume from the database after a restart. Counting them would hold an
 * upgrade for as long as a human leaves an approval undecided.
 *
 * `POST /api/runtime/drain` starts the drain and `DELETE` ends it; both answer with the status. A
 * drain is a property of this process: a new Gateway starts out of drain.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.get("/api/runtime", async (): Promise<RuntimeStatus> => {
    // ADR-0006 amendment 5 decision 14: the last check's pool headroom, never a new Docker call.
    const addressPools = lastAddressPools(ctx);
    return {
      ...scheduler.runtimeStatus(),
      ...(addressPools === undefined ? {} : { addressPools }),
    };
  });
  app.post("/api/runtime/drain", async (): Promise<RuntimeStatus> => scheduler.startDrain());
  app.delete("/api/runtime/drain", async (): Promise<RuntimeStatus> => scheduler.endDrain());
  // Decision 6: an operator lets the runs the restart breaker held continue.
  app.post<{ Body: { runIds?: unknown } | undefined }>(
    "/api/runtime/platform-resume",
    async (request): Promise<PlatformResumeResponse> => {
      const raw = request.body?.runIds;
      if (raw !== undefined && (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")))
        throw new DeskmatesError("validation", "runIds must be an array of run ids");
      return {
        resumedRunIds: scheduler.releaseHeld(
          decidedByHuman(requestActorId(request, request.body)),
          raw as RunId[] | undefined,
        ),
      };
    },
  );
}
