// T1 fixture for the integrations module (ADR-0013): a Gateway on the combined test listener whose
// integration runtime is the testkit fake, two workspaces each with a bot and a run, and helpers
// for the operator API and the run routes. Dev-only.

import type { BotDefinition, IntegrationConnection, Workspace } from "@deskmates/contracts";
import { FakeIntegrationRuntime } from "@deskmates/testkit";
import type { RunRecord } from "../ledger/runs.js";
import { TEST_SECRETS_KEY } from "./connector-fixture.js";
import { type Harness, startHarness } from "./harness.js";

export const RUNTIME_URL = "http://integration-runtime.internal:3000";
export const RUNTIME_ADMIN_TOKEN = "runtime-admin-token-do-not-store-5e1f";
export const CALLBACK_URL = "https://gateway.example.test/api/integrations/oauth/callback";
export const GITEA_KEY_A = "gitea-api-key-a-do-not-store-71c2";
export const GITEA_KEY_B = "gitea-api-key-b-do-not-store-83d4";

export interface Side {
  workspace: Workspace;
  bot: BotDefinition;
  run: RunRecord;
  token: string;
}

export interface IntegrationFixture {
  h: Harness;
  fake: FakeIntegrationRuntime;
  a: Side;
  b: Side;
  adopt(service: string): Promise<void>;
  apiKey(side: Side, name: string, key: string, service?: string): Promise<IntegrationConnection>;
  /** Call a run route as `side`'s run, with its run token. */
  run<T>(
    side: Side,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }>;
  close(): Promise<void>;
}

export interface IntegrationFixtureOptions {
  callbackUrl?: string | null;
  mcpResponse?: "sse" | "json";
}

export async function integrationFixture(
  opts: IntegrationFixtureOptions = {},
): Promise<IntegrationFixture> {
  const fake = new FakeIntegrationRuntime({
    baseUrl: RUNTIME_URL,
    adminToken: RUNTIME_ADMIN_TOKEN,
    ...(opts.mcpResponse ? { mcpResponse: opts.mcpResponse } : {}),
  });
  const callback = opts.callbackUrl === null ? undefined : (opts.callbackUrl ?? CALLBACK_URL);
  const h = await startHarness(
    {
      secretsKey: TEST_SECRETS_KEY,
      integrationRuntime: {
        url: RUNTIME_URL,
        adminToken: RUNTIME_ADMIN_TOKEN,
        ...(callback === undefined ? {} : { oauthCallbackUrl: callback }),
      },
    },
    undefined,
    { integrationFetch: fake.fetch },
  );
  // Runs here are driven by hand; the scheduler must not start sidecars for them.
  h.app.deskmates.scheduler.stop();
  const ctx = h.app.deskmates.ctx;
  const side = (name: string): Side => {
    const workspace = ctx.workspaces.create({ name, sandboxProvider: "docker" });
    const bot = ctx.bots.create({ name: `${name}-bot`, role: "ops", workspaceId: workspace.id });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "integration-test",
      triggerPayload: { body: "x" },
      config: ctx.runConfig(),
    });
    return { workspace, bot, run, token: ctx.tokens.issue(run.id).token };
  };
  const a = side("ws-a");
  const b = side("ws-b");
  return {
    h,
    fake,
    a,
    b,
    adopt: async (service) => {
      const res = await h.api("POST", "/api/integrations/providers", { service });
      if (res.status !== 201) throw new Error(`adopt ${service}: ${JSON.stringify(res.json)}`);
    },
    apiKey: async (s, name, key, service = "gitea") => {
      const res = await h.api<{ connection: IntegrationConnection }>(
        "POST",
        `/api/integrations/workspaces/${s.workspace.id}/connections/api-key`,
        { service, connectionName: name, apiKey: key, values: { baseUrl: "http://gitea.test" } },
      );
      if (res.status !== 201) throw new Error(`api key ${name}: ${JSON.stringify(res.json)}`);
      return res.json.connection;
    },
    run: async <T>(s: Side, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${h.baseUrl}/internal/runs/${s.run.id}/integrations${path}`, {
        method,
        headers: {
          authorization: `Bearer ${s.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as T };
    },
    close: () => h.close(),
  };
}
