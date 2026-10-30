// The run loop's part of ADR-0048: registering the `desktop` server (decision 3), the effect
// labels on each desktop `tool_call` event (decision 2), and the log line for a call the proxy
// interrupted (decision 5). Kept here so `run-once.ts` grows by a call per concern.

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { DESKTOP_MCP_SERVER, type StartRunRequest } from "@deskmates/contracts";
import type { EventSink } from "../ledger.js";
import { isDesktopTool } from "../risk-tier.js";
import { desktopCallFacts } from "./desktop-hook.js";
import { DESKTOP_INTERRUPTED, desktopMcpServer } from "./desktop-server.js";

/**
 * Add the server when the run froze `lcu-v1`. An image without the capability, or without the
 * LCU command, starts the run without desktop tools and says so in the ledger; it never fails it.
 */
export function addDesktopServer(
  mcpServers: Record<string, McpServerConfig>,
  env: Readonly<Record<string, string | undefined>>,
  request: StartRunRequest,
  sink: Pick<EventSink, "emit">,
  opts: { withholdImages?: boolean; timeoutMs?: number },
): void {
  if (request.desktopTools !== "lcu-v1") return;
  const desktop = desktopMcpServer(env, request, opts);
  if ("missing" in desktop) {
    sink.emit("log", {
      source: "desktop",
      level: "warn",
      op: "capability_missing",
      missing: desktop.missing,
      reason: "the run froze desktop tools but this image does not provide them",
    });
    return;
  }
  mcpServers[DESKTOP_MCP_SERVER] = desktop.server;
  sink.emit("log", {
    source: "desktop",
    op: "registered",
    ...(desktop.lcuVersion ? { lcuVersion: desktop.lcuVersion } : {}),
    ...(desktop.appVersion ? { appVersion: desktop.appVersion } : {}),
  });
}

/** Extra `tool_call` fields for a desktop call; empty for every other tool. */
export function desktopToolCallFields(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return isDesktopTool(toolName) ? { ...desktopCallFacts(toolName, input) } : {};
}

/** Whether a desktop call's result is the proxy's interruption answer. */
export function isInterruptedDesktopResult(text: string): boolean {
  return text.slice(0, 400).includes(DESKTOP_INTERRUPTED);
}
