// `GET /api/capacity?workspaceId=` (issue #16): free lanes, queue depth and parked runs per bot,
// and the workspace's browser-lock holder, container state and sidecar slots. Read-only and
// computed on read from the runs and browser-lock tables; the guard has already resolved the
// workspace to the caller's tenant.

import {
  type BotCapacity,
  type BrowserLockHolder,
  type CapacityResponse,
  DeskmatesError,
  type LaneCapacity,
  PARKED_RUN_STATUSES,
  type RunLane,
  type WorkspaceId,
  occupiesLane,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import type { Scheduler } from "../scheduler/scheduler.js";

function laneCapacity(runs: readonly RunRecord[]): LaneCapacity {
  // `occupiesLane` counts `queued` too; a queued run is waiting for the lane, not holding it.
  const active = runs.find((run) => run.status !== "queued" && occupiesLane(run.status));
  return {
    free: active === undefined,
    ...(active === undefined ? {} : { activeRunId: active.id }),
    queued: runs.filter((run) => run.status === "queued").length,
    parked: runs.filter((run) => PARKED_RUN_STATUSES.has(run.status)).length,
  };
}

function browserLockHolder(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
): BrowserLockHolder | null {
  const locks = ctx.locks.list(workspaceId);
  if (locks.some((lock) => lock.holderKind === "human")) return { kind: "human" };
  const runIds = [
    ...new Set(locks.flatMap((lock) => (lock.holderRunId ? [lock.holderRunId] : []))),
  ];
  return runIds.length > 0 ? { kind: "run", runIds } : null;
}

export function registerCapacityRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.get<{ Querystring: { workspaceId?: string } }>(
    "/api/capacity",
    async (request): Promise<CapacityResponse> => {
      const workspaceId = request.query.workspaceId as WorkspaceId | undefined;
      if (!workspaceId) throw new DeskmatesError("validation", "workspaceId is required");
      ctx.workspaces.mustGet(workspaceId);
      const open = ctx.runs.listOpenInWorkspace(workspaceId);
      const lane = (botId: string, name: RunLane) =>
        laneCapacity(open.filter((run) => run.botId === botId && run.lane === name));
      const bots: BotCapacity[] = ctx.bots.list(workspaceId).map((bot) => ({
        botId: bot.id,
        name: bot.name,
        lanes: { interactive: lane(bot.id, "interactive"), background: lane(bot.id, "background") },
      }));
      const slots = scheduler.capacity(workspaceId);
      return {
        capacity: {
          workspaceId,
          containerRunning: (await ctx.sandboxes.peek(workspaceId)) !== undefined,
          browserLock: browserLockHolder(ctx, workspaceId),
          sidecars: { active: slots.activeAttempts },
          bots,
        },
      };
    },
  );
}
