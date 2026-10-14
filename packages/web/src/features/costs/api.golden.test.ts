// T0 wire golden for the costs API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, RUN, WS, wireGolden } from "../../platform/http-golden.js";
import { type CostsApi, createCostsApi } from "./api.js";

const CASES: GoldenCases<CostsApi> = {
  acknowledgeCostAlert: (a) => a.acknowledgeCostAlert("alert/1"),
  continueBudget: (a) => a.continueBudget(WS, [RUN]),
  createCostAlertRule: (a) =>
    a.createCostAlertRule({ kind: "known_cost", window: "day", thresholdUsd: 2 }),
  deleteCostAlertRule: (a) => a.deleteCostAlertRule("rule/2"),
  getCostRanking: (a) => a.getCostRanking("bot", "money", { from: "2026-10-01" }, 10),
  getCostRows: (a) =>
    a.getCostRows({ from: "2026-10-01", botId: BOT }, { cursor: "c/1", limit: 10 }),
  getCosts: (a) => a.getCosts({ from: "2026-10-01", botId: BOT, model: "" }),
  listBudgets: (a) => a.listBudgets(),
  listCostAlertRules: (a) => a.listCostAlertRules({ offset: 25, limit: 25 }),
  listCostAlerts: (a) => a.listCostAlerts("open", { cursor: "c/2", limit: 10 }),
  setBudget: (a) => a.setBudget(WS, { weeklyLimitUsd: 5, cumulativeLimitUsd: null }),
};

describe("costs API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createCostsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
