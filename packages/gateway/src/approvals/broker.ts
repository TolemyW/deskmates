// The approval broker (ADR-0002 amendment 2). Decision order is risk tier → matching rule →
// thread: the tier check happened in the sidecar's hook and only L2 calls arrive here; a stored
// rule answers at once and nothing is posted; an unmatched request becomes one `system` message
// in the run's thread and starts the short wait, unless nobody is online, in which case the
// sidecar is told to defer and the run parks.
//
// The request body is built from the `ToolAction` and the instruction that woke the run, and from
// nothing else: tool results and page text are the injection vector approvals exist to catch.

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalRule,
  type Attachment,
  DeskmatesError,
  type MessageId,
  type RunEnded,
  type RunId,
  type RunStatus,
  type ThreadId,
  type ToolAction,
  decidedByReviewer,
  decidedByRule,
  findMatchingRule,
  matcherFromAction,
  parseApprovalReview,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { EventBus, GatewayEvent } from "../events/bus.js";
import type { Presence } from "../events/presence.js";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import { continuationAllowed } from "../scheduler/run-limits.js";
import { announceDelegationOutcome } from "../threads/delegation-outcomes.js";
import type { MessageStore } from "../threads/messages.js";
import type { ThreadRouter } from "../threads/router.js";
import type { ThreadStore } from "../threads/threads.js";
import type { ApprovalStore } from "./approvals.js";
import { type ApprovalReviews, actionHash } from "./auto-review.js";
import type { ApprovalRuleStore } from "./rules.js";
import { scrubSecretShaped } from "./secret-shaped.js";

/** How much of a raw tool input goes in the request body when the sidecar sent no summary. */
export const ARGUMENT_SUMMARY_MAX_CHARS = 500;

export interface BrokerDeps {
  /** Automatic review (ADR-0002 amendment 4); absent, every request goes to humans. */
  reviews?: ApprovalReviews;
  queuePresentation?: (approval: Approval) => void;
  approvals: ApprovalStore;
  rules: ApprovalRuleStore;
  runs: RunStore;
  events: EventStore;
  messages: MessageStore;
  threads: ThreadStore;
  router: ThreadRouter;
  bots: BotStore;
  bus: EventBus;
  presence: Presence;
  /**
   * The tenant a run belongs to (ADR-0022): only that tenant's approvers keep its approval live.
   * Omitted, any qualified watcher counts.
   */
  runTenant?: (runId: RunId) => string | undefined;
  /**
   * Exact values the Gateway knows are its own secrets — the upstream model token — scrubbed out
   * of an action by literal match as well as by shape.
   */
  ownSecrets?: readonly string[];
}

export interface DecideResult {
  approval: Approval;
  /** The rule an `allow_always` decision stored. */
  rule?: ApprovalRule;
}

/** The attachment that ties a thread message to its approval so the UI can draw the card. */
export function approvalAttachment(approvalId: ApprovalId): Attachment {
  return { name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approvalId };
}

/**
 * The `system` message body. Only the action and the waking instruction; never a tool result.
 */
export function approvalRequestBody(
  botName: string,
  action: ToolAction,
  instruction: string | undefined,
): string {
  const origin = action.targetOrigin ?? "(no origin)";
  const args =
    action.argumentSummary ?? JSON.stringify(action.input).slice(0, ARGUMENT_SUMMARY_MAX_CHARS);
  // ADR-0002 amendment 3, A5: say when no tier table named the tool, and which subagent asked.
  const labels = [
    ...(action.unclassified
      ? ["unclassified tool: no tier table names it, so it asks by default"]
      : []),
    ...(action.agentType === undefined ? [] : [`inside a subagent of type ${action.agentType}`]),
  ];
  const labelled = labels.length > 0 ? ` (${labels.join("; ")})` : "";
  return [
    `Approval needed: ${botName} wants to run ${action.toolName} on ${origin}${labelled}`,
    `Arguments: ${args}`,
    `Instruction: ${instruction ?? "(none)"}`,
  ].join("\n");
}

/**
 * The deny reason the sidecar's hook hands the model. It has to name the denier, because a bare
 * "not today" reads to the bot as the site refusing the action, and it reports back that the
 * console blocked it rather than that a human did. `decidedBy` is `human:<authorId>`,
 * `bot:<botId>` or `rule:<ruleId>`; the author id is deliberately left out of the human case,
 * where "a human" is the whole point.
 */
export function denyReason(decidedBy: string | undefined, reason: string | undefined): string {
  const tail = reason ? `: ${reason}` : "";
  const [kind, ...rest] = (decidedBy ?? "").split(":");
  const who = rest.join(":");
  if (kind === "human") return `Denied by human${tail}`;
  if (kind === "bot" && who) return `Denied by bot ${who}${tail}`;
  if (kind === "rule" && who) return `Denied by rule ${who}${tail}`;
  if (kind === "reviewer" && who) return `Denied by the approval reviewer (${who})${tail}`;
  return `Denied by ${decidedBy ?? "unknown"}${tail}`;
}

export class ApprovalBroker {
  constructor(private readonly deps: BrokerDeps) {}

  /** Automatic review (ADR-0002 amendment 4), when the Gateway was built with it. */
  get reviews(): ApprovalReviews | undefined {
    return this.deps.reviews;
  }

  /**
   * The sidecar's hook met an L2 call. Returns the response to hand back at once, or `"pending"`
   * when the sidecar should poll for the duration of its short wait.
   */
  request(run: RunRecord, rawReq: ApprovalRequest): ApprovalResponse | "pending" {
    if (rawReq.action.toolName === "__run_continuation__") {
      throw new DeskmatesError(
        "validation",
        "continuation requests are created by the run lifecycle",
      );
    }
    if (rawReq.riskLevel !== "L2") {
      throw new DeskmatesError("validation", "only L2 calls are brokered", {
        approvalId: rawReq.approvalId,
        riskLevel: rawReq.riskLevel,
      });
    }
    // Idempotent on the approval id: a redelivered request never posts a second message.
    const existing = this.deps.approvals.get(rawReq.approvalId);
    if (existing) return existing.decision ? this.response(existing) : "pending";

    // Last line before the action is stored, posted into a thread and echoed on the bus. The
    // sidecar redacts first; a hit here means its copy let something through, so the run says so
    // in its ledger rather than silently cleaning up after it.
    const scrubbed = scrubSecretShaped(rawReq.action, this.deps.ownSecrets ?? []);
    if (scrubbed.hits > 0) {
      this.deps.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: "approval_guard", redactedFields: scrubbed.hits },
      });
    }
    const req: ApprovalRequest = { ...rawReq, action: scrubbed.value };

    // An egress ask is answered by the allowlist, never by a tool rule (ADR-0020 decision 2).
    const rule =
      req.kind === "egress"
        ? undefined
        : findMatchingRule(this.deps.rules.list(run.botId), req.action, run.botId);
    if (rule) {
      const approval = this.deps.approvals.create({
        ...this.base(run, req),
        decision: rule.decision,
        decidedBy: decidedByRule(rule.id),
        ruleId: rule.id,
      });
      this.event(run.id, {
        phase: "rule_matched",
        approvalId: approval.id,
        ruleId: rule.id,
        decision: rule.decision,
        toolName: req.action.toolName,
        riskLevel: req.riskLevel,
      });
      this.publishApproval(approval);
      return this.response(approval);
    }

    const instruction = this.instructionFor(run);
    const approval = this.deps.approvals.create({
      ...this.base(run, req),
      ...(instruction === undefined ? {} : { instruction }),
    });
    // Presentation failure cannot suppress an approval or cause its action to be retried.
    try {
      this.deps.queuePresentation?.(approval);
    } catch (error) {
      this.event(run.id, {
        phase: "presentation_unavailable",
        approvalId: approval.id,
        error: String(error),
      });
    }
    // ADR-0002 amendment 4, B3/B5: with automatic approval on, an eligible request goes to the
    // reviewer first. Nothing is posted and nobody is woken; the requester waits live whoever is
    // online, and a verdict, or an escalation to the thread, follows.
    const review = this.deps.reviews?.queue(run, approval, { scrubbedSecrets: scrubbed.hits > 0 });
    if (review && "queued" in review) {
      this.event(run.id, {
        phase: "review_queued",
        approvalId: approval.id,
        reviewRunId: review.queued.id,
        toolName: req.action.toolName,
        riskLevel: req.riskLevel,
      });
      this.deps.bus.publish({ type: "run_status", run: review.queued });
      this.publishApproval(approval);
      this.transition(run.id, "waiting_approval_live");
      return "pending";
    }
    if (review && review.skipped !== "off") {
      this.event(run.id, {
        phase: "review_skipped",
        approvalId: approval.id,
        reason: review.skipped,
      });
    }
    this.postForHumans(run, approval);

    const tenantId = this.deps.runTenant ? (this.deps.runTenant(run.id) ?? "") : undefined;
    if (!this.deps.presence.humanOnline(tenantId)) {
      // Nobody to ask: do not burn the short wait, park now and resume on the decision.
      return {
        type: "approval_response",
        approvalId: approval.id,
        decision: "defer",
        reason: "nobody online",
      };
    }
    this.transition(run.id, "waiting_approval_live");
    return "pending";
  }

  /** Post the request into its thread for the members to decide (A1/A2) and record that. */
  private postForHumans(run: RunRecord, approval: Approval): void {
    const action = approval.action;
    let messageId: MessageId | undefined;
    if (run.threadId) {
      const bot = this.deps.bots.mustGet(run.botId);
      const posted = this.deps.router.postSystem(
        run.threadId,
        approvalRequestBody(bot.name, action, approval.instruction),
        [approvalAttachment(approval.id)],
        // The requester is the run that is waiting; waking it on its own request is a loop.
        { wakeExcept: run.botId },
      );
      messageId = posted.message.id;
      this.deps.approvals.setMessage(approval.id, messageId);
      this.deps.bus.publish({
        type: "thread_message",
        threadId: run.threadId,
        message: posted.message,
      });
      for (const woken of posted.runs) {
        this.deps.bus.publish({ type: "run_status", threadId: run.threadId, run: woken });
      }
    }
    this.event(run.id, {
      phase: "posted",
      approvalId: approval.id,
      messageId: messageId ?? null,
      toolName: action.toolName,
      riskLevel: approval.riskLevel,
      targetOrigin: action.targetOrigin ?? null,
      argumentSummary: action.argumentSummary ?? null,
      ...(action.unclassified ? { unclassified: true } : {}),
      ...(action.agentType === undefined ? {} : { agentType: action.agentType }),
    });
    this.publishApproval(this.deps.approvals.mustGet(approval.id));
  }

  /**
   * Settle a review job's verdict (ADR-0002 amendment 4, B4). `allow_once` and `deny` decide the
   * request as `reviewer:<model>`; anything else escalates it to the thread. A verdict after
   * another decision, or for a changed action, settles nothing. Returns the review run's status.
   */
  completeReview(reviewRun: RunRecord, ended: RunEnded): "succeeded" | "failed" {
    const approval = this.deps.approvals.get(String(reviewRun.config.approvalId) as ApprovalId);
    if (!approval) return "failed";
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "") : "";
    const result = reply ? parseApprovalReview(reply) : undefined;
    const status = result ? "succeeded" : "failed";
    if (approval.decision) {
      this.event(approval.runId, {
        phase: "review_late",
        approvalId: approval.id,
        reviewRunId: reviewRun.id,
        ...(result ? { verdict: result.verdict } : {}),
      });
      return status;
    }
    const escalate = (why: string): "succeeded" | "failed" => {
      this.event(approval.runId, {
        phase: "review_escalated",
        approvalId: approval.id,
        reviewRunId: reviewRun.id,
        reason: why,
      });
      const requester = this.deps.runs.get(approval.runId);
      if (requester && approval.messageId === undefined) this.postForHumans(requester, approval);
      return status;
    };
    if (reviewRun.config.actionSha256 !== actionHash(approval)) return escalate("action_changed");
    if (!result)
      return escalate(ended.outcome === "completed" ? "unreadable_verdict" : "review_failed");
    if (result.verdict === "escalate") return escalate(`reviewer: ${result.reason}`);
    const model = typeof reviewRun.config.model === "string" ? reviewRun.config.model : "unknown";
    try {
      this.decide(approval.id, result.verdict, decidedByReviewer(model), result.reason);
    } catch (error) {
      if (!(error instanceof DeskmatesError) || error.code !== "invalid_transition") throw error;
      this.event(approval.runId, {
        phase: "review_late",
        approvalId: approval.id,
        reviewRunId: reviewRun.id,
        verdict: result.verdict,
      });
    }
    return status;
  }

  /**
   * Settle a pending approval. `decidedBy` is `human:<authorId>`, `bot:<botId>` or `rule:<id>`.
   * A live wait is released by moving the run back to `running`; a parked run is left for the
   * scheduler, which resumes it on the next pass.
   */
  decide(
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): DecideResult {
    return this.deps.bus.batch(() =>
      this.deps.approvals.transaction(() =>
        this.decideWithinTransaction(approvalId, decision, decidedBy, reason),
      ),
    );
  }

  private decideWithinTransaction(
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): DecideResult {
    const current = this.deps.approvals.mustGet(approvalId);
    const continuation = current.kind === "continuation";
    const egress = current.kind === "egress";
    if (egress && decision === "allow_once") {
      throw new DeskmatesError(
        "validation",
        "an egress decision is allow_always (allow this site for the workspace) or deny",
      );
    }
    if (continuation && decision !== "allow_once" && decision !== "deny") {
      throw new DeskmatesError("validation", "a continuation decision is continue or stop");
    }
    if (continuation) {
      const owner = this.deps.runs.mustGet(current.runId);
      if (
        owner.status !== "waiting_continuation" ||
        owner.resumePayload?.approvalId !== approvalId
      ) {
        throw new DeskmatesError(
          "invalid_transition",
          "run is not awaiting this continuation decision",
        );
      }
      if (
        !continuationAllowed(owner.config, Number(owner.config.continuationCount ?? 0)) &&
        decision === "allow_once"
      ) {
        throw new DeskmatesError("invalid_transition", "continuation limit reached");
      }
    }
    if (continuation && decision === "allow_once") {
      const owner = this.deps.runs.mustGet(current.runId);
      const expiresAt = owner.config.continuationExpiresAt;
      if (typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now()) {
        throw new DeskmatesError("invalid_transition", "continuation window expired");
      }
    }
    const decided = this.deps.approvals.decide(approvalId, decision, decidedBy, reason);
    let rule: ApprovalRule | undefined;
    if (decision === "allow_always" && !continuation && !egress) {
      rule = this.deps.rules.create({
        botId: decided.botId,
        matcher: matcherFromAction(decided.action),
        decision: "allow_always",
        createdBy: decidedBy,
        createdFromApprovalId: decided.id,
      });
      this.deps.approvals.setRule(decided.id, rule.id);
    }
    const approval = this.deps.approvals.mustGet(approvalId);
    this.event(approval.runId, {
      phase: "decided",
      approvalId,
      decision,
      decidedBy,
      ...(reason === undefined ? {} : { reason }),
      ...(rule === undefined ? {} : { ruleId: rule.id }),
    });
    if (approval.threadId) {
      // The echo carries the attachment so the UI updates the card in place. It wakes nobody:
      // the requester's run is resumed by the scheduler, and the deciders already know.
      const verb = continuation
        ? decision === "deny"
          ? "Stopped"
          : "Continued"
        : decision === "deny"
          ? "Denied"
          : "Approved";
      const message = this.deps.messages.append({
        threadId: approval.threadId,
        authorKind: "system",
        authorId: "",
        body: `${verb} by ${decidedBy}${reason ? `: ${reason}` : ""}`,
        attachments: [approvalAttachment(approvalId)],
        relayCount: 0,
      });
      this.deps.bus.publish({
        type: "thread_message",
        threadId: approval.threadId,
        message,
      });
    }
    this.publishApproval(approval);
    const run = this.deps.runs.get(approval.runId);
    if (continuation && run?.status === "waiting_continuation") {
      if (decision === "deny") {
        const path =
          typeof run.config.handoffPath === "string" ? run.config.handoffPath : undefined;
        const stopped = this.deps.runs.transition(run.id, "stopped", {
          summary: {
            done: path
              ? `Partial work handoff: ${path}`
              : "Stopped after exhausting the turn budget; no handoff file is available.",
            filesChanged: path ? [path] : [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: "",
          },
        });
        this.deps.router.runEnded(stopped);
        this.deps.bus.publish(
          stopped.threadId
            ? { type: "run_status", threadId: stopped.threadId, run: stopped }
            : { type: "run_status", run: stopped },
        );
        // ADR-0016 amendment 1, decision 8: `stopped` is a terminal outcome the delegator hears.
        const published: GatewayEvent[] = [];
        announceDelegationOutcome(this.deps, stopped, published);
        for (const event of published) this.deps.bus.publish(event);
      } else {
        const count = Number(run.config.continuationCount ?? 0) + 1;
        this.deps.runs.setConfig(run.id, { continuationCount: count, continuationExpiresAt: null });
      }
    }
    if (run?.status === "waiting_approval_live") this.transition(run.id, "running");
    return { approval, ...(rule === undefined ? {} : { rule }) };
  }

  /**
   * Close every pending approval of a run that will never resume, e.g. a cancelled one. Each is
   * recorded as a `deny` by `decidedBy` (a `system:` actor), so it leaves every pending list and
   * its card says why; no rule is stored and nothing is resumed. The caller has already moved the
   * run to a terminal status, which is what keeps the scheduler from resuming it.
   */
  closeForRun(runId: RunId, decidedBy: string, reason: string): Approval[] {
    return this.deps.bus.batch(() =>
      this.deps.approvals.transaction(() =>
        this.deps.approvals.pendingForRun(runId).map((pending) => {
          const approval = this.deps.approvals.decide(pending.id, "deny", decidedBy, reason);
          this.event(runId, {
            phase: "decided",
            approvalId: approval.id,
            decision: "deny",
            decidedBy,
            reason,
            closed: true,
          });
          if (approval.threadId) {
            const message = this.deps.messages.append({
              threadId: approval.threadId,
              authorKind: "system",
              authorId: "",
              body: `Closed by ${decidedBy}: ${reason}`,
              attachments: [approvalAttachment(approval.id)],
              relayCount: 0,
            });
            this.deps.bus.publish({ type: "thread_message", threadId: approval.threadId, message });
          }
          this.publishApproval(approval);
          return approval;
        }),
      ),
    );
  }

  /** What the sidecar's hook gets back for a settled approval. */
  response(approval: Approval): ApprovalResponse {
    if (approval.decision === "deny") {
      return {
        type: "approval_response",
        approvalId: approval.id,
        decision: "deny",
        reason: denyReason(approval.decidedBy, approval.reason),
      };
    }
    return { type: "approval_response", approvalId: approval.id, decision: "allow" };
  }

  /** Ledger `approval` event on a run, published to SSE like any other. */
  event(runId: RunId, payload: Record<string, unknown>): void {
    this.deps.events.append({ runId, kind: "approval", payload });
  }

  publishApproval(approval: Approval): void {
    this.deps.bus.publish({
      type: "approval",
      ...(approval.threadId ? { threadId: approval.threadId } : {}),
      approval,
    });
  }

  private base(run: RunRecord, req: ApprovalRequest) {
    return {
      ...(req.kind === "egress" ? { kind: "egress" as const } : {}),
      id: req.approvalId,
      runId: run.id,
      botId: run.botId,
      ...(run.threadId ? { threadId: run.threadId as ThreadId } : {}),
      action: req.action,
      riskLevel: req.riskLevel,
      ...(req.toolUseId === undefined ? {} : { toolUseId: req.toolUseId }),
    };
  }

  /** The human's original instruction: the thread message that woke this run. */
  private instructionFor(run: RunRecord): string | undefined {
    if (run.triggerKind !== "thread_message") return undefined;
    return this.deps.messages.get(run.triggerRef as MessageId)?.body;
  }

  private transition(runId: RunId, to: RunStatus): void {
    const run = this.deps.runs.transition(runId, to);
    this.deps.bus.publish(
      run.threadId
        ? { type: "run_status", threadId: run.threadId, run }
        : { type: "run_status", run },
    );
  }
}
