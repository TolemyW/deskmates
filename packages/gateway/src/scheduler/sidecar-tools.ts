// The Gateway-owned tools a run's sidecar is started with, derived from whether the run has a
// thread, whether its bot names any connector, and from the run's knob configuration.

import {
  CONNECTOR_TOOL_NAMES,
  DEFAULT_BOT_TOOL_NAMES,
  INTEGRATION_TOOL_NAMES,
  type SidecarToolName,
  VAULT_TOOL_NAMES,
} from "@deskmates/contracts";

/** ADR-0040 decision 2: a tool per operation the run config names. */
function operationTools(stamp: unknown): SidecarToolName[] {
  if (!stamp || typeof stamp !== "object") return [];
  const ops = stamp as Record<string, unknown>;
  return [
    ...(ops.look ? (["image_describe"] as const) : []),
    ...(ops.asr ? (["audio_transcribe"] as const) : []),
    // ADR-0040 amendment B, decision 17.
    ...(ops.image_generation ? (["image_generate"] as const) : []),
  ];
}

/**
 * `approval_decide` is offered whenever the run has a thread: ADR-0002 amendment 2 lets any
 * member of a thread settle a request posted in it, including the requester from a later run.
 * The five connector tools come with a bot that names at least one connector, on a run whose
 * config carries `connectorVersion: 1` (ADR-0012 item 3); the sidecar limits them to those names.
 * The five integration tools come with a workspace that has at least one usable integration
 * connection, on a run whose config carries `integrationVersion: 1` (ADR-0013 item 5).
 * `task_deliver` comes only with an open task linked to the run or its thread (ADR-0021
 * amendment 2), so a run with no task to deliver sees no new tool. `app_publish` comes with a
 * run whose config carries `appShareVersion: 1`, stamped only where app sharing is configured
 * (ADR-0035 decision 1). `run_stats` comes only with a run that froze `runStats: "self-v1"`
 * (ADR-0050 decision 7), so a bot without the setting is not told the tool exists.
 * `bot_create`, `bot_update` and `group_create` come only with a run in a thread that froze
 * `workspaceAssistant: "assistant-v1"`: a run of the workspace's default bot (ADR-0051 decision 4).
 */
export function sidecarToolsFor(
  hasThread: boolean,
  config: Record<string, unknown>,
  hasConnectors = false,
  hasIntegrationConnections = false,
  hasDeliverableTasks = false,
  hasVault = false,
  runStats = false,
  assistant = false,
): SidecarToolName[] {
  return [
    ...(hasThread
      ? (["thread_post", "message_bot", "approval_decide"] as const)
      : (["message_bot"] as const)),
    "knowledge_search",
    "knowledge_read",
    "knowledge_propose",
    ...(config.memoryVersion === 1 ? (["memory_search"] as const) : []),
    ...(config.ttyVersion === 1 ? (["tty_session"] as const) : []),
    ...(config.browserExecutionMode === "vision-cli-v2" ? (["browser_cli_workflow"] as const) : []),
    ...(hasConnectors && config.connectorVersion === 1 ? CONNECTOR_TOOL_NAMES : []),
    ...(hasIntegrationConnections && config.integrationVersion === 1 ? INTEGRATION_TOOL_NAMES : []),
    ...(hasDeliverableTasks ? (["task_deliver"] as const) : []),
    ...(config.appShareVersion === 1 ? (["app_publish"] as const) : []),
    ...operationTools(config.operations),
    // ADR-0049 decision 12: offered exactly when the run row froze `webSearch: "on"`.
    ...(config.webSearch === "on" ? (["web_search"] as const) : []),
    // ADR-0045 decision 1: offered where the workspace Vault has a usable entry.
    ...(hasVault ? VAULT_TOOL_NAMES : []),
    ...(runStats ? (["run_stats"] as const) : []),
    ...(assistant && hasThread ? DEFAULT_BOT_TOOL_NAMES : []),
  ];
}
