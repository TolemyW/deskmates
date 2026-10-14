// Authenticated operator cost report. Registration happens inside the operator auth scope.

import {
  type BotId,
  COST_RANKING_PAGE_SIZE,
  COST_ROWS_PAGE_SIZE,
  type CostQuery,
  type CostRankingDimension,
  type CostRankingMetric,
  type CostRowPage,
  DeskmatesError,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { CostQueryStore } from "../ledger/costs.js";
import { keysetPage, parseCursorQuery, parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";

/** A ranking: ten entries a page (ADR-0032 decision 9), at most 100 (#113). */
export const COST_RANKING_PAGE: PageLimitPolicy = {
  default: COST_RANKING_PAGE_SIZE,
  max: PAGE_LIMIT_MAX,
};
/** Activity rows: ten a page, at most 100 (#113). */
export const COST_ROWS_PAGE: PageLimitPolicy = {
  default: COST_ROWS_PAGE_SIZE,
  max: PAGE_LIMIT_MAX,
};

interface CostQuerystring {
  from?: string;
  to?: string;
  workspaceId?: string;
  botId?: string;
  model?: string;
}

interface RankingQuerystring extends CostQuerystring {
  by?: string;
  metric?: string;
  offset?: string;
  limit?: string;
}

interface RowsQuerystring extends CostQuerystring {
  cursor?: string;
  limit?: string;
}

function date(value: string | undefined, name: "from" | "to"): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DeskmatesError("validation", `${name} must be YYYY-MM-DD`, { [name]: value });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DeskmatesError("validation", `${name} must be a real calendar date`, {
      [name]: value,
    });
  }
  return value;
}

function costQuery(q: CostQuerystring): CostQuery {
  const from = date(q.from, "from");
  const to = date(q.to, "to");
  if (from && to && from > to) {
    throw new DeskmatesError("validation", "from must be on or before to", { from, to });
  }
  const model = q.model?.trim();
  if (q.model !== undefined && !model) {
    throw new DeskmatesError("validation", "model must not be empty");
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(q.workspaceId ? { workspaceId: q.workspaceId as WorkspaceId } : {}),
    ...(q.botId ? { botId: q.botId as BotId } : {}),
    ...(model ? { model } : {}),
  };
}

const DIMENSIONS: readonly CostRankingDimension[] = ["model", "bot", "workspace"];
const METRICS: readonly CostRankingMetric[] = ["money", "usage"];

export function registerCostRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const costs = new CostQueryStore(ctx.db);
  // The summary: totals and days over the whole filtered range, never rows (#113).
  app.get<{ Querystring: CostQuerystring }>("/api/costs", async (request) =>
    costs.summary(requestTenant(request), costQuery(request.query)),
  );
  // The Activity rows, one keyset page at a time (#113). The cursor is bound to the tenant and
  // the filters, so it cannot be replayed under another range.
  app.get<{ Querystring: RowsQuerystring }>(
    "/api/costs/rows",
    async (request): Promise<CostRowPage> => {
      const { cursor, limit: rawLimit, ...rest } = request.query;
      const tenantId = requestTenant(request);
      const filters = costQuery(rest);
      const scope = [
        tenantId,
        "cost-rows",
        filters.from ?? null,
        filters.to ?? null,
        filters.workspaceId ?? null,
        filters.botId ?? null,
        filters.model ?? null,
      ];
      const { limit, after } = parseCursorQuery(
        { cursor, limit: rawLimit },
        COST_ROWS_PAGE,
        scope,
        ["string", "string", "string", "string"],
      );
      const page = costs.rowPage(
        tenantId,
        filters,
        limit,
        after as [string, string, string, string] | undefined,
      );
      const { items, nextCursor } = keysetPage(
        page.rows,
        limit,
        (row) => [row.day, row.botName, row.botId, row.model],
        scope,
      );
      return { filters, rows: items, total: page.total, ...(nextCursor ? { nextCursor } : {}) };
    },
  );
  // ADR-0032 decision 9: one ranking, grouped over the whole range, ten entries a page.
  app.get<{ Querystring: RankingQuerystring }>("/api/costs/ranking", async (request) => {
    const {
      by = "model",
      metric = "money",
      offset: rawOffset,
      limit: rawLimit,
      ...rest
    } = request.query;
    if (!DIMENSIONS.includes(by as CostRankingDimension))
      throw new DeskmatesError("validation", "by must be model, bot or workspace", { by });
    if (!METRICS.includes(metric as CostRankingMetric))
      throw new DeskmatesError("validation", "metric must be money or usage", { metric });
    const { offset, limit } = parseOffsetQuery(
      { offset: rawOffset, limit: rawLimit },
      COST_RANKING_PAGE,
    );
    return costs.ranking(
      requestTenant(request),
      costQuery(rest),
      by as CostRankingDimension,
      metric as CostRankingMetric,
      offset,
      limit,
    );
  });
}
