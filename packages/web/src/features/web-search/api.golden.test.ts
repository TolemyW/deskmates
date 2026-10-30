// T0 wire golden for the web search API (ADR-0049 decision 4): every method's exact request and
// how its answer, a 401 and an error body surface. `__golden__/api.golden.txt` is the contract;
// regenerate it with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type WebSearchApi, createWebSearchApi } from "./api.js";

const CASES: GoldenCases<WebSearchApi> = {
  getWorkspaceWebSearch: (a) => a.getWorkspaceWebSearch(WS),
  setWorkspaceWebSearch: (a) => a.setWorkspaceWebSearch(WS, { enabled: true }),
};

describe("web search API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createWebSearchApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
