// Operator routes for cost alert rules and fired alerts (ADR-0018 decisions 4 and 5). Registered
// inside the operator auth scope like every other `/api/*` route.

import {
  type BotId,
  type CostAlertPage,
  type CostAlertRulePage,
  DeskmatesError,
  PAGE_LIMIT_MAX,
  type PageLimitPolicy,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import type { CostAlertStatus } from "../ledger/cost-alerts.js";
import { requestActorId } from "./actor.js";
import { encodeCursor, parseCursorQuery, parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { asRecord, optionalString } from "./validate.js";
import { readableWorkspaceIds } from "./workspace-access.js";

/** Fired alerts: ten a page, at most 100 (#113). */
export const COST_ALERT_PAGE: PageLimitPolicy = { default: 10, max: PAGE_LIMIT_MAX };
/** Alert rules: 25 a page, at most 100 (#113). */
export const COST_ALERT_RULE_PAGE: PageLimitPolicy = { default: 25, max: PAGE_LIMIT_MAX };

/** The part of a cursor's scope that names who may read what: sorted readable ids, or all. */
function readableScope(readable: ReadonlySet<string> | undefined): string {
  return readable === undefined ? "*" : [...readable].sort().join(",");
}

function alertStatus(raw: string | undefined): CostAlertStatus {
  if (raw === undefined || raw === "open") return "open";
  if (raw === "acknowledged" || raw === "all") return raw;
  throw new DeskmatesError("validation", "status must be open, acknowledged or all", {
    status: raw,
  });
}

export function registerCostAlertRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  // Rules and alerts of a workspace reach its Members only (ADR-0022 amendment 6 W1).
  // One page of rules, oldest first, with the total; the readable scope is applied before
  // paging so a page is never short (#113).
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/cost-alert-rules",
    async (request): Promise<CostAlertRulePage> => {
      const readable = readableWorkspaceIds(ctx, request, "member");
      const { offset, limit } = parseOffsetQuery(request.query, COST_ALERT_RULE_PAGE);
      const page = ctx.costAlerts.rulePage(requestTenant(request), readable, offset, limit);
      return { rules: page.rules, offset, limit, total: page.total };
    },
  );

  app.post("/api/cost-alert-rules", async (request, reply) => {
    const body = asRecord(request.body);
    const botId = optionalString(body, "botId");
    if (botId) ctx.bots.mustGet(botId as BotId);
    const workspaceId = optionalString(body, "workspaceId");
    const threshold = body.thresholdUsd;
    if (threshold !== undefined && threshold !== null && typeof threshold !== "number") {
      throw new DeskmatesError("validation", "thresholdUsd must be a number");
    }
    const authorId = requestActorId(request, body);
    const rule = ctx.costAlerts.createRule(requestTenant(request), {
      // The store validates the vocabulary; the casts only name the field types.
      kind: body.kind as "known_cost" | "unpriced_usage",
      window: body.window as "day" | "month",
      ...(botId ? { botId: botId as BotId } : {}),
      ...(workspaceId ? { workspaceId: workspaceId as WorkspaceId } : {}),
      ...(typeof threshold === "number" ? { thresholdUsd: threshold } : {}),
      createdBy: decidedByHuman(authorId),
    });
    return reply.code(201).send({ rule });
  });

  app.delete<{ Params: { id: string } }>("/api/cost-alert-rules/:id", async (request) => {
    const actor = decidedByHuman(requestActorId(request, request.body ?? {}));
    if (!ctx.costAlerts.deleteRule(requestTenant(request), request.params.id, actor)) {
      throw new DeskmatesError("not_found", `cost alert rule ${request.params.id} not found`, {
        ruleId: request.params.id,
      });
    }
    return { deleted: true };
  });

  // One keyset page of alerts, newest first; `total` counts every alert under the same status
  // and readable scope, which is the open badge (#113).
  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/api/cost-alerts",
    async (request): Promise<CostAlertPage> => {
      const readable = readableWorkspaceIds(ctx, request, "member");
      const tenantId = requestTenant(request);
      const status = alertStatus(request.query.status);
      const scope = [tenantId, "cost-alerts", status, readableScope(readable)];
      const { limit, after } = parseCursorQuery(request.query, COST_ALERT_PAGE, scope, [
        "string",
        "string",
      ]);
      const page = ctx.costAlerts.alertPage(
        tenantId,
        status,
        readable,
        limit,
        after as [string, string] | undefined,
      );
      const alerts = page.alerts.slice(0, limit);
      const last = alerts.at(-1);
      return {
        alerts,
        total: page.total,
        ...(page.alerts.length > limit && last
          ? { nextCursor: encodeCursor([last.firedAt, last.id], scope) }
          : {}),
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/cost-alerts/:id/acknowledge", async (request) => {
    const body = request.body === undefined || request.body === null ? {} : asRecord(request.body);
    const authorId = requestActorId(request, body);
    return {
      alert: ctx.costAlerts.acknowledge(
        requestTenant(request),
        request.params.id,
        decidedByHuman(authorId),
      ),
    };
  });
}
