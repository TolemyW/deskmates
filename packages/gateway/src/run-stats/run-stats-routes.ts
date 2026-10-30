// Routes of the bot's own `run_stats` tool (ADR-0050). The operator pair reads and sets the
// per-bot switch (policies in `api/route-policies/run-stats.ts`); the internal route answers the
// sidecar of one run with that run's token, for that run's bot in that run's workspace only
// (decision 2). The bot and the workspace come from the run row; the only parameter is
// `windowDays`, and any other is refused, so no parameter can widen the scope.

import {
  type BotId,
  DeskmatesError,
  RUN_STATS_WINDOW_DAYS_DEFAULT,
  RUN_STATS_WINDOW_DAYS_MAX,
  type RunId,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { requestActorId } from "../api/actor.js";
import { asRecord } from "../api/validate.js";
import type { GatewayContext } from "../context.js";
import { computeRunStats } from "./run-stats-query.js";
import { runStatsFrozenOn, runStatsSettings } from "./run-stats-setting.js";

type BotParams = { Params: { id: string } };
type RunParams = { Params: { runId: string }; Querystring: Record<string, unknown> };

/** `windowDays` from the query string: absent is the default, else an integer 1..30. */
export function parseWindowDays(query: Record<string, unknown>): number {
  for (const key of Object.keys(query))
    if (key !== "windowDays")
      throw new DeskmatesError(
        "validation",
        `run_stats takes only windowDays; ${key} is not a parameter`,
        { field: key },
      );
  const raw = query.windowDays;
  if (raw === undefined || raw === "") return RUN_STATS_WINDOW_DAYS_DEFAULT;
  const days = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > RUN_STATS_WINDOW_DAYS_MAX)
    throw new DeskmatesError(
      "validation",
      `windowDays must be an integer from 1 to ${RUN_STATS_WINDOW_DAYS_MAX}`,
      { field: "windowDays" },
    );
  return days;
}

export function registerRunStatsRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<BotParams>("/api/bots/:id/run-stats", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    return { runStats: runStatsSettings(ctx).get(bot.id) };
  });

  app.put<BotParams>("/api/bots/:id/run-stats", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const body = asRecord(request.body);
    for (const key of Object.keys(body))
      if (key !== "enabled" && key !== "authorId")
        throw new DeskmatesError("validation", `unknown run_stats setting ${key}`, { key });
    if (typeof body.enabled !== "boolean")
      throw new DeskmatesError("validation", "enabled must be a boolean", { field: "enabled" });
    return {
      runStats: runStatsSettings(ctx).set(bot, body.enabled, requestActorId(request, body)),
    };
  });
}

/** Registered inside the internal scope, whose hook refuses any token but this run's own. */
export function registerRunStatsInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get<RunParams>("/internal/runs/:runId/run-stats", async (request) => {
    const windowDays = parseWindowDays(request.query ?? {});
    const runId = request.params.runId as RunId;
    const run = ctx.runs.mustGet(runId);
    if (!runStatsFrozenOn(run))
      throw new DeskmatesError("forbidden", "this run was not started with run_stats", { runId });
    const row = ctx.db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(runId) as {
      workspace_id: string;
    };
    return computeRunStats(
      ctx.db,
      { runId, botId: run.botId, workspaceId: row.workspace_id as WorkspaceId },
      windowDays,
    );
  });
}
