// T0 wire golden for the working-directory settings API (ADR-0036, ADR-0038): every method's exact request
// and how its answer, a 401 and an error body surface. `__golden__/api.golden.txt` is the
// contract; regenerate it with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type WorkdirApi, createWorkdirApi } from "./api.js";

const CASES: GoldenCases<WorkdirApi> = {
  getWorkspaceWorkdir: (a) => a.getWorkspaceWorkdir(WS),
  setWorkspaceWorkdir: (a) => a.setWorkspaceWorkdir(WS, { mode: "shared", laneNotice: null }),
};

describe("workdir API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createWorkdirApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
