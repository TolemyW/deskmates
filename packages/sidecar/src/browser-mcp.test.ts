// T0: the SDK launches the proxy, and the proxy launches the browser MCP server.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_MCP_COMMAND,
  DEFAULT_CDP_ENDPOINT,
  PROXY_COMMAND,
  browserMcpServer,
} from "./browser-mcp.js";
import { LOOPBACK_NO_PROXY } from "./managed-proxy.js";
import { SCREENSHOT_DIR_ENV } from "./screenshots.js";
import { VISION_POLICY_ENV } from "./vision-withhold.js";

describe("browserMcpServer", () => {
  it("runs the underlying command through the proxy, after `--`", () => {
    expect(browserMcpServer({})).toEqual({
      type: "stdio",
      command: PROXY_COMMAND,
      args: [
        "mcp-proxy",
        "--",
        DEFAULT_BROWSER_MCP_COMMAND,
        "--cdp-endpoint",
        DEFAULT_CDP_ENDPOINT,
        "--caps",
        "vision",
        "--snapshot-mode",
        "none",
      ],
    });
  });

  it("keeps the command and the endpoint configurable", () => {
    const config = browserMcpServer({
      DESKMATES_BROWSER_MCP_COMMAND: "mcp-server-playwright",
      DESKMATES_CDP_ENDPOINT: "http://127.0.0.1:9333",
    });
    expect(config.args).toEqual([
      "mcp-proxy",
      "--",
      "mcp-server-playwright",
      "--cdp-endpoint",
      "http://127.0.0.1:9333",
      "--caps",
      "vision",
      "--snapshot-mode",
      "none",
    ]);
  });

  it("drops the vision capability and tells the proxy when the run withholds images", () => {
    // ADR-0023 amendment 2, decision 12c.
    const config = browserMcpServer({}, { withholdImages: true });
    expect(config.args).toEqual([
      "mcp-proxy",
      "--",
      DEFAULT_BROWSER_MCP_COMMAND,
      "--cdp-endpoint",
      DEFAULT_CDP_ENDPOINT,
      "--snapshot-mode",
      "none",
    ]);
    expect(config.env).toEqual({ [VISION_POLICY_ENV]: "withhold" });
  });

  it("passes the capture directory only when there is one", () => {
    expect(browserMcpServer({}).env).toBeUndefined();
    expect(browserMcpServer({}, {}).env).toBeUndefined();
    expect(browserMcpServer({}, { screenshotDir: "/run/deskmates/shots/r1" }).env).toEqual({
      [SCREENSHOT_DIR_ENV]: "/run/deskmates/shots/r1",
    });
  });

  it("passes only the managed proxy to the MCP subprocess", () => {
    const config = browserMcpServer({
      DESKMATES_EGRESS_PROXY: "http://proxy.internal:3128",
      HTTP_PROXY: "http://attacker.test:8080",
      NO_PROXY: "host.docker.internal",
    });
    expect(config.env).toMatchObject({
      DESKMATES_EGRESS_PROXY: "http://proxy.internal:3128",
      HTTP_PROXY: "http://proxy.internal:3128",
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: LOOPBACK_NO_PROXY,
    });
    expect(JSON.stringify(config.env)).not.toContain("attacker.test");
    expect(JSON.stringify(config.env)).not.toContain("host.docker.internal");
  });

  it("sets an explicit SDK tool timeout when origin coordination supplies one", () => {
    expect(browserMcpServer({}, { timeoutMs: 301_000 }).timeout).toBe(301_000);
  });
});
