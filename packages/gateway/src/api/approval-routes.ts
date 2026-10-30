// Operator-facing approval routes: the pending inbox, one approval, the decide action, and the
// per-bot rule list (ADR-0002 amendment 2). ADR-0006 being deferred, these are unauthenticated
// like every other operator route.

import {
  APPROVAL_MODES,
  type Approval,
  type ApprovalId,
  type ApprovalMode,
  type BotId,
  DeskmatesError,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  decidedByHuman,
  isApprovalMode,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { checkedRuleMatcher } from "../approvals/always-rule.js";
import { AutoApprovalSettings } from "../approvals/auto-approval.js";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { applyEgressDecision, decideWithEgress } from "../workspaces/egress-policy.js";
import { requestActorId } from "./actor.js";
import {
  pendingApprovalGroupKey,
  pendingApprovalGroupPage,
  pendingInboxPage,
  visiblePending,
} from "./approval-inbox.js";
import { parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { requireOwnRun } from "./side-chat-guard.js";
import { threadApprovalsByIds } from "./thread-approvals.js";
import { registerToolTierRoutes } from "./tool-tier-routes.js";
import {
  asApprovalDecision,
  asRecord,
  asRuleMatcher,
  optionalBoolean,
  optionalString,
} from "./validate.js";
import { actsBelowAdmin, visibleOfKind } from "./workspace-access.js";

/** A bot's approval rules: 25 per page, at most 100 (#113 slice B, plan row 31). */
const APPROVAL_RULE_PAGE = { default: 25, max: 100 } as const;

export function registerApprovalRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  // ADR-0002 amendment 3, A5: the workspace's tool tier overrides, part of the approvals domain.
  registerToolTierRoutes(app, ctx);

  app.get<{
    Querystring: {
      status?: string;
      threadId?: string;
      botId?: string;
      cursor?: string;
      limit?: string;
      ids?: string;
    };
  }>("/api/approvals", async (request) => {
    // A chat asks only for the approvals its loaded messages name (#113 surface 26).
    if (request.query.ids !== undefined)
      return threadApprovalsByIds(ctx, request, { ...request.query, ids: request.query.ids });
    const status = request.query.status === "decided" ? "decided" : "pending";
    // The Attention inbox is paged with a total (#113 surface 23). A thread's pending approvals
    // are bounded by its parked runs; the decided history is not paged yet.
    if (status === "pending" && !request.query.threadId)
      return pendingInboxPage(ctx, request, request.query);
    return {
      approvals: visibleOfKind(
        ctx,
        request,
        "approval",
        ctx.approvals.list({
          tenantId: requestTenant(request),
          status,
          ...(request.query.threadId ? { threadId: request.query.threadId as ThreadId } : {}),
          ...(request.query.botId ? { botId: request.query.botId as BotId } : {}),
        }),
      ),
    };
  });

  app.get<{
    Querystring: { botId?: string; cursor?: string; limit?: string };
  }>("/api/approval-groups", async (request) =>
    pendingApprovalGroupPage(ctx, request, request.query),
  );

  app.get<{ Params: { id: string } }>("/api/approvals/:id", async (request) => ({
    approval: ctx.approvals.mustGet(request.params.id as ApprovalId),
  }));

  app.post<{ Params: { id: string } }>("/api/approvals/:id/decide", async (request) => {
    const body = asRecord(request.body);
    const decision = asApprovalDecision(body.decision);
    // A persistent answer writes configuration: allow_always stores an approval rule, and on an
    // egress ask it is "allow this site", which extends the allowlist. A Member answers once
    // (ADR-0022 amendment 1, C1/C3); bots deciding through the internal route are unchanged.
    const pending = ctx.approvals.mustGet(request.params.id as ApprovalId);
    const belowAdmin = actsBelowAdmin(
      ctx,
      request,
      ctx.ownership.workspaceOf("approval", pending.id) ?? "",
    );
    // Below Admin one answers only the approvals of the runs one started (amendment 6 W5).
    if (belowAdmin)
      requireOwnRun(ctx, request, ctx.runs.mustGet(pending.runId), "answer an approval");
    if (decision === "allow_always" && belowAdmin) {
      const egress = pending.kind === "egress";
      throw new DeskmatesError(
        "forbidden",
        egress
          ? "only an Admin may allow this site; a Member may allow once or deny"
          : "only an Admin may always allow; a Member may allow once or deny",
        { reason: "persistent_answer_needs_admin", decision },
      );
    }
    const reason = optionalString(body, "reason");
    // ADR-0002 amendment 3, A6: the human may edit the proposed Always matcher before saving.
    const matcher = body.matcher === undefined ? undefined : asRuleMatcher(body.matcher);
    const authorId = requestActorId(request, body);
    // An egress "allow this site" joins the allowlist first, so the proxy admits the host by the
    // time the run continues (ADR-0020 decision 2); a decision that then fails takes it out again.
    const result = await decideWithEgress(
      ctx,
      request.params.id as ApprovalId,
      decision,
      decidedByHuman(authorId),
      () =>
        ctx.broker.decide(
          request.params.id as ApprovalId,
          decision,
          decidedByHuman(authorId),
          reason,
          matcher === undefined ? {} : { matcher },
        ),
    );
    // A parked run whose approval just landed is resumed by the next scheduling pass.
    scheduler.kick();
    return result;
  });

  app.post<{ Params: { key: string } }>("/api/approval-groups/:key/decide", async (request) => {
    const body = asRecord(request.body);
    if (body.decision !== "allow_all" && body.decision !== "deny_all") {
      throw new DeskmatesError("validation", "decision must be allow_all or deny_all", {
        field: "decision",
      });
    }
    const approvals = visiblePending(ctx, request).filter(
      (approval) => pendingApprovalGroupKey(approval) === request.params.key,
    );
    const first = approvals[0];
    if (!first) throw new DeskmatesError("not_found", "approval group not found");
    const belowAdmin = actsBelowAdmin(
      ctx,
      request,
      ctx.ownership.workspaceOf("approval", first.id) ?? "",
    );
    // A group is one bot and one action, but retain the per-row ownership check as the authority.
    for (const approval of approvals) {
      if (belowAdmin)
        requireOwnRun(ctx, request, ctx.runs.mustGet(approval.runId), "answer an approval");
    }
    const author = decidedByHuman(requestActorId(request, body));
    const decided: Approval[] = [];
    for (const approval of approvals) {
      // "All" means every currently pending request in this group, never a persistent rule or
      // an egress allowlist change. Each request still receives its own one-time decision.
      const decision = body.decision === "deny_all" ? "deny" : "allow_once";
      await applyEgressDecision(ctx, approval.id, decision, author);
      decided.push(ctx.broker.decide(approval.id, decision, author).approval);
    }
    // Every row was decided and audited independently; one pass may now resume all parked runs.
    scheduler.kick();
    return { approvals: decided };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/continuation/decide", async (request) => {
    const run = ctx.runs.mustGet(request.params.id as RunId);
    requireOwnRun(ctx, request, run, "answer a continuation ask");
    if (run.status !== "waiting_continuation" || !run.resumePayload?.approvalId) {
      throw new DeskmatesError("invalid_transition", "run is not awaiting continuation");
    }
    const body = asRecord(request.body);
    if (body.decision !== "continue" && body.decision !== "stop") {
      throw new DeskmatesError("validation", "decision must be continue or stop");
    }
    const expiresAt = run.config.continuationExpiresAt;
    if (typeof expiresAt === "string" && Date.parse(expiresAt) <= Date.now()) {
      ctx.broker.decide(
        run.resumePayload.approvalId as ApprovalId,
        "deny",
        "system:expiry",
        "24-hour continuation window expired",
      );
      throw new DeskmatesError("invalid_transition", "continuation window expired");
    }
    const result = ctx.broker.decide(
      run.resumePayload.approvalId as ApprovalId,
      body.decision === "continue" ? "allow_once" : "deny",
      decidedByHuman(requestActorId(request, body)),
    );
    scheduler.kick();
    return { run: ctx.runs.mustGet(run.id), approval: result.approval };
  });

  // ADR-0002 amendment 6, D1: the workspace approval mode. Reading it is a member's; changing it
  // an Owner's or Admin's (route policy), and every change is audited.
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/auto-approval", async (request) => ({
    autoApproval: new AutoApprovalSettings(ctx.db).get(request.params.id as WorkspaceId),
  }));

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/auto-approval", async (request) => {
    const body = asRecord(request.body);
    // The legacy boolean of amendment 4 still means automatic or manual.
    const enabled = optionalBoolean(body, "enabled");
    if (body.mode !== undefined && !isApprovalMode(body.mode))
      throw new DeskmatesError("validation", `mode must be one of ${APPROVAL_MODES.join(", ")}`, {
        field: "mode",
      });
    const mode: ApprovalMode | undefined =
      body.mode ?? (enabled === undefined ? undefined : enabled ? "automatic" : "manual");
    // ADR-0002 amendment 3, A7: the expiry of an unattended request rides on the same setting.
    const expiryMinutes = body.expiryMinutes;
    if (expiryMinutes !== undefined && typeof expiryMinutes !== "number")
      throw new DeskmatesError("validation", "expiryMinutes must be a number", {
        field: "expiryMinutes",
      });
    if (mode === undefined && expiryMinutes === undefined)
      throw new DeskmatesError("validation", `mode must be one of ${APPROVAL_MODES.join(", ")}`, {
        field: "mode",
      });
    const workspaceId = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(workspaceId);
    return {
      autoApproval: new AutoApprovalSettings(ctx.db).change(
        workspaceId,
        {
          ...(mode === undefined ? {} : { mode }),
          ...(expiryMinutes === undefined ? {} : { expiryMinutes }),
        },
        requestActorId(request, body),
      ),
    };
  });

  // #113 slice B: a bot's rules are a numbered page (25, at most 100) with the honest total.
  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    "/api/bots/:id/approval-rules",
    async (request) => {
      const botId = request.params.id as BotId;
      ctx.bots.mustGet(botId);
      const query = parseOffsetQuery(request.query, APPROVAL_RULE_PAGE);
      const page = ctx.rules.page(botId, query);
      return { rules: page.rules, offset: query.offset, limit: query.limit, total: page.total };
    },
  );

  app.post<{ Params: { id: string } }>("/api/bots/:id/approval-rules", async (request, reply) => {
    const botId = request.params.id as BotId;
    ctx.bots.mustGet(botId);
    const body = asRecord(request.body);
    if (body.decision !== "allow_always" && body.decision !== "deny") {
      throw new DeskmatesError("validation", "a rule decision is allow_always or deny", {
        got: body.decision,
      });
    }
    const authorId = requestActorId(request, body);
    // A6: a pattern ending in the truncation marker is refused; an exact one is flagged.
    const checked = checkedRuleMatcher(asRuleMatcher(body.matcher));
    const rule = ctx.rules.create({
      botId,
      matcher: checked.matcher,
      decision: body.decision,
      createdBy: decidedByHuman(authorId),
    });
    return reply
      .code(201)
      .send({ rule, ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}) });
  });

  // ADR-0043 decision 6: a rule is edited in place, under the same validation as a new one.
  app.patch<{ Params: { id: string } }>("/api/approval-rules/:id", async (request) => {
    const rule = ctx.rules.mustGet(request.params.id);
    const body = asRecord(request.body);
    if (
      body.decision !== undefined &&
      body.decision !== "allow_always" &&
      body.decision !== "deny"
    ) {
      throw new DeskmatesError("validation", "a rule decision is allow_always or deny", {
        got: body.decision,
      });
    }
    if (body.matcher === undefined && body.decision === undefined)
      throw new DeskmatesError("validation", "nothing to update: send matcher or decision");
    const checked =
      body.matcher === undefined ? undefined : checkedRuleMatcher(asRuleMatcher(body.matcher));
    const updated = ctx.rules.update(
      rule.id,
      {
        ...(checked === undefined ? {} : { matcher: checked.matcher }),
        ...(body.decision === undefined
          ? {}
          : { decision: body.decision as "allow_always" | "deny" }),
      },
      decidedByHuman(requestActorId(request, body)),
    );
    if (rule.createdFromApprovalId) {
      const approval = ctx.approvals.get(rule.createdFromApprovalId);
      if (approval) ctx.broker.event(approval.runId, { phase: "rule_updated", ruleId: rule.id });
    }
    return {
      rule: updated,
      ...(checked !== undefined && checked.warnings.length > 0
        ? { warnings: checked.warnings }
        : {}),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/approval-rules/:id", async (request) => {
    const rule = ctx.rules.mustGet(request.params.id);
    ctx.rules.delete(rule.id, decidedByHuman(requestActorId(request, request.body ?? {})));
    // A rule that came from an Always decision is part of that run's story; a rule an operator
    // typed in outside any run has no run to record it on (ADR-0002 amendment 2, A3).
    if (rule.createdFromApprovalId) {
      const approval = ctx.approvals.get(rule.createdFromApprovalId);
      if (approval) {
        ctx.broker.event(approval.runId, { phase: "rule_deleted", ruleId: rule.id });
      }
    }
    return { deleted: true };
  });
}
