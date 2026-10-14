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
    });
  });

  it("leaks neither the upstream base URL nor the upstream auth token", async () => {
    h = await startHarness();
    const raw = await (await fetch(`${h.baseUrl}/api/config`)).text();
    expect(raw).not.toContain(testConfig().modelBaseUrl);
    expect(raw).not.toContain(TEST_UPSTREAM_TOKEN);
  });
});
