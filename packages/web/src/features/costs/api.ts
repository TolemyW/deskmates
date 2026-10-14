// Costs, cost alerts and the workspace budget. Alerts are soft (ADR-0018); the budget parks work
// and only an explicit continue resumes it (ADR-0032).

import type {
  BotId,
  BudgetLimits,
  CostAlert,
  CostAlertKind,
  CostAlertPage,
  CostAlertRule,
  CostAlertRulePage,
  CostAlertWindow,
  CostQuery,
  CostRankingDimension,
  CostRankingMetric,
  CostRankingPage,
  CostReport,
  CostRowPage,
  RunId,
  WorkspaceBudget,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface CostsApi {
  acknowledgeCostAlert(id: string): Promise<CostAlert>;
  continueBudget(
    workspaceId: string,
    runIds?: readonly RunId[],
  ): Promise<{ continued: RunId[]; budget: WorkspaceBudget }>;
  createCostAlertRule(input: {
    kind: CostAlertKind;
    window: CostAlertWindow;
    /** The workspace of an every-bot rule; sent in the body (ADR-0031 Q3). */
    workspaceId?: string;
    botId?: BotId;
    thresholdUsd?: number;
  }): Promise<CostAlertRule>;
  deleteCostAlertRule(id: string): Promise<void>;
  getCostRanking(
    by: CostRankingDimension,
    metric: CostRankingMetric,
    filters?: CostQuery,
    offset?: number,
  ): Promise<CostRankingPage>;
  /** One keyset page of Activity rows over the filtered range, with the row count (#113). */
  getCostRows(
    filters?: CostQuery,
    page?: { cursor?: string; limit?: number },
  ): Promise<CostRowPage>;
  /** The summary of the filtered range: totals and days, never rows (#113). */
  getCosts(filters?: CostQuery): Promise<CostReport>;
  listBudgets(): Promise<WorkspaceBudget[]>;
  /** One page of alert rules, oldest first, with the total (#113). */
  listCostAlertRules(page?: { offset?: number; limit?: number }): Promise<CostAlertRulePage>;
  /** One keyset page of alerts, newest first; `total` is the count under the status (#113). */
  listCostAlerts(
    status?: "open" | "acknowledged" | "all",
    page?: { cursor?: string; limit?: number },
  ): Promise<CostAlertPage>;
  setBudget(workspaceId: string, limits: BudgetLimits): Promise<WorkspaceBudget>;
}

export function createCostsApi(t: HttpTransport): CostsApi {
  return {
    async acknowledgeCostAlert(id) {
      return (
        await t.json<{ alert: CostAlert }>(
          "POST",
          `/api/cost-alerts/${encodeURIComponent(id)}/acknowledge`,
          {},
        )
      ).alert;
    },
    continueBudget(workspaceId, runIds) {
      return t.json(
        "POST",
        `/api/budgets/${encodeURIComponent(workspaceId)}/continue`,
        runIds ? { runIds } : {},
      );
    },
    async createCostAlertRule(input) {
      return (
        await t.json<{ rule: CostAlertRule }>(
          "POST",
          "/api/cost-alert-rules",
          stripUndefined(input),
        )
      ).rule;
    },
    async deleteCostAlertRule(id) {
      await t.json<{ deleted: true }>("DELETE", `/api/cost-alert-rules/${encodeURIComponent(id)}`);
    },
    getCostRanking(by, metric, filters = {}, offset = 0) {
      return t.json(
        "GET",
        `/api/costs/ranking${query({ by, metric, ...filters, offset: offset || undefined })}`,
      );
    },
    getCostRows(filters = {}, page = {}) {
      return t.json("GET", `/api/costs/rows${query({ ...filters, ...page })}`);
    },
    getCosts(filters = {}) {
      return t.json("GET", `/api/costs${query({ ...filters })}`);
    },
    async listBudgets() {
      return (await t.json<{ budgets: WorkspaceBudget[] }>("GET", "/api/budgets")).budgets;
    },
    listCostAlertRules(page = {}) {
      return t.json("GET", `/api/cost-alert-rules${query({ ...page })}`);
    },
    listCostAlerts(status = "open", page = {}) {
      return t.json("GET", `/api/cost-alerts${query({ status, ...page })}`);
    },
    async setBudget(workspaceId, limits) {
      return (
        await t.json<{ budget: WorkspaceBudget }>(
          "PUT",
          `/api/budgets/${encodeURIComponent(workspaceId)}`,
          limits,
        )
      ).budget;
    },
  };
}
