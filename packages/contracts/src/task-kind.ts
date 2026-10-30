// Task templates, task kinds, the kind view and related tasks (ADR-0021 amendment 4). A template
// is data; creating a task from one stamps its kind and copies its criteria into the task. Nothing
// here dispatches, and no default prompt changes: a template's text reaches a bot only as the
// description of the task a human created.

import type { BotId, IsoTimestamp } from "./ids.js";
import type { TaskStatus } from "./task.js";

/** A kind key: lower-case letters, digits and hyphens, at most 48 characters (A4a). */
export const TASK_KIND_KEY = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A field key of a template: lower-case letters, digits and underscores. */
export const TASK_FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** A stage key; criteria are labelled `<stage key>.<n>`. */
export const TASK_STAGE_KEY = /^[a-z][a-z0-9-]{0,31}$/;

export const TASK_REVIEW_ROLES = ["human", "peer_bot", "none"] as const;
/** Who reviews the work before it is accepted: a person, a teammate bot, or nobody. */
export type TaskReviewRole = (typeof TASK_REVIEW_ROLES)[number];

/** Bounds of a template (A4a); defensive product limits, not measured optimums. */
export const TASK_TEMPLATE_LIMITS = {
  name: 120,
  description: 4_000,
  stages: 12,
  criteriaPerStage: 12,
  criterion: 500,
  fields: 12,
  fieldLabel: 80,
  fieldValue: 200,
  /** The longest target time: 365 days. */
  slaMinutes: 525_600,
} as const;

export interface TaskTemplateCriterion {
  /** `<stage key>.<n>`, assigned in order; a checkpoint unit names a criterion by it. */
  label: string;
  text: string;
}

export interface TaskTemplateStage {
  key: string;
  name: string;
  criteria: TaskTemplateCriterion[];
  /** A checkpoint must report this stage before delivery (A4e discrepancy when it does not). */
  checkpointRequired: boolean;
}

export interface TaskTemplateField {
  key: string;
  label: string;
  required: boolean;
  /** Filled in when a create gives no value; empty means none. */
  defaultValue: string;
  /** Equal values relate tasks of the kind ("same customer", A4h). */
  relates: boolean;
}

/** A template as the Gateway returns it; built-ins have `builtIn: true` and version 1. */
export interface TaskTemplate {
  /** `builtin:<kind>` for a built-in, `ttpl_<hex>` for a workspace's own. */
  id: string;
  kind: string;
  name: string;
  description: string;
  stages: TaskTemplateStage[];
  review: TaskReviewRole;
  /** Target time from creation to delivery, in minutes; null when the kind has none. */
  slaMinutes: number | null;
  fields: TaskTemplateField[];
  builtIn: boolean;
  version: number;
  archivedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

/** What an Admin writes; criterion labels are assigned by the Gateway. */
export interface TaskTemplateInput {
  kind: string;
  name: string;
  description?: string;
  stages: {
    key: string;
    name: string;
    criteria: string[];
    checkpointRequired?: boolean;
  }[];
  review?: TaskReviewRole;
  slaMinutes?: number | null;
  fields?: (Partial<TaskTemplateField> & { key: string; label: string })[];
}

/** `PATCH .../task-templates/:id`: the whole template again, with the loaded version. */
export interface UpdateTaskTemplateInput extends Partial<TaskTemplateInput> {
  version: number;
}

/** `GET .../task-templates`. */
export interface TaskTemplateList {
  templates: TaskTemplate[];
}

/**
 * What a templated task carries (A4c): its kind and a snapshot of the template it came from, so
 * a later template edit changes no task, plus its current field values.
 */
export interface TaskKindStamp {
  key: string;
  name: string;
  templateId: string;
  templateVersion: number;
  stages: TaskTemplateStage[];
  review: TaskReviewRole;
  slaMinutes: number | null;
  fieldDefs: TaskTemplateField[];
  fields: Record<string, string>;
}

export type TaskCriterionState = "met" | "open" | "unreported";

/** One criterion's state from the task's checkpoints and deliveries (A4e). */
export interface TaskCriterionProgress {
  label: string;
  stageKey: string;
  text: string;
  state: TaskCriterionState;
  /** Evidence paths named by the unit that met it. */
  evidence: number;
  /** Gateway time of the mention that decided the state. */
  reportedAt: IsoTimestamp | null;
}

export interface TaskKindProgress {
  criteria: TaskCriterionProgress[];
  /** The first stage with a criterion not met; null when every criterion is met. */
  currentStage: string | null;
  /** Required checkpoint stages no checkpoint reported. */
  missingCheckpoints: string[];
  /** Named, never corrected: delivered while a required checkpoint or a criterion is missing. */
  discrepancies: TaskKindDiscrepancy[];
}

/**
 * `delivered_missing_checkpoint`: a delivered or accepted task whose required checkpoint stages
 * (`items`, stage keys) no checkpoint reported. `delivered_open_criteria`: one whose criteria
 * (`items`, labels) were last reported open.
 */
export interface TaskKindDiscrepancy {
  kind: "delivered_missing_checkpoint" | "delivered_open_criteria";
  items: string[];
}

export const TASK_STALL_REASONS = [
  "waiting_approval",
  "waiting_human",
  "awaiting_acceptance",
  "no_activity",
] as const;
export type TaskStallReason = (typeof TASK_STALL_REASONS)[number];

/** Where a task stands against its kind's target time. */
export type TaskSlaState = "none" | "on_track" | "at_risk" | "overdue" | "within" | "breached";

/** One task of the kind view's drill-down (A4g): task records and numbers only. */
export interface TaskKindRow {
  id: string;
  title: string;
  status: TaskStatus;
  ownerBotId: BotId | null;
  createdAt: IsoTimestamp;
  deliveredAt: IsoTimestamp | null;
  ageMinutes: number;
  timeToDoneMinutes: number | null;
  sla: TaskSlaState;
  stall: TaskStallReason | null;
  lastActivityAt: IsoTimestamp | null;
  currentStage: string | null;
  escalations: number;
  reassignments: number;
  runCount: number;
  /** Known plus estimated USD of the linked runs; null when none of it is priced. */
  costUsd: number | null;
  fields: Record<string, string>;
}

export interface TaskKindDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  created: number;
  delivered: number;
  accepted: number;
  cancelled: number;
  escalated: number;
}

/** `GET .../task-kinds/:kind` (A4g), read at one Gateway instant. */
export interface TaskKindStats {
  kind: string;
  name: string;
  observedAt: IsoTimestamp;
  windowDays: number;
  stalledMinutes: number;
  /** The newest template's target; each row is judged against its own task's snapshot. */
  slaMinutes: number | null;
  counts: Record<TaskStatus, number>;
  total: number;
  series: TaskKindDay[];
  completion: {
    /** Delivered or accepted. */
    done: number;
    /** Every task but cancelled ones. */
    considered: number;
    rate: number | null;
    acceptedRate: number | null;
  };
  timeToDone: {
    count: number;
    p50Minutes: number | null;
    p90Minutes: number | null;
    withinSla: number;
    breachedSla: number;
  };
  overdue: number;
  atRisk: number;
  stalled: Record<TaskStallReason, number>;
  escalations: number;
  reassignments: number;
  cost: {
    knownUsd: number;
    estimatedUsd: number;
    /** Known plus estimated over tasks with any priced run; null when there is none. */
    perTaskUsd: number | null;
    /** Runs with usage that could not be priced or estimated. */
    unpricedRuns: number;
    /** The tasks the cost covers: the drill-down's, newest first. */
    coveredTasks: number;
  };
  tasks: TaskKindRow[];
  /** True when more tasks than the drill-down shows exist. */
  truncated: boolean;
}

export interface TaskKindSummary {
  kind: string;
  name: string;
  templateId: string | null;
  builtIn: boolean;
  total: number;
  open: number;
}

/** `GET .../task-kinds`. */
export interface TaskKindList {
  kinds: TaskKindSummary[];
}

export interface RelatedTaskReason {
  kind: "field" | "text";
  /** The relating field's key, for `field`. */
  field?: string;
  /** The relating field's label, for `field`. */
  label?: string;
  /** The value both tasks hold, for `field`. */
  value?: string;
  /** Similarity in [0, 1], for `text`. */
  score?: number;
}

export interface RelatedTask {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: IsoTimestamp;
  reasons: RelatedTaskReason[];
  /** Flagged as a possible duplicate; never merged automatically (A4h). */
  possibleDuplicate: boolean;
}

/** How the text similarity was computed (A4h). */
export type RelatedTaskMethod = "embedding" | "lexical" | "lexical_fallback";

/** `GET .../tasks/:id/related`. */
export interface RelatedTaskList {
  taskId: string;
  kind: string | null;
  method: RelatedTaskMethod;
  related: RelatedTask[];
}
