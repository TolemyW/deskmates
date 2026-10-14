// T1: every integration call is attributed in the ledger (ADR-0013 item 7). Each run call is a
// `tool_call` / `tool_result` pair with `source: "integration_proxy"`, the bot, service, action id,
// connection name and operationType; an execute also carries the runtime's execution id. The count
// of executions in the ledger equals the fake runtime's own log. Metric: unattributed executions, 0.

import type { RunEvent } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITEA_KEY_A,
  type IntegrationFixture,
  integrationFixture,
} from "../test-support/integration-fixture.js";

let f: IntegrationFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const proxyEvents = (fx: IntegrationFixture, runId: string): RunEvent[] =>
  fx.h.app.deskmates.ctx.events
    .list(runId as RunEvent["runId"])
    .filter((e) => e.payload.source === "integration_proxy");

describe("integration ledger attribution", () => {
  it("records a call and a result with the named fields for every run call", async () => {
    f = await integrationFixture();
    const fx = f;
    await fx.adopt("gitea");
    await fx.apiKey(fx.a, "main", GITEA_KEY_A);
    await fx.run(fx.a, "GET", "/apps");
    await fx.run(fx.a, "GET", "/connections");
    await fx.run(fx.a, "POST", "/search", { service: "gitea", query: "repositories" });
    await fx.run(fx.a, "POST", "/guide", { actionId: "gitea.list_my_repositories" });
    await fx.run(fx.a, "POST", "/execute", {
      actionId: "gitea.list_my_repositories",
      connectionName: "main",
      input: {},
    });
    const events = proxyEvents(fx, fx.a.run.id);
    expect(events.map((e) => `${e.kind}:${e.payload.operation}`)).toEqual([
      "tool_call:apps",
      "tool_result:apps",
      "tool_call:connections",
      "tool_result:connections",
      "tool_call:search",
      "tool_result:search",
      "tool_call:guide",
      "tool_result:guide",
      "tool_call:execute",
      "tool_result:execute",
    ]);
    for (const e of events) {
      expect(e.payload.botId).toBe(fx.a.bot.id);
      expect(e.payload.toolName).toBe(`mcp__deskmates__integration_${e.payload.operation}`);
    }
    const result = events.at(-1);
    expect(result?.payload).toMatchObject({
      service: "gitea",
      actionId: "gitea.list_my_repositories",
      connectionName: "main",
      operationType: "read",
      executionId: fx.fake.executions[0]?.executionId,
      isError: false,
    });
    // The ledger keeps the raw result, forged closing tag included; wrapping is the sidecar's job.
    expect(JSON.stringify(result?.payload.result)).toContain("</untrusted>");
    // Guide attribution names the action and its classification too.
    expect(events[7]?.payload).toMatchObject({
      actionId: "gitea.list_my_repositories",
      operationType: "read",
    });
  });

  it("counts exactly the runtime's executions, refusals attributed as errors", async () => {
    f = await integrationFixture();
    const fx = f;
    await fx.adopt("gitea");
    await fx.apiKey(fx.a, "main", GITEA_KEY_A);
    await fx.apiKey(fx.b, "main", GITEA_KEY_A);
    for (let i = 0; i < 3; i++)
      await fx.run(fx.a, "POST", "/execute", { actionId: "gitea.get_current_user", input: {} });
    await fx.run(fx.b, "POST", "/execute", { actionId: "gitea.list_my_repositories", input: {} });
    // Refused before the runtime: attributed, not executed.
    await fx.run(fx.a, "POST", "/execute", {
      actionId: "gitea.get_current_user",
      connectionName: "nope",
    });
    const executed = [fx.a, fx.b].flatMap((s) =>
      proxyEvents(fx, s.run.id).filter(
        (e) =>
          e.kind === "tool_result" &&
          e.payload.operation === "execute" &&
          e.payload.isError === false &&
          typeof e.payload.executionId === "string",
      ),
    );
    expect(executed).toHaveLength(fx.fake.executions.length);
    expect(new Set(executed.map((e) => e.payload.executionId))).toEqual(
      new Set(fx.fake.executions.map((x) => x.executionId)),
    );
    const refusals = proxyEvents(fx, fx.a.run.id).filter(
      (e) => e.kind === "tool_result" && e.payload.isError === true,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.payload.error).toMatchObject({
      code: "integration_connection_not_allowed",
    });
  });
});
