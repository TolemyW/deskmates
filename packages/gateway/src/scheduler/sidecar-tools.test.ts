// T0: the sidecar tool list a run is started with.

import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { sidecarToolsFor } from "./sidecar-tools.js";

const apps: ReturnType<typeof buildGateway>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function defaultRunConfig(): Promise<Record<string, unknown>> {
  const app = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  return app.deskmates.ctx.runConfig();
}

describe("sidecarToolsFor", () => {
  // The one deliberate tripwire: this is the single place that goes red when a new tool reaches
  // the sidecar under the default config. Every other test derives its expectation through
  // `sidecarToolsFor`, so update this literal list, and only this one, when a tool is added.
  it("pins the full list for the default run config", async () => {
    const config = await defaultRunConfig();
    expect(sidecarToolsFor(true, config)).toEqual([
      "thread_post",
      "message_bot",
      "approval_decide",
      "knowledge_search",
      "knowledge_read",
      "knowledge_propose",
      "memory_search",
      "tty_session",
    ]);
    expect(sidecarToolsFor(false, config)).toEqual([
      "message_bot",
      "knowledge_search",
      "knowledge_read",
      "knowledge_propose",
      "memory_search",
      "tty_session",
    ]);
  });

  it("omits tty_session when the run has no ttyVersion", () => {
    expect(sidecarToolsFor(false, {})).toEqual([
      "message_bot",
      "knowledge_search",
      "knowledge_read",
      "knowledge_propose",
    ]);
  });

  it("adds browser_cli_workflow in vision-cli-v2 mode", () => {
    expect(sidecarToolsFor(true, { ttyVersion: 1, browserExecutionMode: "vision-cli-v2" })).toEqual(
      [
        "thread_post",
        "message_bot",
        "approval_decide",
        "knowledge_search",
        "knowledge_read",
        "knowledge_propose",
        "tty_session",
        "browser_cli_workflow",
      ],
    );
  });
});

describe("connector tools (ADR-0012 item 3)", () => {
  it("adds the five connector tools only for a bot that names a connector", async () => {
    const config = await defaultRunConfig();
    expect(config).toMatchObject({ connectorVersion: 1, connectorValidationTtlSeconds: 900 });
    expect(sidecarToolsFor(true, config, true).slice(-5)).toEqual([
      "connector_describe",
      "connector_validate",
      "connector_submit",
      "connector_status",
      "connector_receipt",
    ]);
    expect(sidecarToolsFor(true, config, false)).toEqual(sidecarToolsFor(true, config));
  });

  it("offers none on a run whose config predates connectors", () => {
    expect(sidecarToolsFor(false, { ttyVersion: 1 }, true)).not.toContain("connector_submit");
  });
});

describe("integration tools (ADR-0013 item 5)", () => {
  it("adds the five integration tools only with a usable connection and a configured runtime", async () => {
    const config = { ...(await defaultRunConfig()), integrationVersion: 1 };
    expect(sidecarToolsFor(true, config, false, true).slice(-5)).toEqual([
      "integration_apps",
      "integration_connections",
      "integration_search",
      "integration_guide",
      "integration_execute",
    ]);
    expect(sidecarToolsFor(true, config, false, false)).toEqual(sidecarToolsFor(true, config));
  });

  it("offers none on a run whose config carries no integration version", async () => {
    const config = await defaultRunConfig();
    expect(config).not.toHaveProperty("integrationVersion");
    expect(sidecarToolsFor(true, config, false, true)).not.toContain("integration_execute");
  });
});

describe("task_deliver (ADR-0021 amendment 2)", () => {
  it("is offered only when an open task is linked to the run or its thread", async () => {
    const config = await defaultRunConfig();
    for (const hasThread of [true, false]) {
      expect(sidecarToolsFor(hasThread, config, false, false, true)).toEqual([
        ...sidecarToolsFor(hasThread, config),
        "task_deliver",
      ]);
      expect(sidecarToolsFor(hasThread, config, false, false, false)).not.toContain("task_deliver");
    }
  });
});
