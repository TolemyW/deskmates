// Every dashboard the generator writes, one line each, sorted by slug. The sqlite engine has the
// agent runs dashboard and the owner's four focus areas (ADR-0046 amendment 2 decision 18): model
// latency, prompt cache, approvals and tool calls. Phase 2 adds silent runs and tasks.

import type { DashboardSpec } from "../spec.js";
import { agentRuns } from "./agent-runs.js";
import { approvals } from "./approvals.js";
import { modelLatency } from "./model-latency.js";
import { promptCache } from "./prompt-cache.js";
import { toolCalls } from "./tool-calls.js";

export const DASHBOARDS: readonly DashboardSpec[] = [
  agentRuns,
  approvals,
  modelLatency,
  promptCache,
  toolCalls,
];
