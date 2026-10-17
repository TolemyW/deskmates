// The upgrade drain signal: how many runs this Gateway would cut off if it stopped now.

import type { RuntimeStatus } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";

/**
 * `GET /api/runtime` → `RuntimeStatus`. A release script polls it and stops the Gateway once
 * `activeRuns` is 0.
 *
 * Active means `running`, `stalled` or `waiting_approval_live`: a sidecar process is executing in the
 * workspace (a live approval wait is the PreToolUse hook blocking inside that process), and a
 * Gateway restart fails exactly these runs in `Scheduler.reconcile`. `queued` has no process yet
 * and is started by the next Gateway; `waiting_approval` and `waiting_browser` are parked, their
 * process may have exited, and they resume from the database after a restart. Counting them
 * would hold an upgrade for as long as a human leaves an approval undecided.
 */
export function registerRuntimeRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/runtime", async (): Promise<RuntimeStatus> => {
    const activeRunIds = ctx.runs.listActive().map((run) => run.id);
    return { activeRuns: activeRunIds.length, activeRunIds };
  });
}
