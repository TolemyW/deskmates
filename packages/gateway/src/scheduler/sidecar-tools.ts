// The Gateway-owned tools a run's sidecar is started with, derived from whether the run has a
// thread, whether its bot names any connector, and from the run's knob configuration.

import {
  CONNECTOR_TOOL_NAMES,
  INTEGRATION_TOOL_NAMES,
  type SidecarToolName,
} from "@deskmates/contracts";

/** ADR-0040 decision 2: a tool per operation the run config names. */
function operationTools(stamp: unknown): SidecarToolName[] {
  if (!stamp || typeof stamp !== "object") return [];
  const ops = stamp as Record<string, unknown>;
  return [
    ...(ops.look ? (["image_describe"] as const) : []),
    ...(ops.asr ? (["audio_transcribe"] as const) : []),
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
 * (ADR-0035 decision 1).
 */
export function sidecarToolsFor(
  hasThread: boolean,
  config: Record<string, unknown>,
  hasConnectors = false,
  hasIntegrationConnections = false,
  hasDeliverableTasks = false,
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
  ];
}
