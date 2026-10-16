import type { BotId, IsoTimestamp, MessageId, RunId, ThreadId, WorkspaceId } from "./ids.js";
import type { OffsetPageMeta } from "./pagination.js";
import { PARKED_RUN_STATUSES, type RunStatus, isExecuting } from "./run.js";

export const TASK_STATUSES = [
  "planned",
  "in_progress",
  "blocked",
  "delivered",
  "accepted",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * `GET /api/workspaces/:id/tasks` (#113): one page of the workspace's tasks, most recently
 * updated first, filtered by `status` and the `q` search on the server, with the honest total
 * under that filter. `statusCounts` counts every task of the workspace by status, whatever the
 * filter or page, so the metric cards never count a page.
 */
export interface TaskListPage extends OffsetPageMeta {
  tasks: Task[];
  statusCounts: Record<TaskStatus, number>;
}

/** Any JSON value: what a bot may return as a task's structured output. */
export type TaskJson = null | boolean | number | string | TaskJson[] | { [key: string]: TaskJson };

/**
 * A JSON Schema object an operator stores on a task (ADR-0021 amendment 2). The Gateway checks a
 * delivered `output` against it with a small subset: `type`, `required`, `properties`, `enum`,
 * `items`, `additionalProperties`, plus the annotations `title` and `description`.
 */
export type TaskOutputSchema = { [key: string]: TaskJson };

/** A reference to current workspace bytes, not an immutable delivered version. */
export interface TaskArtifact {
  label: string;
  path: string;
  runId?: RunId;
}

/** Operator-maintained work tracking; never a scheduler instruction or bot permission. */
export interface Task {
  id: string;
  workspaceId: WorkspaceId;
  title: string;
  description: string;
  ownerBotId: BotId | null;
  status: TaskStatus;
  blockedReason: string;
  nextAction: string;
  threadIds: ThreadId[];
  runIds: RunId[];
  artifacts: TaskArtifact[];
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deliveredAt: IsoTimestamp | null;
  /**
   * Who declared delivery: `bot:<id>` through `task_deliver`, `user:<id>` or `human:web` through
   * the operator routes. Null for a task that is not delivered and for rows delivered before 0041.
   */
  deliveredBy: string | null;
  /** Schema a bot's delivered `output` must satisfy; null when the task asks for none. */
  outputSchema: TaskOutputSchema | null;
  /** Structured output a bot delivered with `task_deliver`; null when none was given. */
  output: TaskJson | null;
  acceptedAt: IsoTimestamp | null;
  acceptedBy: string | null;
  /**
   * Advances only when an operator edit changes title, description or output schema (ADR-0021
   * A3f). A delivery for an older scope is refused.
   */
  scopeVersion: number;
  /** The task's one schedule (A3d), or null when it has none. */
  schedule: TaskSchedule | null;
}

/** How a create takes effect (ADR-0021 A3a). An omitted trigger is `manual`: no dispatch. */
export const TASK_TRIGGERS = ["immediate", "scheduled", "manual"] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

/** A schedule as an operator writes it; the Gateway computes the next occurrence. */
export type TaskScheduleInput =
  | { kind: "once"; runAt: string; timeZone?: string }
  | { kind: "repeat"; cron: string; timeZone?: string };

export interface TaskSchedule {
  kind: "once" | "repeat";
  /** UTC instant of a `once` schedule. */
  runAt: IsoTimestamp | null;
  /** Five-field cron text of a `repeat` schedule, read in `timeZone`. */
  cron: string | null;
  /** IANA time zone the schedule is shown and (for `repeat`) evaluated in. */
  timeZone: string;
  enabled: boolean;
  version: number;
  /** UTC; null once a one-time schedule has fired or when no occurrence exists. */
  nextFireAt: IsoTimestamp | null;
  lastFiredAt: IsoTimestamp | null;
}

export type TaskSubmissionKind = "immediate" | "manual" | "scheduled";
/** What a submission did: posted the instruction, or skipped an occurrence (A3d). */
export type TaskSubmissionDispatch = "posted" | "skipped_overlap" | "missed";

/**
 * A submission's state, derived from its runs at read time (A3c, A3l). `waiting` covers every
 * parked run (approval, browser, continuation): the UI calls it paused or blocked.
 */
export type TaskExecutionState =
  | "not_started"
  | "queued"
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped"
  | "missed";

/** A run as the task view shows it: Gateway timestamps only. */
export interface TaskExecutionRun {
  id: RunId;
  botId: BotId;
  status: RunStatus;
  attempt: number;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  /** Approvals on this run still waiting for a decision. */
  pendingApprovals: number;
}

export interface TaskSubmission {
  id: string;
  taskId: string;
  kind: TaskSubmissionKind;
  key: string;
  scopeVersion: number;
  /** `user:<id>`, `human:web`, `service:<id>` or `schedule`. */
  actor: string;
  dispatch: TaskSubmissionDispatch;
  occurrenceAt: IsoTimestamp | null;
  threadId: ThreadId | null;
  messageId: MessageId | null;
  createdAt: IsoTimestamp;
  runs: TaskExecutionRun[];
  state: TaskExecutionState;
}

export interface TaskDeliveryPublication {
  path: string;
  label: string;
  sizeBytes: number;
  sha256: string;
  checkedAt: IsoTimestamp;
}

/** A bot's formal delivery (A3g); `partial` never completes the task. */
export interface TaskDelivery {
  id: string;
  kind: "complete" | "partial";
  runId: RunId | null;
  attempt: number;
  deliveredBy: string;
  scopeVersion: number;
  summary: string;
  outstanding: string[];
  createdAt: IsoTimestamp;
  publications: TaskDeliveryPublication[];
}

export interface TaskCheckpointUnit {
  unit: string;
  outcome: string;
  evidence: string[];
}

/** Progress a run recorded (A3h); run, attempt and bot come from the run, never the model. */
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  runId: RunId | null;
  attempt: number;
  botId: BotId | null;
  completed: TaskCheckpointUnit[];
  outstanding: string[];
  note: string;
  createdAt: IsoTimestamp;
}

/** The measured execution side of a task, read at one Gateway instant (A3l). */
export interface TaskExecution {
  observedAt: IsoTimestamp;
  submissions: TaskSubmission[];
  /** Runs linked to the task (task_runs), newest first. */
  linkedRuns: TaskExecutionRun[];
  deliveries: TaskDelivery[];
  latestCheckpoint: TaskCheckpoint | null;
}

/** `GET /api/workspaces/:id/tasks/:taskId`. */
export interface TaskDetailResponse {
  task: Task;
  execution: TaskExecution;
}

/** `POST /api/workspaces/:id/tasks` and `POST .../tasks/:taskId/run`. */
export interface TaskSubmitResponse {
  task: Task;
  /** Present when the act dispatched (immediate create, Run). */
  submission?: TaskSubmission;
}

/** A submission's state from its dispatch outcome and its runs (A3c). */
export function taskExecutionState(
  dispatch: TaskSubmissionDispatch,
  runs: readonly Pick<TaskExecutionRun, "status">[],
): TaskExecutionState {
  if (dispatch === "skipped_overlap") return "skipped";
  if (dispatch === "missed") return "missed";
  if (runs.length === 0) return "not_started";
  const statuses = runs.map((r) => r.status);
  if (statuses.some(isExecuting)) return "running";
  if (statuses.some((s) => PARKED_RUN_STATUSES.has(s))) return "waiting";
  if (statuses.some((s) => s === "queued")) return "queued";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.every((s) => s === "cancelled" || s === "stopped")) return "cancelled";
  return "finished";
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  ownerBotId?: BotId | null;
  threadIds?: ThreadId[];
  runIds?: RunId[];
  artifacts?: TaskArtifact[];
  /** Null clears it. Bounded in size and limited to the supported keyword subset. */
  outputSchema?: TaskOutputSchema | null;
}

/** The create body: the record plus how it takes effect (ADR-0021 A3a, A3b). */
export interface CreateTaskRequest extends CreateTaskInput {
  trigger?: TaskTrigger;
  /** Required with `scheduled`, refused otherwise. */
  schedule?: TaskScheduleInput;
  /** Client key; a repeat returns the first result and writes nothing. */
  idempotencyKey?: string;
}

/** Every mutation carries a version; acceptance has a separate operator-only endpoint. */
export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  version: number;
  status?: Exclude<TaskStatus, "accepted">;
  blockedReason?: string;
  nextAction?: string;
  /** An explicit schedule change (A3d); null removes it. Never a rerun. */
  schedule?: TaskScheduleInput | null;
}

/** `POST .../tasks/:taskId/run`: an explicit execution (A3a, A3b). */
export interface RunTaskRequest {
  version: number;
  idempotencyKey: string;
}

/** Client idempotency keys (A3b). */
export const TASK_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** `deliveredBy` for a bot's `task_deliver` (ADR-0021 amendment 2). */
export function deliveredByBot(botId: BotId): string {
  return `bot:${botId}`;
}

/** A task a run may deliver: linked to the run itself or to the run's thread, and still open. */
export interface DeliverableTask {
  id: string;
  title: string;
  outputSchema?: TaskOutputSchema;
  /** Sent back on delivery by the sidecar, never chosen by the model (ADR-0021 A3f). */
  scopeVersion?: number;
  /** The newest checkpoint for this task, for continuation (A3k). */
  latestCheckpoint?: TaskCheckpointDigest;
}

/** What a wake shows of a checkpoint: completed, missing evidence and outstanding (A3k). */
export interface TaskCheckpointDigest {
  runId: RunId | null;
  attempt: number;
  createdAt: IsoTimestamp;
  completed: TaskCheckpointUnit[];
  outstanding: string[];
}

/**
 * Sidecar → Gateway: the bot called `task_deliver` (ADR-0021 amendment 2). The Gateway checks the
 * task belongs to the run's workspace and is linked to the run or its thread, applies ADR-0014's
 * lexical path policy to every artifact, and validates `output` against the task's schema.
 */
export interface TaskDeliverRequest {
  taskId: string;
  summary: string;
  /** Zero for a non-file task (A3g); each is verified through the workspace before publication. */
  artifacts: { label: string; path: string }[];
  output?: TaskJson;
  /** Criteria still open or blocked; any makes the delivery `partial` (A3g). */
  outstanding?: string[];
  /** The scope version the run was given (A3f). */
  scopeVersion?: number;
}

export interface TaskDeliverResponse {
  task: Task;
  delivery: TaskDelivery;
}

/** `task_checkpoint` (A3h). */
export interface TaskCheckpointRequest {
  taskId: string;
  completed: TaskCheckpointUnit[];
  outstanding?: string[];
  note?: string;
}

export interface TaskCheckpointResponse {
  checkpoint: TaskCheckpoint;
}
