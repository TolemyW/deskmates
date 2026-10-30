// Bot self-observability (ADR-0050): the read-only `run_stats` tool's answer, which the Gateway
// computes from the ledger for the calling run's bot in the calling run's workspace, and the
// per-bot setting an Owner or Admin turns on. Shapes and bounds only; the Gateway scopes and
// computes, the sidecar wraps the free text.

import type { CostStatus } from "./cost.js";
import type { ApprovalId, BotId, RunId, WorkspaceId } from "./ids.js";
import type { RunFailureClass } from "./run-audit.js";
import type { RunLane, RunStatus } from "./run.js";
import type { TaskStatus } from "./task.js";

/** The tool's name on the `deskmates` MCP server (decision 1). */
export const RUN_STATS_TOOL = "run_stats";

/** What a run froze in `runs.config_json.runStats` (decision 7); absent is `off`. */
export const RUN_STATS_MODES = ["off", "self-v1"] as const;
export type RunStatsMode = (typeof RUN_STATS_MODES)[number];

export function isRunStatsMode(value: unknown): value is RunStatsMode {
  return typeof value === "string" && (RUN_STATS_MODES as readonly string[]).includes(value);
}

/** Window length in whole UTC days (decision 1). */
export const RUN_STATS_WINDOW_DAYS_DEFAULT = 7;
export const RUN_STATS_WINDOW_DAYS_MAX = 30;
/** Entries listed per list; each list also says how many there are in all (decision 3). */
export const RUN_STATS_LIST_MAX = 20;

/** Durations of the window's finished runs, in seconds; null when none finished. */
export interface RunStatsDurations {
  finished: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
  totalSeconds: number;
}

/** The window's spend as Costs prices it (ADR-0032): unpriced stays unpriced, never zero. */
export interface RunStatsSpend {
  /** USD of priced usage; null when nothing in the window was priced. */
  knownCostUsd: number | null;
  /** Estimate of unpriced usage at average configured prices; never part of `knownCostUsd`. */
  estimatedCostUsd: number | null;
  costStatus: CostStatus;
  pricedUsageCount: number;
  unpricedUsageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface RunStatsWindow {
  /** First and last UTC day of the window, inclusive (`YYYY-MM-DD`). */
  from: string;
  to: string;
  runs: number;
  byStatus: Partial<Record<RunStatus, number>>;
  byLane: Record<RunLane, number>;
  /** Failure classes of the window's `failed` runs (ADR-0042); no error text. */
  failureClasses: Partial<Record<RunFailureClass, number>>;
  /** Runs that were Gateway jobs (a review, a summary, a probe). */
  jobRuns: number;
  /** Runs in a person's private chat: a count only, never their content (decision 4). */
  privateChatRuns: number;
  durations: RunStatsDurations;
  spend: RunStatsSpend;
}

/** Current minus previous; a share is a fraction from 0 to 1, null when there is none. */
export interface RunStatsTrend {
  runs: number;
  failed: number;
  successShare: { current: number | null; previous: number | null };
  knownCostUsd: number | null;
  medianSeconds: number | null;
}

export interface RunStatsApproval {
  approvalId: ApprovalId;
  runId: RunId;
  kind: "tool" | "egress" | "continuation";
  toolName: string | null;
  waitingSince: string;
}

export interface RunStatsParkedRun {
  runId: RunId;
  status: RunStatus;
  lane: RunLane;
  createdAt: string;
}

export interface RunStatsTask {
  taskId: string;
  status: TaskStatus;
  /** Workspace board text; the sidecar hands it to the model wrapped as untrusted. */
  title: string;
  updatedAt: string;
}

export interface RunStatsList<T> {
  total: number;
  items: T[];
}

export interface RunStatsReport {
  version: 1;
  botId: BotId;
  workspaceId: WorkspaceId;
  /** The run that asked. */
  runId: RunId;
  generatedAt: string;
  windowDays: number;
  current: RunStatsWindow;
  previous: RunStatsWindow;
  trend: RunStatsTrend;
  now: {
    executingRuns: number;
    pendingApprovals: RunStatsList<RunStatsApproval>;
    parkedRuns: RunStatsList<RunStatsParkedRun> & { byStatus: Partial<Record<RunStatus, number>> };
    tasks: {
      byStatus: Partial<Record<TaskStatus, number>>;
      open: RunStatsList<RunStatsTask>;
    };
  };
}

/** The per-bot setting (decision 6): no row is off. */
export interface BotRunStatsSetting {
  botId: BotId;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
}
