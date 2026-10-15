// T0: what a run records about its models' upstreams at start (ADR-0039 decision 4). The T1 half
// (a started run carries the record) is in `model-proxy/upstream-routing.test.ts`.

import { describe, expect, it } from "vitest";
import { testConfig } from "../test-support/harness.js";
import { modelUpstreamsOf } from "./model-upstream-freeze.js";

describe("modelUpstreamsOf", () => {
  it("maps each frozen model to its upstream id, null when none serves it", () => {
    const config = testConfig({
      modelBaseUrl: "",
      modelAuthToken: "",
      modelUpstreams: [
        { id: "local", baseUrl: "http://local.test", models: ["local-27b"], protocol: "anthropic" },
      ],
    });
    expect(modelUpstreamsOf({ config }, ["local-27b", "retired", undefined, "local-27b"])).toEqual({
      "local-27b": "local",
      retired: null,
    });
  });

  it("names the default upstream for everything unlisted when MODEL_BASE_URL is set", () => {
    expect(modelUpstreamsOf({ config: testConfig() }, ["a", "b"])).toEqual({
      a: "default",
      b: "default",
    });
  });
});
