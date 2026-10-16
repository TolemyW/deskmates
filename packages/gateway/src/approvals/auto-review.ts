// Automatic approval review (ADR-0002 amendment 4, B3 to B7). The Gateway never calls a model: it
// decides deterministically whether a request may be reviewed, freezes the review package on a
// run row, and lets the sidecar run it as a tool-free model job. The broker settles the verdict.
//
// The package carries the proposed action and the originating instruction, found by following
// the requesting run's wake chain past bot messages to a human message or to the cron prompt or
// webhook body that started the work, labelled by source (amendment 6, D3). It never carries a
// tool result, page text, a bot-authored message, SOUL, memory or an ADR-0028 summary.

import { createHash } from "node:crypto";
import {
  APPROVAL_REVIEW_POLICY_VERSION,
  type Approval,
  type ApprovalMode,
  type MessageId,
  type ModelJobRequest,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import type { MessageStore } from "../threads/messages.js";
import { AutoApprovalSettings } from "./auto-approval.js";
import { type ReviewIneligibility, reviewIneligibility } from "./auto-review-policy.js";

export const APPROVAL_REVIEW = "approval_review";
/** B5: at most this many review jobs run at once in one workspace. */
export const REVIEWS_PER_WORKSPACE = 2;
/** B6 as amendment 6 D3 set it: this many reviewer denials in a row send a run to humans. */
export const REVIEW_BREAKER_DENIALS = 5;
const WAKE_CHAIN_MAX_HOPS = 8;
const PACKAGE_MAX_CHARS = 20_000;
const INSTRUCTION_MAX_CHARS = 6_000;

export interface ApprovalReviewDeps {
  db: GatewayDb;
  runs: RunStore;
  messages: MessageStore;
  runConfig: () => Record<string, unknown>;
  /** The model a review runs on: the workspace default (a distinct reviewer model is proposed). */
  model: () => string;
}

export type ReviewQueueResult =
  | { queued: RunRecord }
  | { skipped: ReviewIneligibility | "off" | "no_model" };

/**
 * Where the instruction a reviewer judges against came from (amendment 6, D3). Only
 * `human_message` and `scheduled_task` were written by a person in a thread; a cron prompt is
 * operator-written; a webhook body is external data.
 */
export type InstructionSource =
  | "human_message"
  | "scheduled_task"
  | "cron_prompt"
  | "webhook_body"
  | "welcome_prompt";

export interface OriginatingInstruction {
  source: InstructionSource;
  text: string;
  /** The thread message, for the two sources that are one. */
  messageId?: MessageId;
}

/** What a continuation review sees besides the action (amendment 6, D6). */
export interface ContinuationFacts {
  continuationCount: number;
  continuationLimit: number | null;
  handoffPath: string | null;
}

/** Hash of the action a verdict is bound to (B4). */
export function actionHash(approval: Approval): string {
  return createHash("sha256").update(JSON.stringify(approval.action)).digest("hex");
}

export function isReviewRun(run: { config: Record<string, unknown> }): boolean {
  return run.config.runType === APPROVAL_REVIEW;
}

export class ApprovalReviews {
  private readonly settings: AutoApprovalSettings;

  constructor(private readonly deps: ApprovalReviewDeps) {
    this.settings = new AutoApprovalSettings(deps.db);
  }

  /** The approval mode of the run's workspace (amendment 6, D1). */
  mode(run: RunRecord): ApprovalMode {
    const workspaceId = this.workspaceOf(run);
    return workspaceId ? this.settings.mode(workspaceId) : "manual";
  }

  /**
   * Queue one review for a new, unanswered request, or say why it goes to humans instead. Called
   * by the broker after the approval row exists and before anything is posted.
   */
  queue(
    run: RunRecord,
    approval: Approval,
    facts: { scrubbedSecrets: boolean },
  ): ReviewQueueResult {
    const workspaceId = this.workspaceOf(run);
    if (!workspaceId || !this.settings.enabled(workspaceId)) return { skipped: "off" };
    const ineligible = reviewIneligibility(approval, facts);
    if (ineligible) return { skipped: ineligible };
    return this.queueReview(run, approval);
  }

  /**
   * Amendment 6, D6: a turn-exhaustion continuation past the workspace limit, in `approve_all`.
   * The reviewer decides whether the run continues once more; the mode was checked by the caller.
   */
  queueContinuation(
    run: RunRecord,
    approval: Approval,
    continuation: ContinuationFacts,
  ): ReviewQueueResult {
    return this.queueReview(run, approval, continuation);
  }

  private queueReview(
    run: RunRecord,
    approval: Approval,
    continuation?: ContinuationFacts,
  ): ReviewQueueResult {
    if (this.breakerOpen(run)) return { skipped: "breaker" };
    const instruction = this.originatingInstruction(run);
    if (!instruction) return { skipped: "no_instruction" };
    const model = this.deps.model();
    if (!model) return { skipped: "no_model" };
    const reviewPackage = JSON.stringify({
      policyVersion: APPROVAL_REVIEW_POLICY_VERSION,
      instructionSource: instruction.source,
      instruction: instruction.text.slice(0, INSTRUCTION_MAX_CHARS),
      ...(continuation ? { continuation } : {}),
      action: {
        toolName: approval.action.toolName,
        riskLevel: approval.riskLevel,
        targetOrigin: approval.action.targetOrigin ?? null,
        argumentSummary: approval.action.argumentSummary ?? null,
        argumentPattern: approval.action.argumentPattern ?? null,
        filePath: approval.action.filePath ?? null,
        insideSubagent: approval.action.agentType ?? null,
        input: approval.action.input,
      },
    }).slice(0, PACKAGE_MAX_CHARS);
    const queued = this.deps.runs.create({
      botId: run.botId,
      lane: "background",
      triggerKind: "cron",
      triggerRef: `${APPROVAL_REVIEW}:${approval.id}`,
      triggerPayload: { prompt: reviewPackage },
      config: {
        ...this.deps.runConfig(),
        runType: APPROVAL_REVIEW,
        approvalId: approval.id,
        reviewedRunId: run.id,
        actionSha256: actionHash(approval),
        instructionSource: instruction.source,
        ...(instruction.messageId ? { instructionMessageId: instruction.messageId } : {}),
        reviewPolicyVersion: APPROVAL_REVIEW_POLICY_VERSION,
        model,
        fallbackModel: null,
        maxTurns: 1,
      },
    });
    return { queued };
  }

  /** The job the sidecar runs, read from the frozen package on the run row. */
  job(run: RunRecord): ModelJobRequest | undefined {
    const reviewPackage = run.triggerPayload?.prompt;
    return typeof reviewPackage === "string" && reviewPackage.length >= 2
      ? { kind: "approval_review", reviewPackage }
      : undefined;
  }

  /** B5: whether another review may start in this workspace now. */
  mayStart(run: RunRecord): boolean {
    const workspaceId = this.workspaceOf(run);
    const row = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status IN ('running', 'stalled')
           AND run_type = ?`,
      )
      .get(workspaceId, APPROVAL_REVIEW) as { n: number };
    return row.n < REVIEWS_PER_WORKSPACE;
  }

  /**
   * The text that started this work (amendment 6, D3): the run's own wake if a human wrote it,
   * otherwise the wake of the bot run whose message woke it, and so on, up to a human message or
   * to the cron prompt, webhook body or welcome prompt of the run at the top of the chain. A
   * `system` message (an approval notice, an outcome notice) ends the walk without one.
   */
  originatingInstruction(run: RunRecord): OriginatingInstruction | undefined {
    let current: RunRecord | undefined = run;
    for (let hop = 0; current && hop < WAKE_CHAIN_MAX_HOPS; hop += 1) {
      const top = triggerInstruction(current);
      if (top) return top;
      if (current.triggerKind !== "thread_message") return undefined;
      const message: ThreadMessage | undefined = this.deps.messages.get(
        current.triggerRef as MessageId,
      );
      if (!message) return undefined;
      if (message.authorKind === "human") {
        if (message.body.trim() === "") return undefined;
        return {
          // A task schedule posts its occurrence as a human message authored `schedule`.
          source: message.authorId === "schedule" ? "scheduled_task" : "human_message",
          text: message.body,
          messageId: message.id,
        };
      }
      if (message.authorKind !== "bot" || message.runId === undefined) return undefined;
      current = this.deps.runs.get(message.runId);
    }
    return undefined;
  }

  /** B6 (amendment 6, D3: five): the last reviewer verdicts on this run were all denials. */
  private breakerOpen(run: RunRecord): boolean {
    const rows = this.deps.db
      .prepare(
        `SELECT decision FROM approvals WHERE run_id = ? AND decided_by LIKE 'reviewer:%'
          ORDER BY decided_at DESC, created_at DESC LIMIT ?`,
      )
      .all(run.id, REVIEW_BREAKER_DENIALS) as Array<{ decision: string }>;
    return rows.length === REVIEW_BREAKER_DENIALS && rows.every((row) => row.decision === "deny");
  }

  private workspaceOf(run: RunRecord): string | undefined {
    return (
      this.deps.db.prepare("SELECT workspace_id FROM runs WHERE id = ?").get(run.id) as
        | { workspace_id: string }
        | undefined
    )?.workspace_id;
  }
}

/** The host-authored text of a cron, webhook or welcome run; undefined for a thread wake. */
function triggerInstruction(run: RunRecord): OriginatingInstruction | undefined {
  const payload = run.triggerPayload ?? {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  if (run.triggerKind === "cron" || run.triggerKind === "manual") {
    const prompt = text(payload.prompt);
    return prompt === undefined ? undefined : { source: "cron_prompt", text: prompt };
  }
  if (run.triggerKind === "webhook") {
    const body = text(payload.body);
    return body === undefined ? undefined : { source: "webhook_body", text: body };
  }
  if (run.triggerKind === "welcome") {
    const prompt = text(payload.prompt);
    return prompt === undefined ? undefined : { source: "welcome_prompt", text: prompt };
  }
  return undefined;
}
