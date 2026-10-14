// T1: what a run is started with (ADR-0013 items 4 and 5). The five integration tools are offered
// only when the run's workspace has a usable connection and a runtime is configured; the start
// request carries a connection count and nothing else about the runtime (no URL, admin token,
// workspace runtime token or API key), and the sandbox environment gains nothing.

import { INTEGRATION_TOOL_NAMES, type StartRunRequest } from "@deskmates/contracts";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { TEST_SECRETS_KEY } from "../test-support/connector-fixture.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import {
  GITEA_KEY_A,
  RUNTIME_ADMIN_TOKEN,
  RUNTIME_URL,
} from "../test-support/integration-fixture.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function runOnce(h: Harness, threadId: string): Promise<StartRunRequest> {
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "ok",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    });
  });
  const before = h.provider.execCalls.length;
  const m = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${threadId}/messages`, {
    body: "go",
  });
  const run = m.json.runs[0] as RunRecord;
  await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded", 3000, "run");
  return h.provider.execCalls[before]?.request as StartRunRequest;
}

describe("start request and integrations", () => {
  it("offers the tools with a connection and carries no runtime secret", async () => {
    const fake = new FakeIntegrationRuntime({
      baseUrl: RUNTIME_URL,
      adminToken: RUNTIME_ADMIN_TOKEN,
    });
    const h = await startHarness(
      {
        secretsKey: TEST_SECRETS_KEY,
        integrationRuntime: { url: RUNTIME_URL, adminToken: RUNTIME_ADMIN_TOKEN },
      },
      undefined,
      { integrationFetch: fake.fetch },
    );
    harnesses.push(h);
    const { workspace, thread } = await h.seed();

    const without = await runOnce(h, thread.id);
    expect(without.tools.some((t) => t.startsWith("integration_"))).toBe(false);
    expect(without.integrationConnections).toBeUndefined();

    await h.api("POST", "/api/integrations/providers", { service: "gitea" });
    const created = await h.api(
      "POST",
      `/api/integrations/workspaces/${workspace.id}/connections/api-key`,
      {
        service: "gitea",
        connectionName: "main",
        apiKey: GITEA_KEY_A,
      },
    );
    expect(created.status).toBe(201);
    const withConn = await runOnce(h, thread.id);
    expect(withConn.integrationConnections).toBe(1);
    for (const name of INTEGRATION_TOOL_NAMES) expect(withConn.tools).toContain(name);

    const text = JSON.stringify(withConn);
    const runtimeToken = fake.tokenNamed(`deskmates-workspace-${workspace.id}`)?.token as string;
    expect(runtimeToken).toMatch(/^oct_/);
    for (const secret of [
      RUNTIME_URL,
      "integration-runtime.internal",
      RUNTIME_ADMIN_TOKEN,
      runtimeToken,
      GITEA_KEY_A,
    ])
      expect(text).not.toContain(secret);
    const env = JSON.stringify(h.provider.created.map((spec) => spec.env));
    for (const secret of [RUNTIME_URL, RUNTIME_ADMIN_TOKEN, runtimeToken, GITEA_KEY_A])
      expect(env).not.toContain(secret);
    expect(
      h.app.deskmates.ctx.runs.mustGet(
        h.provider.execCalls.at(-1)?.request.runId as RunRecord["id"],
      ).config,
    ).toMatchObject({
      integrationVersion: 1,
    });
  });

  it("offers nothing and records no integration knob when no runtime is configured", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { thread } = await h.seed();
    const req = await runOnce(h, thread.id);
    expect(req.tools.some((t) => t.startsWith("integration_"))).toBe(false);
    expect(h.app.deskmates.ctx.runConfig()).not.toHaveProperty("integrationVersion");
    const status = await h.api<{ configured: boolean }>("GET", "/api/integrations");
    expect(status.json.configured).toBe(false);
    const refused = await h.api<{ code: string }>("POST", "/api/integrations/providers", {
      service: "gitea",
    });
    expect(refused.status).toBe(503);
    expect(refused.json.code).toBe("integration_unavailable");
  });
});
