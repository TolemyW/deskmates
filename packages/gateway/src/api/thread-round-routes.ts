// Request rounds of a thread (ADR-0005 amendment 4): list them with each member's derived state,
// cancel one round and its descendants, retry one failed member. The guard has already resolved
// the thread to the caller's workspace; below Admin one acts only on rounds one started.

import {
  type BotId,
  DeskmatesError,
  type MessageId,
  type ThreadId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { cancelRound } from "../threads/round-cancel.js";
import { requestActorId } from "./actor.js";
import { startedRun } from "./side-chat-guard.js";
import { actsBelowAdmin } from "./workspace-access.js";

const LIST_DEFAULT = 20;
const LIST_MAX = 100;

export function registerThreadRoundRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  const roundIn = (threadId: ThreadId, messageId: MessageId) => {
    ctx.threads.mustGet(threadId);
    const round = ctx.rounds.get(messageId);
    if (!round || round.threadId !== threadId)
      throw new DeskmatesError("not_found", "round not found", { threadId, messageId });
    return round;
  };
  // ADR-0022 amendment 6 W5: below Admin, one acts only on a round one's own message started
  // (or any round of one's own one-bot chat), the same rule as for runs.
  const guard = (
    request: FastifyRequest,
    threadId: ThreadId,
    messageId: MessageId,
    action: string,
  ) => {
    const workspaceId = ctx.ownership.workspaceOf("thread", threadId);
    if (workspaceId === undefined || !actsBelowAdmin(ctx, request, workspaceId)) return;
    const started = startedRun(ctx, request, {
      threadId,
      triggerKind: "thread_message",
      triggerRef: messageId,
    });
    if (!started)
      throw new DeskmatesError("forbidden", `a Member may ${action} only for rounds they started`, {
        reason: "round_not_started_by_you",
      });
  };

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/threads/:id/rounds",
    async (request) => {
      const threadId = request.params.id as ThreadId;
      ctx.threads.mustGet(threadId);
      const asked = Number.parseInt(request.query.limit ?? "", 10);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIST_MAX) : LIST_DEFAULT;
      return { rounds: ctx.rounds.list(threadId, limit) };
    },
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/threads/:id/rounds/:messageId/cancel",
    async (request) => {
      const threadId = request.params.id as ThreadId;
      const messageId = request.params.messageId as MessageId;
      roundIn(threadId, messageId);
      guard(request, threadId, messageId, "cancel a round");
      const by = decidedByHuman(requestActorId(request, request.body));
      const result = cancelRound(
        {
          rounds: ctx.rounds,
          runs: ctx.runs,
          walks: ctx.walks,
          cancelRun: (runId, actor) => scheduler.cancel(runId, actor),
        },
        messageId,
        by,
      );
      return { ...result, round: ctx.rounds.get(messageId) };
    },
  );

  app.post<{ Params: { id: string; messageId: string; botId: string } }>(
    "/api/threads/:id/rounds/:messageId/members/:botId/retry",
    async (request, reply) => {
      const threadId = request.params.id as ThreadId;
      const messageId = request.params.messageId as MessageId;
      roundIn(threadId, messageId);
      guard(request, threadId, messageId, "retry a round member");
      const result = ctx.router.retryRoundMember(messageId, request.params.botId as BotId);
      if (result.created) scheduler.kick();
      return reply
        .code(result.created ? 201 : 200)
        .send({ run: result.run, round: ctx.rounds.get(messageId) });
    },
  );
}
