// T1: `GET /api/config`. This route is the only thing that exposes Gateway configuration to the
// UI, and it must never grow a secret: the rest of `GatewayConfig` holds the upstream model
// address and the upstream auth token, neither of which may ever reach a browser. The deep-equal
// below is the guard — a new key added to the response fails this test.

import type { OperatorConfig } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  TEST_UPSTREAM_TOKEN,
  startHarness,
  testConfig,
} from "../test-support/harness.js";

let h: Harness;

afterEach(async () => {
  await h.close();
});

describe("GET /api/config", () => {
  it("serves exactly the two configured model ids and a null release when none is set", async () => {
    h = await startHarness();
    const res = await h.api<OperatorConfig>("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      defaultModel: testConfig().defaultModel,
      cheapModel: testConfig().cheapModel,
      release: null,
      cronTimeZone: "UTC",
      models: [
        { model: testConfig().cheapModel, upstream: "default" },
        { model: testConfig().defaultModel, upstream: "default" },
      ],
    });
  });

  it("reports the running release from DESKMATES_RELEASE", async () => {
    h = await startHarness({ release: "v0.2.0" });
    const res = await h.api<OperatorConfig>("GET", "/api/config");
    expect(res.json).toEqual({
      defaultModel: testConfig().defaultModel,
      cheapModel: testConfig().cheapModel,
      release: "v0.2.0",
      cronTimeZone: "UTC",
      models: expect.any(Array),
    });
  });

  it("leaks neither the upstream base URL nor the upstream auth token", async () => {
    h = await startHarness();
    const raw = await (await fetch(`${h.baseUrl}/api/config`)).text();
    expect(raw).not.toContain(testConfig().modelBaseUrl);
    expect(raw).not.toContain(TEST_UPSTREAM_TOKEN);
  });

  it("lists registered models with upstream ids, never a URL or token (ADR-0039)", async () => {
    h = await startHarness({
      cheapModel: "local-27b",
      modelUpstreams: [
        {
          id: "local",
          baseUrl: "http://10.20.50.16:8004",
          models: ["local-27b"],
          protocol: "anthropic",
        },
        {
          id: "vl",
          baseUrl: "http://10.20.50.16:8005",
          authToken: "vl-token-never-in-a-response",
          models: ["local-vl"],
          protocol: "anthropic",
        },
      ],
    });
    const res = await h.api<OperatorConfig>("GET", "/api/config");
    expect(res.json.models).toEqual([
      { model: "local-27b", upstream: "local" },
      { model: "local-vl", upstream: "vl" },
      { model: testConfig().defaultModel, upstream: "default" },
    ]);
    const raw = await (await fetch(`${h.baseUrl}/api/config`)).text();
    for (const secret of ["10.20.50.16", "vl-token-never-in-a-response", TEST_UPSTREAM_TOKEN])
      expect(raw).not.toContain(secret);
  });
});
