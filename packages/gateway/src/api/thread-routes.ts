// Thread routes: create, read, and post a human message (which wakes the member and creates the
// run row before anything else, design v0.3 §5 step 1). A channel adapter uses the same routes
// with two extra facts (ADR-0017 decision 2): `channel` + `externalKey` bind a thread to an
// external conversation, and `externalId` makes a post idempotent under webhook retries.

import {
  type BotId,
  DeskmatesError,
  type PageLimitPolicy,
  type Thread,
  type ThreadId,
  type ThreadSummary,
  WEB_CHANNEL,
  type WorkspaceId,
  isChannelMirrorThread,
  isChannelName,
  isExternalRef,
  isRequestedRoundMode,
  normalizeDeadline,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { type Principal, actorLabel } from "../auth/principal.js";
import { GROUP_ROUTING_DEFAULT } from "../config.js";
import type { GatewayContext } from "../context.js";
import { isOwnInquiry } from "../model-jobs/status-inquiries.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { parseMessageUploadIds, resolveMessageAttachments } from "./message-attachments.js";
import { threadsByIds } from "./name-lookup.js";
import { keysetPage, parseCursorQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import { limitOf, seqParam } from "./seq-slices.js";
import {
  asRecord,
  optionalBoolean,
  optionalString,
  requireString,
  requireStringArray,
} from "./validate.js";
import { actsBelowAdmin, visibleOfKind, workspaceRole } from "./workspace-access.js";

function channelOf(body: Record<string, unknown>): string {
  const channel = optionalString(body, "channel");
  if (channel === undefined) return WEB_CHANNEL;
  if (!isChannelName(channel)) {
    throw new DeskmatesError(
      "validation",
      "channel must be lower-case, start with a letter and be at most 32 characters",
      { channel },
    );
  }
  return channel;
}

export function externalRef(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value === undefined) return undefined;
  if (!isExternalRef(value)) {
    throw new DeskmatesError(
      "validation",
      `${key} must be non-empty printable text of at most 200 characters`,
      { key },
    );
  }
  return value;
}

/**
 * Issue #21: an ISO 8601 date-time with a zone, stored in canonical UTC form. `null` clears it
 * (PATCH only); undefined when the key is absent.
 */
export function deadlineOf(body: Record<string, unknown>): string | null | undefined {
  const value = body.deadline;
  if (value === undefined) return undefined;
  if (value === null) return null;
  const deadline = typeof value === "string" ? normalizeDeadline(value) : undefined;
  if (deadline === undefined) {
    throw new DeskmatesError(
      "validation",
      "deadline must be an ISO 8601 date-time with a time zone, e.g. 2026-10-09T18:00:00Z",
      { key: "deadline" },
    );
  }
  return deadline;
}

/** A transcript's newest window: 50 messages, at most 200 (#113 slice CH, plan row 25). */
export const MESSAGE_WINDOW: PageLimitPolicy = { default: 50, max: 200 };
/** A transcript tail after `afterSeq`: at most 200 per request; `hasMore` says ask again. */
export const MESSAGE_TAIL: PageLimitPolicy = { default: 200, max: 200 };
/** A chat rail page: 50 conversations besides pins and inboxes, at most 100 (plan row 24). */
export const THREAD_PAGE: PageLimitPolicy = { default: 50, max: 100 };
/** Incoming handoffs of a private chat: 20 per page, at most 100 (plan row 28). */
export const HANDOFF_PAGE: PageLimitPolicy = { default: 20, max: 100 };

export function registerThreadRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  // `groupRouting` is how this Gateway routes a message with no explicit recipient (ADR-0005
  // amendment 2), so the composer can say what an unaddressed message will do before it is sent.
  // `effectiveTurnBudget` is the turn budget the router enforces (ADR-0005 amendment 5 decision
  // 38): the workspace setting, else the thread row's; `null` when the workspace turned it off.
  const detail = (id: ThreadId) => {
    const thread = ctx.threads.mustGet(id);
    return {
      thread,
      members: ctx.threads.members(id),
      groupRouting: ctx.config.groupRouting ?? GROUP_ROUTING_DEFAULT,
      effectiveTurnBudget: ctx.limits.threadCaps(thread.workspaceId, thread.turnBudget).turnBudget,
    };
  };
  const summarize = (thread: Thread): ThreadSummary => {
    const latest = ctx.messages.latest(thread.id);
    const lastHandoff = ctx.privateChats.latest(thread.id);
    const privateChatBotId = ctx.privateChats.boundBot(thread.id);
    const pin = ctx.threadPins.get(thread.id);
    return {
      ...thread,
      ...(lastHandoff ? { lastHandoff } : {}),
      ...(privateChatBotId ? { privateChatBotId } : {}),
      ...(pin ? { pinPosition: pin.position } : {}),
      memberIds: ctx.threads.members(thread.id).map((member) => member.botId),
      ...(latest
        ? {
            lastMessage: {
              seq: latest.seq,
              authorKind: latest.authorKind,
              authorId: latest.authorId,
              excerpt: latest.body.slice(0, 160),
              ts: latest.ts,
            },
          }
        : {}),
    };
  };
  app.get<{
    Querystring: {
      workspaceId?: string;
      channel?: string;
      externalKey?: string;
      cursor?: string;
      limit?: string;
      q?: string;
      ids?: string;
    };
  }>("/api/threads", async (request) => {
    // A name lookup asks for the threads it labels, at most 100 (#113 §3.2).
    if (request.query.ids !== undefined) {
      const actor = actorLabel(request.principal);
      return {
        threads: threadsByIds(ctx, request, request.query.ids, request.query.workspaceId).map(
          (thread) => ({
            ...summarize(thread),
            unreadHandoffs: ctx.privateChats.unread(thread.id, actor),
          }),
        ),
      };
    }
    const { channel, externalKey } = request.query;
    const { cursor, limit, q } = request.query;
    // #113 slice CH (plan row 24): with `cursor`, `limit` or `q`, one page of a workspace's
    // chat rail. Without them the list stays whole for the channel and name lookups that
    // read it (a binding lookup by `externalKey` is one row).
    if (cursor !== undefined || limit !== undefined || q !== undefined) {
      const workspaceId = request.query.workspaceId as WorkspaceId | undefined;
      if (!workspaceId)
        throw new DeskmatesError("validation", "a thread page needs workspaceId", {
          field: "workspaceId",
        });
      const principal = request.principal;
      const viewerUserId = principal?.kind === "user" ? principal.userId : undefined;
      const includeBus = workspaceRole(ctx, request, workspaceId) !== "guest";
      const scope = [
        "threads",
        requestTenant(request),
        workspaceId,
        viewerUserId ?? null,
        includeBus,
        q ?? null,
      ];
      const query = parseCursorQuery(request.query, THREAD_PAGE, scope, ["string", "string"]);
      const rail = ctx.threads.railPage(workspaceId, {
        ...(viewerUserId ? { viewerUserId } : {}),
        includeBus,
        ...(q ? { q } : {}),
        limit: query.limit,
        ...(query.after ? { after: query.after as [string, string] } : {}),
      });
      const page = keysetPage(
        rail.rest,
        query.limit,
        (thread) => [thread.updatedAt, thread.id],
        scope,
      );
      const actor = actorLabel(request.principal);
      return {
        threads: visibleOfKind(ctx, request, "thread", [...rail.fixed, ...page.items], "guest").map(
          (thread) => ({
            ...summarize(thread),
            unreadHandoffs: ctx.privateChats.unread(thread.id, actor),
          }),
        ),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    if (channel !== undefined && !isChannelName(channel)) {
      throw new DeskmatesError("validation", "channel is not a channel name", { channel });
    }
    if (externalKey !== undefined && channel === undefined) {
      throw new DeskmatesError("validation", "externalKey needs channel");
    }
    // Only workspaces the caller belongs to, no other person's private chat and, for a Guest,
    // no bus thread (ADR-0022 amendment 6 W1, W6, W7).
    const threads = visibleOfKind(
      ctx,
      request,
      "thread",
      ctx.threads.list(request.query.workspaceId as WorkspaceId | undefined, {
        // A channel binding lookup also stays inside the caller's tenant (ADR-0022 P2).
        tenantId: requestTenant(request),
        ...(channel !== undefined ? { channel } : {}),
        ...(externalKey !== undefined ? { externalKey } : {}),
      }),
      "guest",
    );
    // The list carries what a chat list shows at a glance (members, newest message) so the
    // client opens a bot's private chat or draws a preview without one request per thread.
    return {
      threads: threads.map((thread) => ({
        ...summarize(thread),
        unreadHandoffs: ctx.privateChats.unread(thread.id, actorLabel(request.principal)),
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/private-chat", async (request) => {
    const botId = request.params.id as BotId;
    // Creating or adopting a bot's canonical private chat is an Admin's (ADR-0022 amendment 1);
    // a Member or Guest may read the one that exists.
    if (actsBelowAdmin(ctx, request, ctx.bots.mustGet(botId).workspaceId)) {
      const existing = ctx.privateChats.existing(botId);
      if (!existing) throw sideChatOnly("only an Admin opens a bot's private chat");
      return detail(existing.id);
    }
    const thread = ctx.privateChats.resolve(botId);
    return detail(thread.id);
  });
  // #113 slice CH: the handoff feed is newest first, 20 per page, older on request.
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/api/threads/:id/activity",
    async (request) => {
      const id = request.params.id as ThreadId;
      const actor = actorLabel(request.principal);
      const scope = ["thread-activity", requestTenant(request), id, actor];
      const query = parseCursorQuery(request.query, HANDOFF_PAGE, scope, ["number"]);
      const rows = ctx.privateChats.list(id, actor, {
        limit: query.limit,
        ...(query.after ? { beforeSeq: Number(query.after[0]) } : {}),
      });
      const page = keysetPage(rows, query.limit, (handoff) => [handoff.seq], scope);
      return { handoffs: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  );

  app.post<{ Params: { id: string } }>("/api/threads/:id/pin", async (request) => {
    const id = request.params.id as ThreadId;
    const pin = ctx.threadPins.pin(id, actorLabel(request.principal));
    ctx.bus.publish({ type: "thread_pins", workspaceId: pin.workspaceId });
    return { pin };
  });

  app.delete<{ Params: { id: string } }>("/api/threads/:id/pin", async (request) => {
    const id = request.params.id as ThreadId;
    const workspaceId = ctx.threads.mustGet(id).workspaceId;
    const deleted = ctx.threadPins.unpin(id);
    if (deleted) ctx.bus.publish({ type: "thread_pins", workspaceId });
    return { deleted };
  });
  app.post<{ Params: { id: string } }>("/api/threads/:id/activity/read", async (request) => {
    const through = asRecord(request.body).through;
    if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0)
      throw new DeskmatesError("validation", "through must be a nonnegative integer");
    const threadId = request.params.id as ThreadId;
    ctx.privateChats.markRead(threadId, actorLabel(request.principal), through);
    ctx.bus.publish({ type: "thread_activity", threadId });
    return { ok: true };
  });

  app.post("/api/threads", async (request, reply) => {
    const body = asRecord(request.body);
    const title = optionalString(body, "title");
    const channel = channelOf(body);
    const externalKey = externalRef(body, "externalKey");
    const workspaceId = requireString(body, "workspaceId") as WorkspaceId;
    const deadline = deadlineOf(body) ?? undefined;
    const botIds = requireStringArray(body, "botIds") as BotId[];
    // A Member or Guest opens only their own chat with one bot, on the operator UI's channel, with
    // no external binding; a person's is private to them (ADR-0022 amendment 6 W5 to W7).
    // Everything else creates group state and is an Admin's.
    const sideChat = actsBelowAdmin(ctx, request, workspaceId);
    if (sideChat && (new Set(botIds).size !== 1 || channel !== WEB_CHANNEL || externalKey))
      throw sideChatOnly(
        "a Member or Guest opens a private chat with one bot; only an Admin opens other chats",
      );
    // A one-Bot web chat is an identity, not a second conversation-creation mode. Admins always
    // resolve that Bot's canonical inbox; only Members deliberately create their own side chat.
    if (!sideChat && channel === WEB_CHANNEL && externalKey === undefined && botIds.length === 1) {
      const bot = ctx.bots.mustGet(botIds[0] as BotId);
      if (bot.workspaceId !== workspaceId) {
        throw new DeskmatesError("validation", "bot belongs to another workspace", {
          botId: bot.id,
          workspaceId,
        });
      }
      const thread = ctx.privateChats.resolve(bot.id);
      return reply.code(200).send({ thread, members: ctx.threads.members(thread.id) });
    }
    if (externalKey !== undefined) {
      // A binding is unique per workspace and channel: a retried or raced create returns the
      // thread that exists there, never one of another workspace (ADR-0022 P3).
      const existing = ctx.threads.findByExternalKey(workspaceId, channel, externalKey);
      if (existing) {
        return reply
          .code(200)
          .send({ thread: existing, members: ctx.threads.members(existing.id) });
      }
    }
    const input = {
      workspaceId,
      botIds,
      channel,
      ...(externalKey !== undefined ? { externalKey } : {}),
      ...(title ? { title } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
      ...(sideChat ? { sideChatActor: actorLabel(request.principal) } : {}),
    };
    let thread: ReturnType<typeof ctx.threads.create>;
    try {
      thread = ctx.threads.create(input);
    } catch (err) {
      // Two deliveries creating the same binding at once: the unique index refuses the second,
      // which then reads the first (ADR-0017 decision 2).
      const raced =
        externalKey !== undefined && isUniqueViolation(err)
          ? ctx.threads.findByExternalKey(workspaceId, channel, externalKey)
          : undefined;
      if (!raced) throw err;
      return reply.code(200).send({ thread: raced, members: ctx.threads.members(raced.id) });
    }
    return reply.code(201).send({ thread, members: ctx.threads.members(thread.id) });
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id", async (request) => {
    const id = request.params.id as ThreadId;
    return detail(id);
  });

  // Issue #21: the deadline is the only field a thread patch changes. A deadline already past
  // takes effect on the scheduler's next pass, which this kicks.
  app.patch<{ Params: { id: string } }>("/api/threads/:id", async (request) => {
    const id = request.params.id as ThreadId;
    const deadline = deadlineOf(asRecord(request.body));
    if (deadline === undefined) throw new DeskmatesError("validation", "deadline is required");
    ctx.threads.setDeadline(id, deadline ?? undefined);
    ctx.bus.publish({ type: "thread_members", threadId: id });
    scheduler.kick();
    return detail(id);
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/members", async (request) => {
    const id = request.params.id as ThreadId;
    const body = asRecord(request.body);
    const changed = ctx.threads.addMembers(id, requireStringArray(body, "botIds") as BotId[]);
    if (changed) ctx.bus.publish({ type: "thread_members", threadId: id });
    return detail(id);
  });

  app.delete<{ Params: { id: string; botId: string } }>(
    "/api/threads/:id/members/:botId",
    async (request) => {
      const id = request.params.id as ThreadId;
      const changed = ctx.threads.removeMember(id, request.params.botId as BotId);
      if (changed) ctx.bus.publish({ type: "thread_members", threadId: id });
      return detail(id);
    },
  );

  // #113 slice CH: a transcript is a chronological flow. Without `afterSeq` it is the newest
  // window (50, at most 200) with `hasOlder` and `beforeSeq` to load older messages; with
  // `afterSeq` it is a bounded tail (at most 200) with `hasMore`.
  app.get<{
    Params: { id: string };
    Querystring: { afterSeq?: string; beforeSeq?: string; limit?: string };
  }>("/api/threads/:id/messages", async (request) => {
    const id = request.params.id as ThreadId;
    ctx.threads.mustGet(id);
    const afterSeq = seqParam(request.query.afterSeq, "afterSeq");
    const beforeSeq = seqParam(request.query.beforeSeq, "beforeSeq");
    if (afterSeq !== undefined && beforeSeq !== undefined)
      throw new DeskmatesError("validation", "use afterSeq or beforeSeq, not both", {
        field: "beforeSeq",
      });
    if (afterSeq !== undefined) {
      const slice = ctx.messages.listSlice(id, {
        afterSeq,
        limit: limitOf(request.query.limit, MESSAGE_TAIL),
      });
      return { messages: slice.messages, hasMore: slice.more };
    }
    const slice = ctx.messages.listSlice(id, {
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      limit: limitOf(request.query.limit, MESSAGE_WINDOW),
    });
    return { messages: slice.messages, hasOlder: slice.more };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/messages", async (request, reply) => {
    const body = asRecord(request.body);
    const authorId = requestActorId(request, body);
    const externalId = externalRef(body, "externalId");
    // Issue #21: a must-reply message turns a silent end of the run it wakes into `no_reply`.
    const mustReply = optionalBoolean(body, "mustReply") === true;
    // ADR-0005 amendment 4, decision 29: one-by-one for this @everyone message only.
    const roundMode = body.roundMode;
    if (roundMode !== undefined && !isRequestedRoundMode(roundMode))
      throw new DeskmatesError("validation", 'roundMode must be "parallel" or "sequential"', {
        roundMode,
      });
    const threadId = request.params.id as ThreadId;
    const thread = ctx.threads.mustGet(threadId);
    // A thread owned by an external chat channel is a read-only mirror on the Web: its human
    // converses on that channel (ADR-0017 amendment 2). The in-process channel plugin posts
    // through the channel manager, not this route; the shared operator credential stays the
    // legacy standalone adapters' bridge.
    if (isChannelMirrorThread(thread) && postsAsPersonOrAgent(request.principal))
      throw new DeskmatesError(
        "channel_thread_read_only",
        `this chat belongs to the ${thread.channel} channel; reply there`,
        { channel: thread.channel, threadId },
      );
    const role = workspaceRole(ctx, request, thread.workspaceId);
    // ADR-0014 A5 decision 42: a person's own completed uploads, resolved in this workspace; a
    // Guest attaches nothing. With an attachment the text may be blank.
    const uploadIds = parseMessageUploadIds(body.attachments);
    const attachments =
      uploadIds.length === 0 || role === "guest"
        ? []
        : resolveMessageAttachments(
            ctx.db,
            thread.workspaceId,
            actorLabel(request.principal),
            uploadIds,
          );
    if (role === "guest" && uploadIds.length > 0)
      throw new DeskmatesError("validation", "a Guest attaches no files", {
        field: "attachments",
        reason: "attachment_not_attachable",
      });
    const text =
      attachments.length === 0
        ? requireString(body, "body")
        : typeof body.body === "string"
          ? body.body
          : "";
    if (role === "guest") {
      // A Guest reads the shared chats and posts in none; a post in their own private inquiry
      // is answered by a tool-free status job, never by a bot run (ADR-0022 amendment 7 S1).
      const userId = request.principal?.kind === "user" ? request.principal.userId : undefined;
      if (userId === undefined || !isOwnInquiry(thread, userId))
        throw new DeskmatesError("forbidden", "a Guest reads this chat but does not post in it", {
          reason: "guest_read_only",
        });
      ctx.quotas.assertQueueRoom(requestTenant(request));
      const asked = ctx.modelJobs.inquiries.ask({
        thread,
        userId,
        authorId,
        body: requireString(body, "body"),
        ...(externalId !== undefined ? { externalId } : {}),
      });
      if (asked.duplicate) return reply.code(200).send(asked);
      ctx.bus.publish({ type: "thread_message", threadId, message: asked.message });
      for (const run of asked.runs) ctx.bus.publish({ type: "run_status", threadId, run });
      scheduler.kick();
      return reply.code(201).send(asked);
    }
    if (actsBelowAdmin(ctx, request, thread.workspaceId)) {
      // A Member posts in the workspace's shared chats and their own private chats, never in a
      // bus thread, and never adds a bot by a mention (amendment 6 W5). Another person's private
      // chat is already the guard's 404.
      if (thread.kind !== "chat")
        throw sideChatOnly("only an Admin posts in a conversation between bots");
      if (ctx.router.mentionsThatJoin(threadId, text).length > 0)
        throw sideChatOnly("only an Admin adds a bot to a chat");
    }
    ctx.quotas.assertQueueRoom(requestTenant(request));
    // A service principal also spends its own budget (ADR-0022 amendment 2).
    if (request.principal?.kind === "service")
      ctx.quotas.assertServicePrincipalBudget(request.principal);
    const previousMembers = ctx.threads.members(threadId).length;
    const result = ctx.router.postHuman({
      threadId,
      body: text,
      authorId,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
      ...(mustReply ? { mustReply } : {}),
      ...(roundMode !== undefined ? { roundMode } : {}),
    });
    // A redelivery: the stored message, no new run, nothing to publish or kick.
    if (result.duplicate) return reply.code(200).send(result);
    if (ctx.threads.members(threadId).length !== previousMembers) {
      ctx.bus.publish({ type: "thread_members", threadId });
    }
    ctx.bus.publish({
      type: "thread_message",
      threadId: result.message.threadId,
      message: result.message,
    });
    for (const run of result.runs) {
      ctx.bus.publish({ type: "run_status", threadId: result.message.threadId, run });
    }
    scheduler.kick();
    return reply.code(201).send(result);
  });
}

/** A signed-in person or a service principal: never a channel's own ingress. */
function postsAsPersonOrAgent(principal: Principal | undefined): boolean {
  return principal?.kind === "user" || principal?.kind === "service";
}

/** The typed refusal of an act ADR-0022 amendment 1 leaves to Admins. */
function sideChatOnly(message: string): DeskmatesError {
  return new DeskmatesError("forbidden", message, { reason: "admin_owns_the_group" });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
