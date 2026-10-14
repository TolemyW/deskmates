import { describe, expect, it } from "vitest";
import { loadWebConfig } from "./config.js";
const env = {
  GATEWAY_OPERATOR_TOKEN: "operator-test-token-32-bytes-long-value",
  WHATSAPP_GATEWAY_URL: "http://127.0.0.1:8081",
  WHATSAPP_WORKSPACE_ID: "ws_test",
  WHATSAPP_BOT_IDS: "bot_a,bot_b",
  WHATSAPP_ALLOWED_SENDERS: "+15550001111",
};
describe("QR service configuration", () => {
  it("needs no WABA, app secret, Cloud token, phone ID or public callback", () => {
    expect(loadWebConfig(env)).toMatchObject({
      bind: "127.0.0.1",
      port: 8091,
      workspaceId: "ws_test",
      botIds: ["bot_a", "bot_b"],
      allowedSenders: new Set(["15550001111"]),
    });
  });
  it("defaults to admitting nobody", () => {
    expect(loadWebConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: "" }).allowedSenders.size).toBe(0);
  });
  it("rejects weak credentials, wrong URLs and invalid ports", () => {
    expect(() => loadWebConfig({ ...env, GATEWAY_OPERATOR_TOKEN: "short" })).toThrow();
    expect(() =>
      loadWebConfig({ ...env, WHATSAPP_GATEWAY_URL: "http://user:password@host" }),
    ).toThrow();
    expect(() => loadWebConfig({ ...env, WHATSAPP_WEB_PORT: "8091junk" })).toThrow();
  });
});
