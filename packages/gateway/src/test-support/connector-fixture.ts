// T1 fixture for the connector module: an in-memory Gateway context whose connector proxy calls
// the testkit fake connector, a movable clock, one workspace with a bot and a run, and one
// registered connector. Dev-only.

import type {
  BotDefinition,
  BotId,
  ConnectorEffect,
  ConnectorRegistration,
  Workspace,
} from "@deskmates/contracts";
import { FakeConnector } from "@deskmates/testkit";
import { type GatewayContext, buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "./fake-provider.js";
import { testConfig } from "./harness.js";

export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
export const CONNECTOR_URL = "http://tickets-db.connector.internal:7000";
export const CONNECTOR_CREDENTIAL = "connector-credential-7f3e9a51c2";

export interface ConnectorFixtureOptions {
  ttlSeconds?: number;
  effects?: Record<string, ConnectorEffect>;
}

export interface ConnectorFixture {
  ctx: GatewayContext;
  db: GatewayDb;
  fake: FakeConnector;
  workspace: Workspace;
  bot: BotDefinition;
  run: RunRecord;
  connector: ConnectorRegistration;
  newRun(botId?: BotId): RunRecord;
  advanceSeconds(s: number): void;
  close(): void;
}

export function connectorFixture(opts: ConnectorFixtureOptions = {}): ConnectorFixture {
  const fake = new FakeConnector({
    baseUrl: CONNECTOR_URL,
    credential: CONNECTOR_CREDENTIAL,
    ...(opts.effects ? { effects: opts.effects } : {}),
  });
  let now = Date.parse("2026-09-29T10:00:00.000Z");
  const clock = () => new Date(now);
  const db = openDatabase(":memory:");
  const ctx = buildContext(
    testConfig({
      secretsKey: TEST_SECRETS_KEY,
      ...(opts.ttlSeconds === undefined ? {} : { connectorValidationTtlSeconds: opts.ttlSeconds }),
    }),
    db,
    new FakeProvider(),
    () => "http://gateway.test",
    () => {},
    { connectorFetch: fake.fetch, clock },
  );
  const workspace = ctx.workspaces.create({
    name: "db",
    sandboxProvider: "docker",
    egressAllowlist: ["ops.example.test"],
  });
  const bot = ctx.bots.create({
    name: "tester",
    role: "qa",
    workspaceId: workspace.id,
    connectors: ["tickets"],
  });
  const newRun = (botId = bot.id) =>
    ctx.runs.create({
      botId,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "connector-test",
      triggerPayload: { body: "x" },
      config: ctx.runConfig(),
    });
  const run = newRun();
  const connector = ctx.connectors.register({
    workspaceId: workspace.id,
    name: "tickets",
    url: CONNECTOR_URL,
    credential: CONNECTOR_CREDENTIAL,
  });
  return {
    ctx,
    db,
    fake,
    workspace,
    bot,
    run,
    connector,
    newRun,
    advanceSeconds: (s: number) => {
      now += s * 1000;
    },
    close: () => db.close(),
  };
}
