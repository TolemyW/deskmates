// T0 wire golden for the workspace limits API: every method's exact request and how its answer,
// a 401 and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it
// with `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type LimitsApi, createLimitsApi } from "./api.js";

const CASES: GoldenCases<LimitsApi> = {
  getWorkspaceLimits: (a) => a.getWorkspaceLimits(WS),
  setWorkspaceLimits: (a) => a.setWorkspaceLimits(WS, { turnBudget: 12, relayCountMax: null }),
};

describe("limits API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createLimitsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
