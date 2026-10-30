// T0 wire golden for the integrations API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type IntegrationsApi, createIntegrationsApi } from "./api.js";

const CASES: GoldenCases<IntegrationsApi> = {
  channelCommandMenu: (a) =>
    a.channelCommandMenu(WS, "chn/1", { operation: "inspect", scope: "default" }),
  adoptIntegrationProvider: (a) => a.adoptIntegrationProvider("github", undefined),
  blockChannelSender: (a) => a.blockChannelSender(WS, "chn/1", { senderId: "u 1", note: "spam" }),
  commandChannel: (a) => a.commandChannel(WS, "whatsapp/qr", "relink"),
  commandChannelConnection: (a) =>
    a.commandChannelConnection(WS, "chn/1", "relink", { config: { token: "t" } }),
  connectChannel: (a) =>
    a.connectChannel(WS, "whatsapp/qr", { method: "qr", botId: BOT, config: { label: "x" } }),
  createApiKeyConnection: (a) =>
    a.createApiKeyConnection(WS, {
      service: "linear",
      connectionName: "Linear",
      apiKey: "key-1",
    }),
  getChannelCatalog: (a) => a.getChannelCatalog(),
  getIntegrationCatalog: (a) => a.getIntegrationCatalog(),
  getIntegrations: (a) => a.getIntegrations(),
  listChannelConnections: (a) => a.listChannelConnections(WS),
  listChannelSenderBlocks: (a) => a.listChannelSenderBlocks(WS, "chn/1"),
  listConnectors: (a) => a.listConnectors(WS, { offset: 25, limit: 25 }),
  listIntegrationConnections: (a) =>
    a.listIntegrationConnections(WS, { status: "live", offset: 25, limit: 25 }),
  rebindChannelConnection: (a) => a.rebindChannelConnection(WS, "chn/1", BOT),
  registerConnector: (a) =>
    a.registerConnector({
      workspaceId: WS,
      name: "db",
      url: "http://db:8080",
    }),
  revokeIntegrationConnection: (a) => a.revokeIntegrationConnection(WS, "conn/1"),
  startOAuthConnection: (a) =>
    a.startOAuthConnection(WS, { service: "github", connectionName: "GH" }),
  unadoptIntegrationProvider: (a) => a.unadoptIntegrationProvider("git hub"),
  unblockChannelSender: (a) => a.unblockChannelSender(WS, "chn/1", "u/1"),
};

describe("integrations API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createIntegrationsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
