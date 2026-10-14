// `GET /api/events`: server-sent events for the operator UI. Emits `run_status`, `run_event` and
// `thread_message`, optionally filtered by `?threadId=`. A comment line every 15 s keeps proxies
// from closing the idle connection. A stream opened with a browser session is registered with the
// session's live connections, so logout, logout-all, a password change or a revocation closes it
// (ADR-0022 P1); one opened by a service principal closes when it is disabled or its token
// rotated (ADR-0022 amendment 2).
//
// Since ADR-0022 P2/P3 a stream belongs to one tenant: every event is resolved to the tenant that
// owns it (thread, run, approval, workspace or cost alert) and written only to that tenant's
// streams. An event whose owner cannot be resolved is dropped, never broadcast. Presence counts
// the stream for its tenant only.

import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { liveKeyOf } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import type { GatewayEvent } from "../events/bus.js";
import type { ConversationFacts, OwnedKind } from "../tenancy/ownership.js";
import { requestTenant } from "./route-policy.js";
import { workspaceRole } from "./workspace-access.js";

export const SSE_HEARTBEAT_MS = 15_000;

export function formatSseEvent(event: GatewayEvent, id: number): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerEventsRoute(
  app: FastifyInstance,
  ctx: GatewayContext,
  heartbeatMs: number = SSE_HEARTBEAT_MS,
): void {
  const open = new Set<ServerResponse>();
  let nextId = 1;
  // One lookup per event, shared by every open stream.
  const scopes = new WeakMap<GatewayEvent, EventScope | null>();
  const scopeOf = (event: GatewayEvent): EventScope | null => {
    const cached = scopes.get(event);
    if (cached !== undefined) return cached;
    const scope = eventScope(ctx, event) ?? null;
    scopes.set(event, scope);
    return scope;
  };

  app.get<{ Querystring: { threadId?: string } }>("/api/events", (request, reply) => {
    const threadId = request.query.threadId;
    const tenantId = requestTenant(request);
    // Checked before the response starts, so a refusal is an ordinary 429.
    if (tenantId !== undefined)
      ctx.quotas.assertConnectionRoom("event_stream", ctx.presence.streams(tenantId));
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    open.add(res);
    // One open stream is what "a human is online" means in M1 (ADR-0002 definitions): with none,
    // the approval broker defers an L2 request at once instead of burning the short wait.
    const closePresence = ctx.presence.open(tenantId);

    // Each event is filtered for this subscriber (ADR-0022 amendment 6 W1, W6, W7): its role in
    // the event's workspace, read at delivery so a role change applies to the next event, and
    // the private audience of the event's conversation.
    const principal = request.principal;
    const userId = principal?.kind === "user" ? principal.userId : undefined;
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (threadId && (!("threadId" in event) || event.threadId !== threadId)) return;
      const scope = scopeOf(event);
      if (scope === null || scope.tenantId !== tenantId) return;
      if (!mayReceive(ctx, request, userId, event, scope)) return;
      res.write(formatSseEvent(event, nextId++));
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();

    const liveKey = liveKeyOf(request.principal);
    const unregisterLive =
      liveKey !== undefined
        ? ctx.auth.live.register(
            liveKey,
            () => {
              res.end();
              res.destroy();
            },
            tenantId,
          )
        : () => {};

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
      closePresence();
      unregisterLive();
    };
    request.raw.on("close", cleanup);
    res.on("close", cleanup);
  });

  // An SSE connection is never idle, so end them ourselves before the server closes.
  app.addHook("preClose", async () => {
    for (const res of open) {
      res.end();
      res.destroy();
    }
    open.clear();
  });
}

/** Where an event belongs: its tenant, its workspace and, when it has one, its conversation. */
export interface EventScope {
  tenantId: string;
  workspaceId: string | undefined;
  conversation: ConversationFacts | undefined;
}

/** The event types a Guest's stream carries: conversation, board and workspace facts only. */
const GUEST_EVENTS: ReadonlySet<GatewayEvent["type"]> = new Set([
  "thread_message",
  "thread_members",
  "thread_activity",
  "thread_pins",
  "workspace",
  "board",
]);

function eventRow(event: GatewayEvent): [OwnedKind, string] | undefined {
  switch (event.type) {
    case "thread_message":
    case "thread_members":
    case "thread_activity":
      return ["thread", event.threadId];
    case "run_status":
      return ["run", event.run.id];
    case "run_event":
      return ["run", event.event.runId];
    case "approval":
      return ["approval", event.approval.id];
    case "cost_alert":
      return ["costAlert", event.alert.id];
    case "task_delivered":
      return event.threadId ? ["thread", event.threadId] : ["workspace", event.workspaceId];
    case "thread_pins":
    case "workspace_lock":
    case "workspace":
    case "board":
      return ["workspace", event.workspaceId];
  }
}

/** The scope of an event, or undefined when nothing on it resolves. */
export function eventScope(ctx: GatewayContext, event: GatewayEvent): EventScope | undefined {
  const tenantId = eventTenant(ctx, event);
  const row = eventRow(event);
  if (tenantId === undefined || row === undefined) return undefined;
  const [kind, id] = row;
  return {
    tenantId,
    workspaceId: ctx.ownership.workspaceOf(kind, id),
    conversation: ctx.ownership.conversationOf(kind, id),
  };
}

/** Whether one subscriber may receive an event (ADR-0022 amendment 6 W1, W6, W7). */
function mayReceive(
  ctx: GatewayContext,
  request: FastifyRequest,
  userId: string | undefined,
  event: GatewayEvent,
  scope: EventScope,
): boolean {
  const privateTo = scope.conversation?.privateTo ?? null;
  if (privateTo !== null && privateTo !== userId) return false;
  if (scope.workspaceId === undefined) return userId === undefined;
  const role = workspaceRole(ctx, request, scope.workspaceId);
  if (role === undefined) return false;
  if (role !== "guest") return true;
  return GUEST_EVENTS.has(event.type) && scope.conversation?.kind !== "bus";
}

/** The tenant that owns an event, or undefined when nothing on it resolves. */
export function eventTenant(ctx: GatewayContext, event: GatewayEvent): string | undefined {
  const owner = ctx.ownership;
  switch (event.type) {
    case "thread_message":
    case "thread_members":
    case "thread_activity":
      return owner.tenantOf("thread", event.threadId);
    case "thread_pins":
      return owner.tenantOf("workspace", event.workspaceId);
    case "run_status":
      return owner.tenantOf("run", event.run.id);
    case "run_event":
      return owner.tenantOf("run", event.event.runId);
    case "approval":
      return owner.tenantOf("approval", event.approval.id);
    case "workspace_lock":
    case "workspace":
    case "task_delivered":
    case "board":
      return owner.tenantOf("workspace", event.workspaceId);
    case "cost_alert":
      return owner.tenantOf("costAlert", event.alert.id);
  }
}
