// T0 wire golden for the published-apps API (ADR-0035): every method's exact request and how its
// answer, a 401 and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate
// it with `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type AppSharesApi, createAppSharesApi } from "./api.js";

const CASES: GoldenCases<AppSharesApi> = {
  listAppShares: (a) => a.listAppShares(WS),
  openAppShare: (a) => a.openAppShare(WS, "app_1", "/todos/7"),
  publishAppShare: (a) => a.publishAppShare(WS, 3000, "Todo app"),
  revokeAppShare: (a) => a.revokeAppShare(WS, "app_1"),
};

describe("app-shares API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createAppSharesApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
