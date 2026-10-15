// Sidecar-facing routes under `/internal/runs/:runId/*`, authenticated by the run's short-lived
// token (the same one the sidecar uses against the model proxy). The sidecar pushes events,
// lock requests, messages and its end-of-run report here; it never decides routing.

import {
  type ApprovalDecideRequest,
  type ApprovalId,
  type BrowserLockRequest,
  DeskmatesError,
  type EgressAllowlistResponse,
  type PostMessageRequest,
  type PostedMessageRouting,
  RUN_EVENT_KINDS,
  type RunId,
  type SidecarEvent,
  decidedByBot,
  mentionDiagnostics,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerAppShareInternalRoutes } from "../app-shares/app-share-routes.js";
import { assertBotMayDecide } from "../approvals/bot-decision.js";
import type { GatewayContext } from "../context.js";
import { bearerToken } from "../model-proxy/model-proxy.js";
import { networkProfiles } from "../network/network-policy.js";
import type { RunLifecycle } from "../scheduler/run-lifecycle.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { postDirectMessage } from "../threads/direct-messages.js";
import { applyEgressDecision } from "../workspaces/egress-policy.js";
import { registerBrowserOriginRoutes } from "./browser-origin-routes.js";
import { registerBrowserRetentionRoutes } from "./browser-retention-routes.js";
import { registerConnectorInternalRoutes } from "./connector-routes.js";
import { registerIntegrationInternalRoutes } from "./integration-routes.js";
import { registerKnowledgeInternalRoutes } from "./knowledge-routes.js";
import { registerMemoryInternalRoutes } from "./learned-memory-routes.js";
import { registerReplyPreviewRoutes } from "./reply-preview-routes.js";
import { registerTaskInternalRoutes } from "./task-internal-routes.js";
import {
  asApprovalDecision,
  asApprovalRequest,
  asAttachments,
  asRecord,
  asRunEnded,
} from "./validate.js";

/** The contracts list, which the `run_events.kind` CHECK constraint (0015) matches. */
const EVENT_KINDS: ReadonlySet<string> = new Set<string>(RUN_EVENT_KINDS);

type RunParams = { Params: { runId: string } };
type ApprovalParams = { Params: { runId: string; approvalId: string } };

export function registerInternalRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  lifecycle: RunLifecycle,
  scheduler: Scheduler,
): void {
  // Own scope: another run's token is 403 there, not 401 (ADR-0012 verification row 2).
  registerConnectorInternalRoutes(app, ctx);
  registerIntegrationInternalRoutes(app, ctx);
  app.register(async (scope) => {
    scope.addHook("preHandler", async (request: FastifyRequest<RunParams>) => {
      const token = bearerToken(request.headers.authorization);
      const verified = token ? ctx.tokens.verify(token) : undefined;
      if (!verified || verified.runId !== request.params.runId) {
        throw new DeskmatesError("token_rejected", "missing, expired or revoked run token", {
          runId: request.params.runId,
        });
      }
    });

    registerAppShareInternalRoutes(scope, ctx);
    registerBrowserOriginRoutes(scope, ctx);
    registerBrowserRetentionRoutes(scope, ctx);
    registerKnowledgeInternalRoutes(scope, ctx);
    registerMemoryInternalRoutes(scope, ctx);
    registerReplyPreviewRoutes(scope, ctx);
    registerTaskInternalRoutes(scope, ctx);

    scope.post<RunParams>("/internal/runs/:runId/events", async (request) => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const raw = Array.isArray(request.body) ? request.body : [request.body];
      const inputs = raw.map((item) => {
        const e = asRecord(item, "event") as Partial<SidecarEvent>;
        if (e.type !== "event" || typeof e.kind !== "string" || !EVENT_KINDS.has(e.kind)) {
          throw new DeskmatesError(
            "validation",
            "each item must be a SidecarEvent with a known kind",
            {
              got: e.type,
              kind: e.kind,
            },
          );
        }
        if (e.seq !== undefined && (!Number.isSafeInteger(e.seq) || e.seq <= 0)) {
          throw new DeskmatesError("validation", "event seq must be a positive safe integer", {
            seq: e.seq,
          });
        }
        // The dedup key is `(run, attempt, seq)`: a resumed process restarts its counter at 1, so
        // an event without the attempt it came from cannot be told from a redelivery. An attempt
        // that is not the run's current one is a stale process talking to a run that moved on.
        if (!Number.isSafeInteger(e.attempt) || (e.attempt ?? 0) <= 0) {
          throw new DeskmatesError("validation", "event attempt must be a positive safe integer", {
            attempt: e.attempt,
          });
        }
        if (e.attempt !== run.attempt) {
          throw new DeskmatesError("validation", "event attempt is not this run's attempt", {
            attempt: e.attempt,
            expected: run.attempt,
          });
        }
        return {
          runId,
          kind: e.kind,
          payload: asRecord(e.payload ?? {}, "payload"),
          attempt: e.attempt,
          ...(e.seq === undefined ? {} : { seq: e.seq }),
          ...(typeof e.ts === "string" ? { ts: e.ts } : {}),
        };
      });
      const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
      const stored = ctx.events.appendMany(
        inputs.filter(
          (event) =>
            event.kind !== "screenshot" ||
            (!ctx.locks.humanHolds(workspaceId) &&
              (event.payload.browserEpoch === undefined ||
                event.payload.browserEpoch === ctx.locks.epoch(workspaceId))),
        ),
      );
      return { stored: stored.length };
    });

    scope.post<RunParams>("/internal/runs/:runId/browser-lock", async (request) => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const bot = ctx.bots.mustGet(run.botId);
      const body = asRecord(request.body) as Partial<BrowserLockRequest>;
      if (body.op !== "acquire" && body.op !== "renew" && body.op !== "release") {
        throw new DeskmatesError("validation", "op must be acquire, renew or release");
      }
      const req: BrowserLockRequest = { type: "browser_lock", runId, op: body.op };
      if (typeof body.tabId === "string") req.tabId = body.tabId;
      const previous = ctx.locks
        .list(bot.workspaceId)
        .find((lock) => lock.holderRunId === runId)?.tabId;
      const result = ctx.locks.handle(bot.workspaceId, req);
      if (result.granted && req.op !== "release" && req.tabId && req.tabId !== previous) {
        ctx.events.append({
          runId,
          kind: "log",
          payload: { source: "browser_lock", op: "tab_acquired", tabId: req.tabId },
        });
      }
      return { ...result, epoch: ctx.locks.epoch(bot.workspaceId) };
    });

    /**
     * The allowlist of the run's workspace as it is now. The hook re-reads it before a navigation
     * check, so an operator edit reaches a run that started under the old list; the copy on the
     * `StartRunRequest` is only the fallback for a Gateway it cannot reach.
     */
    scope.get<RunParams>("/internal/runs/:runId/egress", async (request) => {
      const run = ctx.runs.mustGet(request.params.runId as RunId);
      const bot = ctx.bots.mustGet(run.botId);
      const workspace = ctx.workspaces.mustGet(bot.workspaceId);
      const response: EgressAllowlistResponse = {
        type: "egress_allowlist",
        egressAllowlist: workspace.egressAllowlist,
        // ADR-0027 amendment 1 decision 10: the hook matches LAN URLs against these.
        grants: networkProfiles(ctx).grantsFor(workspace.id),
        updatedAt: workspace.egressUpdatedAt ?? workspace.createdAt,
      };
      return response;
    });

    scope.post<RunParams>("/internal/runs/:runId/messages", async (request, reply) => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const body = asRecord(request.body) as Partial<PostMessageRequest>;
      if (
        (body.tool !== "thread_post" && body.tool !== "message_bot") ||
        typeof body.body !== "string"
      ) {
        throw new DeskmatesError(
          "validation",
          "expected a thread_post or message_bot PostMessageRequest with a body",
        );
      }
      const messageBody = body.body;
      const attachments = asAttachments(body.attachments);
      const response = ctx.bus.batch(() =>
        ctx.privateChats.postOnce(runId, body.requestId, JSON.stringify(body), () => {
          // A bot's message wakes other bots; it counts against its tenant's queue like a person's.
          ctx.quotas.assertQueueRoom(ctx.ownership.runTenant(runId));
          if (body.tool === "message_bot") {
            if (typeof body.to !== "string" || !body.to.trim()) {
              throw new DeskmatesError("validation", "message_bot requires a recipient name");
            }
            const result = postDirectMessage(ctx, run, body.to, messageBody, attachments);
            return result;
          }
          const { message, wakeBlocked } = ctx.bus.batch(() =>
            ctx.db.transaction(() => {
              const posted = ctx.router.postFromRunRouted(run, messageBody, attachments);
              const message = posted.message;
              ctx.bus.publish({ type: "thread_message", threadId: message.threadId, message });
              // ADR-0005 item 3 asks for a `thread_post` event kind; contracts has none yet, so `log`.
              ctx.events.append({
                runId,
                kind: "log",
                payload: { tool: "thread_post", threadId: message.threadId, messageId: message.id },
              });
              return posted;
            })(),
          );
          // Whom the message addressed, and what in it looks like an address and is not one: the
          // tool result tells the bot, so a hand-off that wakes nobody is seen where it was written.
          const members = ctx.threads.members(message.threadId);
          const names = new Map(members.map((member) => [member.botId as string, member.name]));
          const routing: PostedMessageRouting = {
            seq: message.seq,
            addressed: message.mentions.flatMap((mention) =>
              mention.kind === "bot" ? [names.get(mention.botId) ?? mention.botId] : [],
            ),
            everyone: message.mentions.some((mention) => mention.kind === "everyone"),
            ...mentionDiagnostics(messageBody, members, run.botId),
          };
          // A mention the Gateway did not deliver is said where it was written (issue #68); a
          // message that mentions nobody would have woken nobody anyway.
          if (wakeBlocked && message.mentions.length > 0) routing.wakeBlocked = wakeBlocked;
          const handoffs = ctx.privateChats.results(message.id);
          if (handoffs.length > 0) {
            routing.handoffs = handoffs.map((h) => ({
              name: h.name,
              delivered: h.messageId !== null,
              ...(h.reason ? { reason: h.reason } : {}),
            }));
            routing.unknown = routing.unknown.filter(
              (name) => !handoffs.some((h) => h.name === name.toLowerCase()),
            );
          }
          return { message, routing };
        }),
      );
      scheduler.kick();
      return reply.code(201).send(response);
    });

    // The PreToolUse hook met an L2 call. 200 with an `ApprovalResponse` when it is answered at
    // once (a stored rule, or nobody online so the run defers); 202 when the request is pending
    // and the hook should poll for the rest of its short wait.
    scope.post<RunParams>("/internal/runs/:runId/approvals", async (request, reply) => {
      const runId = request.params.runId as RunId;
      const run = ctx.runs.mustGet(runId);
      const result = ctx.broker.request(run, asApprovalRequest(runId, request.body));
      // Posting the request wakes the thread's other members; those runs are queued rows now.
      scheduler.kick();
      if (result === "pending") return reply.code(202).send();
      return result;
    });

    // The hook's poll during the short wait. 202 means "still pending", never a decision.
    scope.get<ApprovalParams>(
      "/internal/runs/:runId/approvals/:approvalId",
      async (request, reply) => {
        const runId = request.params.runId as RunId;
        const approval = ctx.approvals.get(request.params.approvalId as ApprovalId);
        if (!approval || approval.runId !== runId) {
          throw new DeskmatesError("not_found", "approval does not belong to this run", {
            runId,
            approvalId: request.params.approvalId,
          });
        }
        if (!approval.decision) return reply.code(202).send();
        return ctx.broker.response(approval);
      },
    );

    // The `approval_decide` tool. ADR-0002 amendment 2, A2: a member of the thread the request
    // was posted in may settle it; amendment 3, A10 takes out the requesting bot and any bot
    // upstream in the requesting run's wake chain, and allows a bot `allow_once` or `deny` only.
    // This is routing, not access control: a deciding bot is a soft boundary, the same kind as
    // SOUL or grouping (ADR-0004).
    scope.post<ApprovalParams>(
      "/internal/runs/:runId/approvals/:approvalId/decide",
      async (request) => {
        const runId = request.params.runId as RunId;
        const run = ctx.runs.mustGet(runId);
        const approval = ctx.approvals.mustGet(request.params.approvalId as ApprovalId);
        const body = asRecord(request.body) as Partial<ApprovalDecideRequest>;
        const decision = asApprovalDecision(body.decision);
        const reason = typeof body.reason === "string" ? body.reason : undefined;
        if (!approval.threadId || !ctx.threads.member(approval.threadId, run.botId)) {
          // Contracts has no 403-family code that fits a non-member caller, so this is a 400
          // `validation`; see the known gap in packages/gateway/docs/approvals.md.
          throw new DeskmatesError(
            "validation",
            "the calling bot is not a member of the approval's thread",
            { runId, botId: run.botId, approvalId: approval.id },
          );
        }
        // ADR-0002 amendment 3, A10: not the requester, not its delegator, and never Always.
        assertBotMayDecide(ctx, approval, run.botId, decision);
        await applyEgressDecision(ctx, approval.id, decision, decidedByBot(run.botId));
        const result = ctx.broker.decide(approval.id, decision, decidedByBot(run.botId), reason);
        ctx.events.append({
          runId,
          kind: "approval",
          payload: { phase: "decided_by_tool", approvalId: approval.id, decision },
        });
        scheduler.kick();
        return { approval: result.approval };
      },
    );

    scope.post<RunParams>("/internal/runs/:runId/ended", async (request) => {
      const runId = request.params.runId as RunId;
      // Everything is validated before `lifecycle.ended` writes anything: a bad `summary` or
      // `usage` used to surface as a 500 from a NOT NULL constraint or `reply.trim()`, after the
      // usage rows had already been written.
      const ended = asRunEnded(runId, request.body);
      const run = lifecycle.ended(runId, ended);
      scheduler.kick();
      return { run };
    });
  });
}
