// T0 wire golden for the run_stats setting API (ADR-0050 decision 6): every method's exact request
// and how its answer, a 401 and an error body surface. `__golden__/api.golden.txt` is the contract;
// regenerate it with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type GoldenCases, wireGolden } from "../../platform/http-golden.js";
import { type RunStatsApi, createRunStatsApi } from "./api.js";

const CASES: GoldenCases<RunStatsApi> = {
  getBotRunStats: (a) => a.getBotRunStats("bot_1"),
  setBotRunStats: (a) => a.setBotRunStats("bot_1", true),
};

describe("run_stats API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createRunStatsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
