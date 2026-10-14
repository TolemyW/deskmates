// The one browser MCP server per workspace, attached to the workspace's single Chromium over CDP
// (design v0.3 §3.3; S0 test-c). The command is a preinstalled binary from the workspace image;
// nothing is downloaded at run time. The endpoint is configuration with the documented default.
//
// The SDK does not launch that binary directly: it launches this package's own `mcp-proxy`
// subcommand, which launches it. The proxy wraps page text as untrusted and captures screenshots
// after page-changing actions (`mcp-proxy/proxy.ts`); it speaks the same JSON-RPC on both sides,
// so the SDK sees the browser server it always saw.

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { BROWSER_COORDINATION_ENV, type BrowserCoordinationConfig } from "./browser-state.js";
import { managedProxyEnvironment, managedProxyUrl } from "./managed-proxy.js";
import { SCREENSHOT_DIR_ENV } from "./screenshots.js";
import { VISION_POLICY_ENV } from "./vision-withhold.js";

export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

/**
 * The bin name `@playwright/mcp` 0.0.82 installs (`"bin": {"playwright-mcp": "cli.js"}`); older
 * releases used `mcp-server-playwright`. acceptance/m0-stack.container.test.ts proves the
 * workspace image's SDK registers the browser tools under this name.
 */
export const DEFAULT_BROWSER_MCP_COMMAND = "playwright-mcp";

/** This package's own binary, on PATH in the workspace image (`images/workspace/deskmates-sidecar`). */
export const PROXY_COMMAND = "deskmates-sidecar";

export interface BrowserMcpOptions {
  /** Where the proxy writes captures. Omitted means it takes none at all. */
  screenshotDir?: string;
  coordination?: BrowserCoordinationConfig;
  /** SDK hard wall clock for each browser tool call. */
  timeoutMs?: number;
  /**
   * ADR-0023 amendment 2: the run's model cannot see. The server starts without `--caps vision`
   * (its coordinate tools are useless blind) and the proxy turns image results into notices.
   */
  withholdImages?: boolean;
}

export function browserMcpServer(
  env: Readonly<Record<string, string | undefined>>,
  opts: BrowserMcpOptions = {},
): McpStdioServerConfig {
  const managedProxy = managedProxyUrl(env);
  const command = env.DESKMATES_BROWSER_MCP_COMMAND ?? DEFAULT_BROWSER_MCP_COMMAND;
  const args = [
    "--cdp-endpoint",
    env.DESKMATES_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT,
    ...(opts.withholdImages ? [] : ["--caps", "vision"]),
    // In MCP 0.0.82, automatic snapshots from navigate/click are written to page-*.yml and the
    // result contains only a file link. An explicit browser_snapshot without `filename` is still
    // returned inline. Keeping automatic snapshots off makes the default page-reading path cross
    // the proxy's untrusted-content wrapper instead of asking the model to Read the generated file.
    "--snapshot-mode",
    "none",
  ];
  return {
    type: "stdio",
    command: PROXY_COMMAND,
    // `--` ends the proxy's own options; everything after it is the underlying command, verbatim.
    args: ["mcp-proxy", "--", command, ...args],
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
    ...(opts.screenshotDir === undefined &&
    opts.coordination === undefined &&
    managedProxy === undefined &&
    !opts.withholdImages
      ? {}
      : {
          env: {
            ...(managedProxy === undefined ? {} : { DESKMATES_EGRESS_PROXY: managedProxy }),
            ...managedProxyEnvironment(env),
            ...(opts.screenshotDir ? { [SCREENSHOT_DIR_ENV]: opts.screenshotDir } : {}),
            ...(opts.coordination
              ? { [BROWSER_COORDINATION_ENV]: JSON.stringify(opts.coordination) }
              : {}),
            ...(opts.withholdImages ? { [VISION_POLICY_ENV]: "withhold" } : {}),
          },
        }),
  };
}
