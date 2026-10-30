// ADR-0048 decision 3: the one `desktop` MCP server a run gets when its row froze `lcu-v1` and the
// image declares the capability. The SDK does not launch LCU directly: it launches this package's
// `desktop-proxy` subcommand, which launches the LCU binary the image names and sits between them
// (`desktop-proxy.ts`). The binary path and arguments are image facts, never bot, workspace or
// model input; `settingSources` stays `[]`, so no user registration can add or change it.

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { DESKTOP_LCU_CAPABILITY, type StartRunRequest } from "@deskmates/contracts";
import { PROXY_COMMAND } from "../browser-mcp.js";
import { managedProxyEnvironment, managedProxyUrl } from "../managed-proxy.js";
import { VISION_POLICY_ENV } from "../vision-withhold.js";

/** What the image declares; comma-separated (images/workspace-desktop/Dockerfile). */
export const IMAGE_CAPABILITIES_ENV = "DESKMATES_IMAGE_CAPABILITIES";
export const LCU_COMMAND_ENV = "DESKMATES_DESKTOP_LCU_COMMAND";
export const LCU_ARGS_ENV = "DESKMATES_DESKTOP_LCU_ARGS";
export const LCU_VERSION_ENV = "DESKMATES_DESKTOP_LCU_VERSION";
export const APP_VERSION_ENV = "DESKMATES_DESKTOP_APP_VERSION";
/** The image's reader of raw X input events, as a command line (amendment 1, A5). */
export const INPUT_RECORDER_ENV = "DESKMATES_DESKTOP_INPUT_RECORDER";
/** The run facts the proxy needs for the lock, the epoch fence and host identity (JSON). */
export const DESKTOP_COORDINATION_ENV = "DESKMATES_DESKTOP_COORDINATION";

/** Desktop-session variables LCU needs and the SDK's passthrough does not carry. */
const DESKTOP_SESSION_KEYS = ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"];

export interface DesktopCoordinationConfig {
  runId: string;
  attempt: number;
  gatewayBaseUrl: string;
  token: string;
  /** A resumed run: the first result carries the rediscovery notice (decision 7). */
  resumed: boolean;
}

export type DesktopServerResult =
  | { server: McpStdioServerConfig; lcuVersion?: string; appVersion?: string }
  | { missing: "capability" | "command" };

/** Whether the environment declares the desktop capability (decision 11). */
export function declaresDesktopCapability(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env[IMAGE_CAPABILITIES_ENV] ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes(DESKTOP_LCU_CAPABILITY);
}

/**
 * The server for a run with `desktopTools: "lcu-v1"`, or why there is none. `timeoutMs` is the
 * SDK's per-call wall clock; the Gateway's run deadline stays authoritative.
 */
export function desktopMcpServer(
  env: Readonly<Record<string, string | undefined>>,
  request: Pick<
    StartRunRequest,
    "runId" | "attempt" | "gatewayBaseUrl" | "modelAuthToken" | "sdkSessionId"
  >,
  opts: { withholdImages?: boolean; timeoutMs?: number } = {},
): DesktopServerResult {
  if (!declaresDesktopCapability(env)) return { missing: "capability" };
  const command = env[LCU_COMMAND_ENV]?.trim();
  if (!command) return { missing: "command" };
  const args = (env[LCU_ARGS_ENV] ?? "").split(/\s+/).filter((word) => word !== "");
  const coordination: DesktopCoordinationConfig = {
    runId: request.runId,
    attempt: request.attempt,
    gatewayBaseUrl: request.gatewayBaseUrl,
    token: request.modelAuthToken,
    resumed: request.attempt > 1 || request.sdkSessionId !== undefined,
  };
  const session: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (DESKTOP_SESSION_KEYS.includes(key) || key.startsWith("LCU_") || key === INPUT_RECORDER_ENV)
      session[key] = value;
  }
  const managed = managedProxyUrl(env);
  const lcuVersion = env[LCU_VERSION_ENV];
  const appVersion = env[APP_VERSION_ENV];
  return {
    server: {
      type: "stdio",
      command: PROXY_COMMAND,
      // `--` ends the proxy's own options; everything after it is the image's LCU command.
      args: ["desktop-proxy", "--", command, ...args],
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      env: {
        ...session,
        // LCU's own update check goes to a host no allowlist names (ADR-0048 decision 11).
        LCU_NO_UPDATE_CHECK: "1",
        ...(managed === undefined ? {} : { DESKMATES_EGRESS_PROXY: managed }),
        ...managedProxyEnvironment(env),
        [DESKTOP_COORDINATION_ENV]: JSON.stringify(coordination),
        ...(opts.withholdImages ? { [VISION_POLICY_ENV]: "withhold" } : {}),
      },
    },
    ...(lcuVersion ? { lcuVersion } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

/** The proxy's answer to a call it cancelled (decision 5); the run ledgers it as a log too. */
export const DESKTOP_INTERRUPTED = "desktop_call_interrupted";
