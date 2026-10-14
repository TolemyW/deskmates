import { afterEach, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

it("requires operator review, attributes proposals to the authenticated run, and isolates credentials", async () => {
  const sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  const operator = buildOperatorGateway(sandbox.deskmates);
  apps.push(operator, sandbox);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  const ctx = sandbox.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "knowledge", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ name: "writer", role: "test", workspaceId: workspace.id });
  const run = ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: "test",
    triggerPayload: { body: "reference" },
    config: ctx.runConfig(),
  });
  const headers = { authorization: `Bearer ${ctx.tokens.issue(run.id).token}` };
  const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
  const base = `/internal/runs/${run.id}/knowledge`;
  const proposed = await sandbox.inject({
    method: "POST",
    url: `${base}/proposals`,
    headers,
    payload: { title: "Refund", body: "verifiedreference", sourceRunId: "forged" },
  });
  expect(proposed.statusCode).toBe(201);
  const proposal = proposed.json().proposal;
  expect(proposal.sourceRunId).toBe(run.id);
  expect(
    (
      await sandbox.inject({ method: "GET", url: `${base}/search?q=verifiedreference`, headers })
    ).json().documents,
  ).toEqual([]);
  expect(
    (
      await operator.inject({
        method: "POST",
        url: `/api/knowledge/proposals/${proposal.id}/review`,
        headers,
        payload: { decision: "approve" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await sandbox.inject({
        method: "GET",
        url: `${base}/search?q=verifiedreference`,
        headers: human,
      })
    ).statusCode,
  ).toBe(401);
  const reviewed = await operator.inject({
    method: "POST",
    url: `/api/knowledge/proposals/${proposal.id}/review`,
    headers: human,
    payload: { decision: "approve" },
  });
  expect(reviewed.statusCode).toBe(200);
  const documentId = reviewed.json().proposal.documentId;
  const search = await sandbox.inject({
    method: "GET",
    url: `${base}/search?q=verifiedreference`,
    headers,
  });
  expect(search.json().documents).toMatchObject([{ id: documentId, version: 1 }]);
  expect(
    (await sandbox.inject({ method: "GET", url: `${base}/${documentId}`, headers })).json().document
      .body,
  ).toBe("verifiedreference");
  const edit = await operator.inject({
    method: "PATCH",
    url: `/api/knowledge/${documentId}`,
    headers: human,
    payload: { title: "Refund", body: "replacement", version: 1 },
  });
  expect(edit.statusCode).toBe(200);
  expect(
    (
      await operator.inject({
        method: "PATCH",
        url: `/api/knowledge/${documentId}`,
        headers: human,
        payload: { title: "Stale", body: "discarded", version: 1 },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await operator.inject({
        method: "GET",
        url: `/api/knowledge/${documentId}/export`,
        headers: human,
      })
    ).body,
  ).toBe("replacement");
  expect(
    (
      await sandbox.inject({
        method: "GET",
        url: "/internal/runs/not-this-run/knowledge/search?q=reference",
        headers,
      })
    ).statusCode,
  ).toBe(401);
});
