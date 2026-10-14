// T0 wire golden for the config API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/config-api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, exerciseCase, wireGolden } from "../platform/http-golden.js";
import { type ConfigApi, createConfigApi } from "./config-api.js";

const CASES: GoldenCases<ConfigApi> = {
  getConfig: (a) => a.getConfig(),
};

describe("config API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createConfigApi, CASES)).toMatchFileSnapshot(
      "./__golden__/config-api.golden.txt",
    );
  });

  it("turns a thrown fetch into a network ApiError", async () => {
    const network = await exerciseCase(createConfigApi, CASES.getConfig, "network");
    expect(network.outcome).toEqual({
      rejected: {
        error: "ApiError",
        code: "network",
        message: "Failed to fetch",
        status: 0,
        details: {},
      },
    });
    expect(network.unauthorized).toBe(0);
  });
});
