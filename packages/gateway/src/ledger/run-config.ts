// The knob configuration stamped on every run row (AGENTS.md: `runs.config_json`). Built from
// the Gateway config once; `buildContext` hands the function to the router and the lifecycle.

import {
  CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT,
  GROUP_ROUTING_DEFAULT,
  type GatewayConfig,
  WORKSPACE_CPU_LIMIT_DEFAULT,
} from "../config.js";

export function createRunConfig(config: GatewayConfig): () => Record<string, unknown> {
  const workspaceMemoryLimitMb = config.workspaceMemoryLimitMb;
  const workspaceCpuLimit = config.workspaceCpuLimit ?? WORKSPACE_CPU_LIMIT_DEFAULT;
  const connectorValidationTtlSeconds =
    config.connectorValidationTtlSeconds ?? CONNECTOR_VALIDATION_TTL_SECONDS_DEFAULT;
  return (): Record<string, unknown> => ({
    defaultModel: config.defaultModel,
    defaultCheapModel: config.cheapModel,
    shortWaitSeconds: config.shortWaitSeconds,
    modelTokenTtlSeconds: config.modelTokenTtlSeconds,
    threadPayloadMaxTokens: config.threadPayloadMaxTokens,
    browserRuntimeVersion: 1,
    knowledgeVersion: 1,
    ttyVersion: 1,
    browserTabRetentionVersion: 1,
    browserRetainedTabs: config.browserRetainedTabs ?? 20,
    browserTabRetentionHours: config.browserTabRetentionHours ?? 24,
    resourceObservationVersion: 1,
    // null: no cap on concurrent sidecars per workspace (ADR-0022 amendment 5). Older rows hold
    // the number that capped them.
    workspaceMaxConcurrentRuns: null,
    browserExecutionMode: config.browserExecutionMode ?? "baseline-v1",
    knowledgeRetrieval: { version: 1, limit: 5, queryCharacters: 500 },
    phaseTimingVersion: 1,
    ...(config.strategyEvidence ? { strategyEvidence: { ...config.strategyEvidence } } : {}),
    browserCoordinationMode: config.browserCoordinationMode ?? "tab-v1",
    browserSnapshotMode: config.browserSnapshotMode ?? "explicit-v1",
    groupRouting: config.groupRouting ?? GROUP_ROUTING_DEFAULT,
    privateHandoffVersion: 1,
    // Issue #88: where the run starts; `shared` is `/work`, as before the knob.
    botWorkdir: config.botWorkdir ?? "shared",
    runTimeoutSeconds: config.runTimeoutSeconds,
    workspaceMemoryLimitMb,
    workspaceCpuLimit,
    cronTimeZone: config.cronTimeZone ?? null,
    webhookBodyMaxBytes: config.webhookBodyMaxBytes,
    webhookQueueMax: config.webhookQueueMax,
    maxTurns: config.maxTurns,
    connectorVersion: 1,
    connectorValidationTtlSeconds,
    // ADR-0013: recorded only where a runtime is configured, so older run rows stay comparable.
    ...(config.integrationRuntime ? { integrationVersion: 1 } : {}),
    // ADR-0011: pinned index in the first user turn, memory_search, learned writes. The budgets
    // and the exact version set of each run are stamped at start (decision 12).
    memoryVersion: 1,
  });
}
