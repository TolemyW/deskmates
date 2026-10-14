import { describe, expect, it } from "vitest";
import { loadWhatsAppConfig, parseAllowedSenders } from "./config.js";

const BASE = {
  WHATSAPP_VERIFY_TOKEN: "verify-me",
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_ACCESS_TOKEN: "EAAB",
  WHATSAPP_PHONE_NUMBER_ID: "100200",
  WHATSAPP_ALLOWED_SENDERS: "+8613800000000, 15550002222",
  WHATSAPP_GATEWAY_URL: "http://127.0.0.1:8081/",
  GATEWAY_OPERATOR_TOKEN: "operator-token",
  WHATSAPP_WORKSPACE_ID: "ws_1",
  WHATSAPP_BOT_IDS: "bot_a, bot_b",
};

describe("loadWhatsAppConfig", () => {
  it("applies defaults and normalises the allowlist and URLs", () => {
    const c = loadWhatsAppConfig(BASE);
    expect(c.port).toBe(8090);
    expect(c.bind).toBe("127.0.0.1");
    expect(c.graphBaseUrl).toBe("https://graph.facebook.com");
    expect(c.graphApiVersion).toBe("v23.0");
    expect(c.gatewayUrl).toBe("http://127.0.0.1:8081");
    expect([...c.allowedSenders]).toEqual(["8613800000000", "15550002222"]);
    expect(c.botIds).toEqual(["bot_a", "bot_b"]);
    expect(c.stateFile).toBe("./data/whatsapp-state.json");
    expect(c.sendRetries).toBe(3);
  });

  it("fails fast without each required variable", () => {
    for (const key of [
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_GATEWAY_URL",
      "GATEWAY_OPERATOR_TOKEN",
      "WHATSAPP_WORKSPACE_ID",
    ]) {
      expect(() => loadWhatsAppConfig({ ...BASE, [key]: "" }), key).toThrow(new RegExp(key));
    }
    expect(() => loadWhatsAppConfig({ ...BASE, WHATSAPP_BOT_IDS: " , " })).toThrow(
      /WHATSAPP_BOT_IDS/,
    );
  });

  it("rejects bad senders, versions and URLs", () => {
    expect(() => parseAllowedSenders("abc")).toThrow(/E.164/);
    expect(() => parseAllowedSenders("+86 138")).toThrow(/E.164/);
    expect(parseAllowedSenders(undefined).size).toBe(0);
    expect(() => loadWhatsAppConfig({ ...BASE, WHATSAPP_GRAPH_API_VERSION: "23" })).toThrow(
      /v23.0/,
    );
    expect(() =>
      loadWhatsAppConfig({ ...BASE, WHATSAPP_GATEWAY_URL: "http://user:pw@host" }),
    ).toThrow(/credentials/);
    expect(() => loadWhatsAppConfig({ ...BASE, WHATSAPP_GRAPH_BASE_URL: "ftp://x" })).toThrow(
      /https/,
    );
    expect(() => loadWhatsAppConfig({ ...BASE, WHATSAPP_PORT: "-1" })).toThrow(/WHATSAPP_PORT/);
  });
});
