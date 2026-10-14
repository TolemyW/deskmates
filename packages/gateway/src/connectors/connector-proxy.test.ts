// T1 stack test: the Gateway is the only caller of a connector (ADR-0012 item 2, verification
// row 2). A run is started through the real scheduler with a bot that names a connector; the
// sandbox environment and the start request carry no connector URL or credential; the scripted
// sidecar reaches the connector only through its run's routes, and every request the connector
// sees came through the Gateway's proxy with the Gateway-held credential.

import type {
  BotDefinition,
  ConnectorRegistration,
  ConnectorSubmitResponse,
  RunSummary,
  StartRunRequest,
  StoredConnectorValidation,
  Workspace,
} from "@deskmates/contracts";
import { FakeConnector } from "@deskmates/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CREDENTIAL,
  CONNECTOR_URL,
  TEST_SECRETS_KEY,
} from "../test-support/connector-fixture.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const summary = (reply: string): RunSummary => ({
  done: "used the connector",
  filesChanged: [],
  sitesVisited: [],
  pendingApprovals: [],
  memorySuggestions: [],
  reply,
});

async function stack() {
  const fake = new FakeConnector({ baseUrl: CONNECTOR_URL, credential: CONNECTOR_CREDENTIAL });
  const h = await startHarness({ secretsKey: TEST_SECRETS_KEY }, undefined, {
    connectorFetch: fake.fetch,
  });
  harnesses.push(h);
  const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name: "db",
    egressAllowlist: ["ops.example.test"],
  });
  const connector = await h.api<{ connector: ConnectorRegistration }>("POST", "/api/connectors", {
    workspaceId: ws.json.workspace.id,
    name: "tickets",
    url: CONNECTOR_URL,
    credential: CONNECTOR_CREDENTIAL,
  });
  expect(connector.status).toBe(201);
  const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: "tester",
    workspaceId: ws.json.workspace.id,
    connectors: ["tickets"],
  });
  return {
    h,
    fake,
    workspace: ws.json.workspace,
    bot: bot.json.bot,
    connector: connector.json.connector,
  };
}

describe("the Gateway is the only caller of a connector", () => {
  it("keeps the endpoint and credential out of the sandbox and routes calls through the proxy", async () => {
    const { h, fake, workspace, bot } = await stack();
    const seen: { validation?: StoredConnectorValidation; submit?: ConnectorSubmitResponse } = {};
    h.provider.onRun(async (req, gw) => {
      const v = await gw.post("connectors/tickets/validate", {
        submission: { operation: "select", statement: "SELECT 1" },
      });
      seen.validation = ((await v.json()) as { validation: StoredConnectorValidation }).validation;
      const s = await gw.post("connectors/tickets/submit", {
        validationId: seen.validation.validationId,
        contentHash: seen.validation.contentHash,
      });
      seen.submit = (await s.json()) as ConnectorSubmitResponse;
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("done"),
        usage: [],
      });
    });
    const thread = await h.api<{ thread: { id: string } }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id],
    });
    const posted = await h.api<{ runs: { id: string }[] }>(
      "POST",
      `/api/threads/${thread.json.thread.id}/messages`,
      { body: "run the query" },
    );
    const runId = posted.json.runs[0]?.id as string;
    await waitFor(
      () => h.app.deskmates.ctx.runs.get(runId as never)?.status === "succeeded",
      3000,
      "run",
    );

    // The sandbox environment and the start request name the connector, never where it is.
    const request = h.provider.execCalls[0]?.request as StartRunRequest;
    const stdin = h.provider.execCalls[0]?.req.stdin ?? "";
    const env = JSON.stringify(h.provider.created.map((c) => c.env));
    for (const secret of [CONNECTOR_URL, "tickets-db.connector.internal", CONNECTOR_CREDENTIAL]) {
      expect(stdin).not.toContain(secret);
      expect(env).not.toContain(secret);
    }
    expect(request.connectors).toEqual(["tickets"]);
    expect(request.tools).toEqual(
      expect.arrayContaining(["connector_validate", "connector_submit"]),
    );
    const sqlSkill = request.skills?.find((skill) => skill.name === "sql-analysis");
    expect(sqlSkill?.files.find((file) => file.path === "SKILL.md")?.content).toContain(
      "Use the registered database connector; never ask for or invent a connection string.",
    );
    expect(JSON.stringify(sqlSkill)).not.toContain(CONNECTOR_CREDENTIAL);

    // Every request the connector saw carried the Gateway-held credential.
    expect(seen.validation?.effect).toBe("read");
    expect(seen.submit?.duplicate).toBe(false);
    expect(fake.executions).toBe(1);
    expect(fake.requests.map((r) => new URL(r.url).pathname)).toEqual(["/validate", "/submit"]);
    for (const r of fake.requests)
      expect(r.headers.authorization).toBe(`Bearer ${CONNECTOR_CREDENTIAL}`);
  });

  it("keeps the SQL Starter Skill available but stops at setup guidance without a Connection", async () => {
    const h = await startHarness({ secretsKey: TEST_SECRETS_KEY });
    harnesses.push(h);
    const workspace = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "db-without-connection",
      egressAllowlist: ["ops.example.test"],
    });
    const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "analyst",
      workspaceId: workspace.json.workspace.id,
    });
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("Configure a database Connection in Integrations before running SQL."),
        usage: [],
      });
    });
    const thread = await h.api<{ thread: { id: string } }>("POST", "/api/threads", {
      workspaceId: workspace.json.workspace.id,
      botIds: [bot.json.bot.id],
    });
    const posted = await h.api<{ runs: { id: string }[] }>(
      "POST",
      `/api/threads/${thread.json.thread.id}/messages`,
      { body: "run the query" },
    );
    const runId = posted.json.runs[0]?.id as string;
    await waitFor(
      () => h.app.deskmates.ctx.runs.get(runId as never)?.status === "succeeded",
      3000,
      "run",
    );

    const request = h.provider.execCalls[0]?.request as StartRunRequest;
    const sqlSkill = request.skills?.find((skill) => skill.name === "sql-analysis");
    expect(sqlSkill?.files.find((file) => file.path === "SKILL.md")?.content).toContain(
      "register the workspace database from Integrations",
    );
    expect(request.connectors).toEqual([]);
    expect(request.tools.some((tool) => tool.startsWith("connector_"))).toBe(false);
  });

  it("confines a run token to its own run's connector routes and its own workspace", async () => {
    const { h, workspace, bot } = await stack();
    const ctx = h.app.deskmates.ctx;
    h.app.deskmates.scheduler.stop();
    const mkRun = (botId = bot.id) =>
      ctx.runs.create({
        botId,
        lane: "background",
        triggerKind: "webhook",
        triggerRef: "t",
        triggerPayload: { body: "x" },
        config: ctx.runConfig(),
      });
    const a = mkRun();
    const b = mkRun();
    const tokenA = ctx.tokens.issue(a.id).token;
    const call = (runId: string, token: string | undefined, connector = "tickets") =>
      fetch(`${h.baseUrl}/internal/runs/${runId}/connectors/${connector}/describe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      });
    expect((await call(a.id, tokenA)).status).toBe(200);
    expect((await call(b.id, tokenA)).status).toBe(403);
    expect((await call(a.id, undefined)).status).toBe(401);
    expect((await call(a.id, "cbt_unknown")).status).toBe(401);

    // A connector of another workspace, named by id, is outside this run's workspace.
    const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
    const foreign = ctx.connectors.register({
      workspaceId: other.id,
      name: "tickets",
      url: "http://other.connector.internal",
    });
    expect((await call(a.id, tokenA, foreign.id)).status).toBe(403);
    expect((await call(a.id, tokenA, "missing")).status).toBe(404);
    expect(workspace.id).not.toBe(other.id);
  });
});
