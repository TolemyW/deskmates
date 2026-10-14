// The composite submit (issue #21, part 4): an external agent hands Deskmates one unit of work in
// one call. One database transaction creates a one-member `chat` thread bound to
// `(agent:<caller>, externalKey)` (the ADR-0017 decision 2 binding, unique per workspace), a
// planned task linked to it (ADR-0021), and the instruction as a must-reply human message posted
// through the normal router, which creates the woken run. Events are published only after the
// transaction commits. The key is the idempotency key: a repeat returns what exists and writes
// nothing. Every input is validated before anything is written, by the same validators the
// thread, task and message routes use.

import {
  type BotId,
  DeskmatesError,
  type SubmissionResponse,
  type SubmitResponse,
  type ThreadId,
  type WorkspaceId,
  agentChannel,
  isPastDeadline,
  isThreadLinkAttachmentMime,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { Principal } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { createTaskInput } from "../tasks/validate.js";
import { requestActorId } from "./actor.js";
import { requestTenant } from "./route-policy.js";
import { deadlineOf, externalRef } from "./thread-routes.js";
import { asAttachments, asRecord, requireString } from "./validate.js";

const SUBMIT_KEYS = [
  "externalKey",
  "botId",
  "title",
  "instruction",
  "description",
  "outputSchema",
  "deadline",
  "attachments",
  "authorId",
];

/** Attachments on one instruction; a submission names inputs, it does not upload a corpus. */
const SUBMIT_ATTACHMENTS_MAX = 20;

/** The channel a principal's submissions are bound under. */
export function submitChannel(principal: Principal | undefined): string {
  if (principal === undefined) throw new DeskmatesError("token_rejected", "not signed in");
  switch (principal.kind) {
    case "service":
      return agentChannel({ kind: "service", servicePrincipalId: principal.servicePrincipalId });
    case "user":
      return agentChannel({ kind: "user", userId: principal.userId });
    case "operator_token":
      return agentChannel({ kind: "operator" });
  }
}

function requiredKey(body: Record<string, unknown>): string {
  const key = externalRef(body, "externalKey");
  if (key === undefined)
    throw new DeskmatesError("validation", "externalKey is required", { key: "externalKey" });
  return key;
}

interface CheckedSubmit {
  externalKey: string;
  botId: BotId;
  task: { title: string; description?: string; outputSchema?: unknown };
  instruction: string;
  deadline?: string;
  attachments: ReturnType<typeof asAttachments>;
}

/** Validate the whole body; throws `validation` before anything is read or written. */
function checkedSubmit(raw: unknown): CheckedSubmit {
  const body = asRecord(raw);
  for (const key of Object.keys(body))
    if (!SUBMIT_KEYS.includes(key))
      throw new DeskmatesError("validation", `Unknown submit property: ${key}`, { key });
  const externalKey = requiredKey(body);
  const botId = requireString(body, "botId") as BotId;
  const instruction = requireString(body, "instruction");
  const deadline = deadlineOf(body) ?? undefined;
  // Work that can never start is refused rather than created and parked forever.
  if (deadline !== undefined && isPastDeadline({ deadline }))
    throw new DeskmatesError("validation", "deadline must be in the future", { key: "deadline" });
  const task = {
    title: body.title,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
  };
  // The task validator: title, description and the output schema subset (ADR-0021 amendment 2).
  const parsed = createTaskInput(task);
  const attachments = asAttachments(body.attachments);
  if (attachments.length > SUBMIT_ATTACHMENTS_MAX)
    throw new DeskmatesError(
      "validation",
      `attachments must be an array of at most ${SUBMIT_ATTACHMENTS_MAX} entries`,
    );
  // A thread link is a system handoff, never something a caller attaches.
  if (attachments.some((a) => isThreadLinkAttachmentMime(a.mimeType)))
    throw new DeskmatesError("validation", "attachments may not be thread links");
  return {
    externalKey,
    botId,
    task: {
      title: parsed.title,
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.outputSchema != null ? { outputSchema: parsed.outputSchema } : {}),
    },
    instruction,
    ...(deadline !== undefined ? { deadline } : {}),
    attachments,
  };
}

export function registerSubmitRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  /** What a repeated key answers: the ids that exist, and the instruction's runs as they are. */
  const existing = (workspaceId: WorkspaceId, threadId: ThreadId): SubmitResponse => {
    const task = ctx.tasks.firstLinkedToThread(workspaceId, threadId);
    const message = ctx.messages.first(threadId);
    if (!task || !message)
      throw new DeskmatesError(
        "invalid_transition",
        "this externalKey's thread no longer holds its submission",
        { threadId },
      );
    const runs = ctx.runs
      .list({ threadId })
      .filter((run) => run.triggerKind === "thread_message" && run.triggerRef === message.id);
    return { threadId, taskId: task.id, messageId: message.id, runs };
  };

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/submit", async (request, reply) => {
    const workspaceId = request.params.id as WorkspaceId;
    const input = checkedSubmit(request.body);
    const channel = submitChannel(request.principal);
    const found = ctx.threads.findByExternalKey(workspaceId, channel, input.externalKey);
    // A retry creates nothing, so it spends no budget: a client whose only run is still in
    // flight can recover the ids it lost.
    if (found) return reply.code(200).send(existing(workspaceId, found.id));
    // The same budgets as `POST /api/threads/:id/messages` (ADR-0022 amendment 2).
    ctx.quotas.assertQueueRoom(requestTenant(request));
    if (request.principal?.kind === "service")
      ctx.quotas.assertServicePrincipalBudget(request.principal);
    const authorId = requestActorId(request, request.body);
    // One transaction, one publish phase: anything the router publishes while it works is held
    // by the batch and dropped if the transaction rolls back.
    const created = ctx.bus.batch(() =>
      ctx.db
        .transaction(() => {
          const thread = ctx.threads.create({
            workspaceId,
            botIds: [input.botId],
            channel,
            externalKey: input.externalKey,
            title: input.task.title,
            ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
          });
          const task = ctx.tasks.create(workspaceId, {
            ...input.task,
            ownerBotId: input.botId,
            threadIds: [thread.id],
          });
          const posted = ctx.router.postHuman({
            threadId: thread.id,
            body: input.instruction,
            authorId,
            mustReply: true,
            ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
          });
          return { thread, task, posted };
        })
        .immediate(),
    );
    const { thread, task, posted } = created;
    ctx.bus.batch(() => {
      ctx.bus.publish({ type: "thread_members", threadId: thread.id });
      ctx.bus.publish({ type: "thread_message", threadId: thread.id, message: posted.message });
      for (const run of posted.runs)
        ctx.bus.publish({ type: "run_status", threadId: thread.id, run });
    });
    scheduler.kick();
    const response: SubmitResponse = {
      threadId: thread.id,
      taskId: task.id,
      messageId: posted.message.id,
      runs: posted.runs,
    };
    return reply.code(201).send(response);
  });

  app.get<{ Params: { id: string }; Querystring: { externalKey?: unknown } }>(
    "/api/workspaces/:id/submissions",
    async (request): Promise<SubmissionResponse> => {
      const workspaceId = request.params.id as WorkspaceId;
      const externalKey = requiredKey(asRecord(request.query, "query"));
      const thread = ctx.threads.findByExternalKey(
        workspaceId,
        submitChannel(request.principal),
        externalKey,
      );
      if (!thread)
        throw new DeskmatesError("not_found", "no submission with this externalKey", {
          externalKey,
        });
      return {
        thread,
        task: ctx.tasks.firstLinkedToThread(workspaceId, thread.id) ?? null,
        latestRun: ctx.runs.list({ threadId: thread.id }).at(-1) ?? null,
      };
    },
  );
}
