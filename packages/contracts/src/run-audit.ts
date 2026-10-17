// Run audit (issue #11, ADR-0042): the failure class the Gateway derives from a run's `error`,
// the operator's "this run was wrong" mark, what one run changed, and the retention record a
// pruned run keeps. Shapes only; the Gateway classifies and stores.

import type { Approval } from "./approval.js";
import type { BotId, RunId, ThreadId } from "./ids.js";
import type { MemoryAuthority, MemoryEntryKind, MemoryScope, MemoryTrust } from "./memory.js";

/**
 * Why a run failed, derived from `runs.error` text (ADR-0042 decision 1). The class names the
 * root cause an operator acts on, not the symptom: a model job that hit its deadline while the
 * upstream answered "model not found" is `model_unavailable`, not `model_deadline`.
 *
 * - `model_unavailable`: the configured model or its upstream is missing or down (not found, no
 *   worker, 5xx after the SDK's retries, an unpriced or unselected model).
 * - `model_deadline`: a model job or request ran out of time with no better cause named.
 * - `tool_allowlist`: the sidecar refused the tools it was offered (start request rejected).
 * - `egress_blocked`: a navigation or fetch outside the workspace allowlist.
 * - `approval_denied`: a human, bot or rule denied the action the run depended on.
 * - `wall_clock`: the run's own time limit or its thread's deadline ended it.
 * - `sdk_abort`: the SDK reported its process aborted, with no cause named.
 * - `no_reply`: a must-reply wake ended silent (Gateway reason `no_reply`).
 * - `budget_limit`: a money or turn budget stopped it (Gateway reasons).
 * - `other`: none of the above.
 */
export const RUN_FAILURE_CLASSES = [
  "model_unavailable",
  "model_deadline",
  "tool_allowlist",
  "egress_blocked",
  "approval_denied",
  "wall_clock",
  "sdk_abort",
  "no_reply",
  "budget_limit",
  "other",
] as const;
export type RunFailureClass = (typeof RUN_FAILURE_CLASSES)[number];

export function isRunFailureClass(value: unknown): value is RunFailureClass {
  return typeof value === "string" && (RUN_FAILURE_CLASSES as readonly string[]).includes(value);
}

/** The one verdict a mark carries today (issue #11: one bit and a note). */
export type RunMarkVerdict = "wrong";

/** Longest note a mark stores, in characters. */
export const RUN_MARK_NOTE_MAX = 2000;

/**
 * An operator's verdict on a run (ADR-0042 decision 3). While it stands, the run's learned items
 * are do-not-learn: consolidation does not take its candidates, and a run still going learns
 * nothing when it ends. Removing it restores them.
 */
export interface RunMark {
  runId: RunId;
  verdict: RunMarkVerdict;
  note?: string;
  /** Actor label, `user:<id>` or `operator`. */
  markedBy: string;
  markedAt: string;
}

/** A task checkpoint the run wrote (ADR-0021). */
export interface RunTaskCheckpoint {
  id: string;
  taskId: string;
  attempt: number;
  body: Record<string, unknown>;
  createdAt: string;
}

/** A task artifact the run delivered (ADR-0021). */
export interface RunTaskArtifact {
  taskId: string;
  ordinal: number;
  path: string;
  label: string;
}

/** A learned-memory entry whose source is this run, at its current version. */
export interface RunMemoryWrite {
  entryId: string;
  scope: Exclude<MemoryScope, "rule">;
  kind: MemoryEntryKind;
  botId?: BotId;
  threadId?: ThreadId;
  body: string;
  authority: MemoryAuthority;
  trust: MemoryTrust;
  version: number;
  tombstoned: boolean;
  /** Set when consolidation has already taken this candidate as input. */
  consolidatedByRun?: RunId;
}

/** `GET /api/runs/:id/changes`: what one run changed beyond its row (ADR-0042 decision 4). */
export interface RunChanges {
  /** Every approval the run asked for, decided or not, oldest first. */
  approvals: Approval[];
  checkpoints: RunTaskCheckpoint[];
  artifacts: RunTaskArtifact[];
  memoryWritten: RunMemoryWrite[];
  mark?: RunMark;
  /** Set when retention pruned the run's events, usage and model requests (decision 6). */
  prunedAt?: string;
}
