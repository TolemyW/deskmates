import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_MS_DEFAULT, loadConfig } from "./config.js";

const TOKEN = "deskmates-sp.config-test-secret-0123456789";

describe("loadConfig", () => {
  it("reads the URL, token and optional default workspace", () => {
    expect(
      loadConfig({
        DESKMATES_URL: "https://deskmates.example.com/",
        DESKMATES_TOKEN: TOKEN,
        DESKMATES_WORKSPACE_ID: "ws_1",
      }),
    ).toEqual({
      gatewayUrl: "https://deskmates.example.com",
      token: TOKEN,
      defaultWorkspaceId: "ws_1",
      pollIntervalMs: POLL_INTERVAL_MS_DEFAULT,
    });
    expect(
      loadConfig({ DESKMATES_URL: "http://127.0.0.1:8081", DESKMATES_TOKEN: TOKEN }),
    ).not.toHaveProperty("defaultWorkspaceId");
  });

  it("reads an optional poll interval", () => {
    const config = loadConfig({
      DESKMATES_URL: "http://127.0.0.1:8081",
      DESKMATES_TOKEN: TOKEN,
      DESKMATES_POLL_INTERVAL_MS: "500",
    });
    expect(config.pollIntervalMs).toBe(500);
    expect(() =>
      loadConfig({
        DESKMATES_URL: "http://127.0.0.1:8081",
        DESKMATES_TOKEN: TOKEN,
        DESKMATES_POLL_INTERVAL_MS: "10",
      }),
    ).toThrow(/DESKMATES_POLL_INTERVAL_MS/);
  });

  it("requires the URL and the token", () => {
    expect(() => loadConfig({ DESKMATES_TOKEN: TOKEN })).toThrow(/DESKMATES_URL is required/);
    expect(() => loadConfig({ DESKMATES_URL: "http://127.0.0.1:8081" })).toThrow(
      /DESKMATES_TOKEN is required/,
    );
  });

  it("refuses a URL that is not http(s) or carries credentials, without echoing it", () => {
    expect(() => loadConfig({ DESKMATES_URL: "ftp://x", DESKMATES_TOKEN: TOKEN })).toThrow(
      /http or https/,
    );
    try {
      loadConfig({ DESKMATES_URL: `https://user:${TOKEN}@host`, DESKMATES_TOKEN: TOKEN });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/must not carry credentials/);
      expect(String(err)).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
    }
  });
});
