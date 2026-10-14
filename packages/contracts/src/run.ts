// Run ledger shapes and the run state machine (design v0.3 §4, §5; ADR-0002; ADR-0005).

import type { BotId, IsoTimestamp, RunId, ThreadId } from "./ids.js";
import type { LearnedItem } from "./memory.js";
import type { ProposedSkill } from "./skill.js";

/** Interactive: chat threads and approval replies. Background: cron, webhook, bus threads. */
export type RunLane = "interactive" | "background";

export type RunTriggerKind = "thread_message" | "cron" | "webhook" | "approval" | "welcome";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval_live"
  | "waiting_approval"
  | "waiting_browser"
  | "waiting_continuation"
  | "succeeded"
  | "silent"
  | "failed"
  | "cancelled"
  | "stopped";

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "succeeded",
  "silent",
  "failed",
  "cancelled",
  "stopped",
]);

/** Statuses in which the run is parked and its sidecar process may have exited. */
export const PARKED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "waiting_approval",
  "waiting_browser",
  "waiting_continuation",
]);

/**
 * Allowed transitions, from design v0.3 §4:
 *
 *   queued → running → succeeded | silent | failed | cancelled
 *   running → waiting_approval_live → running | waiting_approval
 *   running → waiting_approval → running
 *   running → waiting_browser → running
 *
 * `cancelled` is reachable from every non-terminal state; `failed` from every non-terminal state
 * too, including `queued`: a run whose start fails (missing member, sandbox error) must leave the
 * queue with its error, or it holds its lane forever.
 */
const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: [
    "succeeded",
    "silent",
    "failed",
    "cancelled",
    "waiting_approval_live",
    "waiting_approval",
    "waiting_browser",
    "waiting_continuation",
  ],
  waiting_approval_live: ["running", "waiting_approval", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  waiting_browser: ["running", "failed", "cancelled"],
  waiting_continuation: ["running", "stopped", "failed", "cancelled"],
  succeeded: [],
  silent: [],
  failed: [],
  cancelled: [],
  stopped: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Whether a run in this status occupies its bot's lane. Parked runs do not, so a new wake on the
 * same lane may start while an older run waits for approval (test strategy §4.2, "in-turn wake
 * meets a busy member").
 */
export function occupiesLane(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_approval_live";
}

/**
 * Reasons the Gateway itself records in a run's `error` when it decides the outcome (issue #21).
 * `no_reply`: the run was woken by a must-reply message and ended silent, so it is `failed`.
 * `deadline`: the run's thread passed its deadline before the run ended, so it is `cancelled`.
 * `turn_budget`: a bot message reached the thread's turn budget, which paused the thread and
 * cancelled this queued run (ADR-0005 item 6; issue #68).
 * Other `error` values are free text from the sidecar or the scheduler.
 */
export const RUN_ERROR_NO_REPLY = "no_reply";
export const RUN_ERROR_DEADLINE = "deadline";
export const RUN_ERROR_TURN_BUDGET = "turn_budget";

export type RunErrorReason =
  | typeof RUN_ERROR_NO_REPLY
  | typeof RUN_ERROR_DEADLINE
  | typeof RUN_ERROR_TURN_BUDGET;

export interface Run {
  id: RunId;
  botId: BotId;
  /** Absent for cron and webhook runs that have no thread. */
  threadId?: ThreadId;
  lane: RunLane;
  triggerKind: RunTriggerKind;
  /** Message id for `thread_message`, cron entry index for `cron`, request id for `webhook`, approval id for `approval`, unique request id for `welcome`. */
  triggerRef: string;
  status: RunStatus;
  /** Number of sidecar processes started for this run so far: 1, then one more per resume. */
  attempt: number;
  sdkSessionId?: string;
  /** What the Gateway needs to reopen a parked run: session id plus the pending decision. */
  resumePayload?: RunResumePayload;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  summary?: RunSummary;
}

export interface RunResumePayload {
  sdkSessionId: string;
  approvalId?: string;
  /** Tool-use id of the deferred call, so the decision resumes that call (or its retry) and no other. */
  toolUseId?: string;
  /** `RunEnded.currentOrigin` of the parked process, handed to the resumed one. */
  currentOrigin?: string;
  /** A continuation has no deferred tool call; the decision is a fresh user turn. */
  continuation?: true;
  /**
   * The workspace budget parked this run at a model call (ADR-0032 decision 6): no approval, an
   * Admin's explicit continue resumes it with a `budget_continuation` turn.
   */
  budget?: true;
}

/** Structured end-of-run summary emitted by the agent (design v0.3 §3.2). */
export interface RunSummary {
  done: string;
  filesChanged: readonly string[];
  sitesVisited: readonly string[];
  pendingApprovals: readonly string[];
  /**
   * Legacy field, kept for one release: the sidecar maps each entry into `learned` as a
   * bot-scope candidate (ADR-0011). The Gateway no longer queues these for per-item review.
   */
  memorySuggestions: readonly string[];
  /**
   * What the run learned, with a proposed scope (ADR-0011 decision 2). Every item's `trust` is
   * set by the sidecar from the run's taint; the Gateway classifies, dedupes and applies or gates.
   * Optional on the wire so an older sidecar image still validates; parsers fill in `[]`.
   */
  learned?: readonly LearnedItem[];
  /**
   * Skills a consolidation run wrote (ADR-0015 decision 2). The Gateway reads this field only for
   * a consolidation run; on any other run it is refused on the record and nothing is stored.
   */
  skills?: readonly ProposedSkill[];
  /** Posted as the bot's final thread message. Empty means the bot stayed silent. */
  reply: string;
}

/**
 * What a run did that someone else can see, reported beside its status (issue #70). `silent`
 * keeps its ADR-0005 decision 3 meaning, an empty final `reply`; a silent run may still have
 * answered through `thread_post`, handed off with `message_bot`, decided an approval or
 * delivered a task. These flags say which, so a measurement can tell such a run from one that
 * did nothing (measurement §3.6, `silent_run_cost_share` v2).
 *
 * Every flag is derived from what the Gateway itself wrote: the final reply on the run row and
 * the ledger events the Gateway appends when it accepts a post, a decision or a delivery. A
 * tool call the model attempted is not one. Telemetry only, not a control: nothing routes or
 * authorizes on these flags, and they are derived on read, so no stored row changes meaning.
 */
export interface RunVisibility {
  /** The run ended with a non-empty final `reply`; the opposite of a thread run's `silent`. */
  finalReply: boolean;
  /**
   * The Gateway posted a message for the run through `thread_post` or `message_bot` (including
   * the pairwise handoff it routes for a private-chat mention, ADR-0024).
   */
  postedToThread: boolean;
  /** The run settled a pending approval through `approval_decide` (ADR-0002 amendment 2). */
  decidedApproval: boolean;
  /** The run delivered a task through `task_deliver` (ADR-0021 amendment 2). */
  deliveredTask: boolean;
  /** Any of the above: the run left an outcome someone can see. */
  visibleOutcome: boolean;
}

/** The ledger fields `deriveRunVisibility` reads; a `RunEvent` or a trace event satisfies it. */
export interface RunVisibilityEvent {
  kind: string;
  payload: Record<string, unknown>;
}

const POST_TOOLS: ReadonlySet<unknown> = new Set(["thread_post", "message_bot"]);

function hasId(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "string" && payload[key] !== "";
}

/**
 * Derives `RunVisibility` from the run's final reply and its ledger. The shapes matched are the
 * Gateway-written records: `log` `{tool: "thread_post" | "message_bot", messageId}`, `log`
 * `{tool: "task_deliver", taskId}` and `approval` `{phase: "decided_by_tool", approvalId}`.
 */
export function deriveRunVisibility(input: {
  reply?: string;
  events: readonly RunVisibilityEvent[];
}): RunVisibility {
  const finalReply = (input.reply ?? "").trim() !== "";
  let postedToThread = false;
  let decidedApproval = false;
  let deliveredTask = false;
  for (const { kind, payload } of input.events) {
    if (kind === "log" && POST_TOOLS.has(payload.tool) && hasId(payload, "messageId")) {
      postedToThread = true;
    } else if (kind === "log" && payload.tool === "task_deliver" && hasId(payload, "taskId")) {
      deliveredTask = true;
    } else if (
      kind === "approval" &&
      payload.phase === "decided_by_tool" &&
      hasId(payload, "approvalId")
    ) {
      decidedApproval = true;
    }
  }
  return {
    finalReply,
    postedToThread,
    decidedApproval,
    deliveredTask,
    visibleOutcome: finalReply || postedToThread || decidedApproval || deliveredTask,
  };
}

/**
 * Every ledger event kind, as a runtime list for validation: the Gateway's event route and the
 * `run_events.kind` CHECK constraint must agree with it. `turn_usage` and `compact_boundary` are
 * the context observability events of the M3 context plan, Phase 1.
 */
export const RUN_EVENT_KINDS = [
  "tool_call",
  "tool_result",
  "thinking",
  "screenshot",
  "log",
  "approval",
  "takeover",
  "cap_breached",
  "pricing_missing",
  "turn_usage",
  "compact_boundary",
  "rule_file_modified",
  "memory_index",
  "memory_skipped",
  "cost_alert",
  // ADR-0023 decision 3: the SDK switched the session's model, or retried a model request.
  "model_switch",
  "model_retry",
  // ADR-0015 decision 6: recorded by the sidecar's PreToolUse hook on the `Skill` tool, never
  // reported by the model.
  "skill_used",
] as const;

export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/**
 * `turn_usage`: the token usage of one model response, as the SDK reported it on that response's
 * assistant message(s). `turn` counts responses within one attempt, from 1. Input and cache counts
 * are the size of the window the model saw on that turn; output is only as final as the SDK's
 * streamed message says, so billing still comes from the result's per-model totals.
 */
export interface TurnUsagePayload {
  model: string;
  turn: number;
  /** Missing SDK measurements stay unknown, including nullable cache counts. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
}

/**
 * `model_switch` (ADR-0023 decision 3): the SDK's `PostModelSwitch` hook, forwarded by the
 * sidecar. `source` is the SDK's own: `auto` for a fallback on an overloaded or unavailable
 * primary, `resume` when a resumed session restored its model, and the interactive kinds the SDK
 * names. `requested` is what was asked for, when the SDK says.
 */
export interface ModelSwitchPayload {
  from: string;
  to: string;
  source: "command" | "picker" | "sdk" | "auto" | "resume";
  requested?: string | null;
}

/**
 * `model_retry` (ADR-0023 decision 3): one SDK `api_retry` message. The SDK is the only retry
 * owner; the Gateway and its model proxy never retry. `errorStatus` is null for a connection
 * error that had no HTTP response.
 */
export interface ModelRetryPayload {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}

/** `compact_boundary`: the SDK compacted the conversation. `postTokens` only when the SDK says. */
export interface CompactBoundaryPayload {
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
}

export interface RunEvent {
  runId: RunId;
  /** Ledger order, assigned by the Gateway on arrival; unique per run across every source. */
  seq: number;
  /** The sidecar's own counter (`SidecarEvent.seq`); absent on Gateway-originated events. */
  sidecarSeq?: number;
  /**
   * The sidecar process it belongs to: `SidecarEvent.attempt` for a sidecar event, the run's
   * current attempt for a Gateway-originated one, so the ledger agrees with itself after a
   * resume (ADR-0002 amendment 2, "resume keeps the ledger whole").
   */
  attempt?: number;
  kind: RunEventKind;
  /** Redacted before it reaches the ledger; never contains tokens or cookies. */
  payload: Record<string, unknown>;
  ts: IsoTimestamp;
}

/** One row per (run, model). `costUsd` is computed by the Gateway; null when the model is unpriced. */
export interface RunUsage {
  runId: RunId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number | null;
}

/** Measured lower bounds, separate from the SDK's non-null final protocol. */
export type UsageCoverage = "complete" | "partial" | "unknown" | "not_started";
export interface RunUsageReceipt
  extends Omit<RunUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreateTokens"> {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
  coverage?: UsageCoverage;
  /** A resumed cumulative final may include an earlier interrupted run's unknown tail. */
  attributionUncertain?: boolean;
  /** Request identity is never substituted for a missing served identity. */
  requestedModels?: string[];
  servedModel?: string | null;
}

/** Price table row; amounts are USD per million tokens. */
export interface ModelPrice {
  model: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheCreatePerM: number;
  effectiveFrom: IsoTimestamp;
}
