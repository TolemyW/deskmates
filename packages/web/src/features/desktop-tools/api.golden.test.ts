// T0 wire golden for the desktop tools API (ADR-0048 decision 1): every method's exact request and
// how its answer, a 401 and an error body surface. `__golden__/api.golden.txt` is the contract;
// regenerate it with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type DesktopToolsApi, createDesktopToolsApi } from "./api.js";

const CASES: GoldenCases<DesktopToolsApi> = {
  getWorkspaceDesktopTools: (a) => a.getWorkspaceDesktopTools(WS),
  setWorkspaceDesktopTools: (a) =>
    a.setWorkspaceDesktopTools(WS, { enabled: true, bots: { bot_1: true } }),
};

describe("desktop tools API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createDesktopToolsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
