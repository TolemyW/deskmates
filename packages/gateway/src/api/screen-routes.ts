// Operator-only screen access. Tickets scope one browser WebSocket to one fixed runtime target.
// The proxy is the only way a browser reaches a workspace screen, a bot's or the shared takeover
// display (ADR-0022 amendment 1, C7): it authenticates to the workspace's VNC server with a
// password that stays in the Gateway and offers the browser no authentication, and a control
// stream ends the moment the takeover lease it was opened under does.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  type BotId,
  type BotScreen,
  DeskmatesError,
  type ScreenAccess,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { liveKeyOf } from "../auth/principal.js";
import type { GatewayContext } from "../context.js";
import { requestTenant } from "./route-policy.js";
import { holderOf } from "./takeover-routes.js";
import { asRecord } from "./validate.js";
import { ByteReader, authenticateUpstream, greetClient } from "./vnc-relay.js";

/** How long both RFB handshakes may take before the proxied connection is dropped. */
const HANDSHAKE_MS = 10_000;

const toBuffer = (data: Buffer | ArrayBuffer | Buffer[]): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

interface Ticket {
  id: string;
  workspaceId: WorkspaceId;
  address: string;
  /** The VNC password for `mode`; held by the Gateway, never sent to the browser. */
  password: string;
  origin: string;
  mode: "view" | "control";
  expires: number;
  epoch: number;
  /** Browser session that asked for the ticket; its revocation closes ticket and stream. */
  sessionId?: string;
  /** Tenant the ticket was issued in; only that tenant may close it (ADR-0022 P2). */
  tenantId: string;
  release: () => void;
}
export function registerScreenRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const tickets = new Map<string, Ticket>();
  const active = new Map<string, { ticket: Ticket; client: WebSocket; upstream: WebSocket }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const cleanup = () => {
    for (const [key, value] of tickets)
      if (value.expires < Date.now()) {
        tickets.delete(key);
        value.release();
      }
  };
  const close = (id: string) => {
    const item = active.get(id);
    if (!item) return;
    active.delete(id);
    item.ticket.release();
    item.client.terminate();
    item.upstream.terminate();
  };
  const dropTicket = (id: string) => {
    for (const [key, item] of tickets)
      if (item.id === id) {
        tickets.delete(key);
        item.release();
      }
  };
  const controlIsCurrent = (ticket: Ticket) =>
    ctx.locks.humanHolds(ticket.workspaceId) &&
    ctx.locks.epoch(ticket.workspaceId) === ticket.epoch;
  const revokeControl = (workspaceId?: WorkspaceId) => {
    for (const [key, ticket] of tickets) {
      if (
        (!workspaceId || ticket.workspaceId === workspaceId) &&
        ticket.mode === "control" &&
        !controlIsCurrent(ticket)
      )
        tickets.delete(key);
    }
    for (const [id, item] of active) {
      if (
        (!workspaceId || item.ticket.workspaceId === workspaceId) &&
        item.ticket.mode === "control" &&
        !controlIsCurrent(item.ticket)
      )
        close(id);
    }
  };
  const revokeWorkspace = (workspaceId: WorkspaceId) => {
    for (const [key, ticket] of tickets) {
      if (ticket.workspaceId !== workspaceId) continue;
      tickets.delete(key);
      ticket.release();
    }
    for (const [id, item] of active) {
      if (item.ticket.workspaceId === workspaceId) close(id);
    }
  };
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === "workspace_lock") revokeControl(event.workspaceId);
    if (event.type === "workspace" && event.workspace.archivedAt)
      revokeWorkspace(event.workspaceId);
  });
  const timer = setInterval(() => {
    cleanup();
    revokeControl();
  }, 1000);
  timer.unref();

  const status = async (botId: BotId): Promise<BotScreen> => {
    const bot = ctx.bots.mustGet(botId);
    const handle = await ctx.sandboxes.peek(bot.workspaceId);
    const slot = ctx.screens.get(botId);
    return {
      botId,
      workspaceId: bot.workspaceId,
      ...(slot === undefined ? {} : { slot }),
      state: !handle
        ? "stopped"
        : !handle.botScreenAddresses
          ? "legacy"
          : slot === undefined
            ? "stopped"
            : handle.botScreenAddresses[slot]
              ? "ready"
              : "unavailable",
      humanHeld: ctx.locks.humanHolds(bot.workspaceId),
    };
  };
  app.get<{ Params: { id: string } }>("/api/bots/:id/screen", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return status(request.params.id as BotId);
  });
  app.post<{ Params: { id: string } }>("/api/bots/:id/screen/start", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const handle = await ctx.sandboxes.ensure(ctx.workspaces.mustGet(bot.workspaceId));
    if (!handle.botScreenAddresses)
      throw new DeskmatesError(
        "invalid_transition",
        "This workspace uses the previous desktop image. Restart it with the screen-enabled image when no runs are active or parked.",
      );
    ctx.screens.ensure(bot.id, bot.workspaceId);
    return status(bot.id);
  });
  app.post<{ Params: { id: string } }>(
    "/api/bots/:id/screen/access",
    async (request, reply): Promise<ScreenAccess> => {
      reply.header("cache-control", "no-store");
      const bot = ctx.bots.mustGet(request.params.id as BotId);
      const mode = asRecord(request.body).mode;
      if (mode !== "view" && mode !== "control")
        throw new DeskmatesError("validation", "screen mode must be view or control");
      if (mode === "control" && !ctx.locks.humanHolds(bot.workspaceId))
        throw new DeskmatesError(
          "browser_held_by_human",
          "Take control of the workspace before opening an interactive desktop",
        );
      // Interactive control belongs to the person holding the lease, not to anyone in the tenant
      // while someone holds it (ADR-0022 DESK-01).
      if (mode === "control" && ctx.locks.humanHolder(bot.workspaceId) !== holderOf(request))
        throw new DeskmatesError("forbidden", "another person holds this browser", {
          reason: "not_holder",
        });
      const handle = await ctx.sandboxes.peek(bot.workspaceId);
      const slot = ctx.screens.get(bot.id);
      const address = slot === undefined ? undefined : handle?.botScreenAddresses?.[slot];
      const password = mode === "view" ? handle?.novncViewPassword : handle?.novncPassword;
      if (!address || !password)
        throw new DeskmatesError(
          "sandbox_unavailable",
          "Desktop is not ready. Start it or update the workspace image.",
        );
      return issue(request, bot.workspaceId, address, password, mode);
    },
  );

  // The shared takeover display, for the person holding the lease only (ADR-0022 amendment 1,
  // C7). It replaces the direct noVNC address and password the takeover once returned: the
  // stream comes through this proxy and closes when the lease ends.
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/takeover/open-screen",
    async (request, reply): Promise<ScreenAccess> => {
      reply.header("cache-control", "no-store");
      const workspaceId = request.params.id as WorkspaceId;
      ctx.workspaces.mustGet(workspaceId);
      if (!ctx.locks.humanHolds(workspaceId))
        throw new DeskmatesError(
          "invalid_transition",
          "the workspace browser is not held by a human",
          { workspaceId },
        );
      if (ctx.locks.humanHolder(workspaceId) !== holderOf(request))
        throw new DeskmatesError("forbidden", "another person holds this browser", {
          reason: "not_holder",
        });
      const handle = await ctx.sandboxes.peek(workspaceId);
      if (!handle?.novncAddress || !handle.novncPassword)
        throw new DeskmatesError(
          "sandbox_unavailable",
          "The workspace screen is not ready. Start the workspace first.",
        );
      return issue(request, workspaceId, handle.novncAddress, handle.novncPassword, "control");
    },
  );

  /** A one-use, origin-bound ticket for one proxied stream to `address`. */
  const issue = (
    request: FastifyRequest,
    workspaceId: WorkspaceId,
    address: string,
    password: string,
    mode: "view" | "control",
  ): ScreenAccess => {
    // Never turn this into a general host/port proxy, even if a malformed provider handle appears.
    if (!/^(127\.0\.0\.1|\[::1\]):\d+$/.test(address))
      throw new DeskmatesError("validation", "screen transport must use host loopback");
    cleanup();
    if (tickets.size + active.size >= 256)
      throw new DeskmatesError("queue_full", "Too many desktop connections");
    const tenantId = requestTenant(request);
    ctx.quotas.assertConnectionRoom(
      "desktop",
      [...tickets.values(), ...[...active.values()].map((entry) => entry.ticket)].filter(
        (ticket) => ticket.tenantId === tenantId,
      ).length,
    );
    const id = randomBytes(16).toString("hex");
    const token = `deskmates-screen.${randomBytes(24).toString("hex")}`;
    const origin = request.headers.origin ?? `${request.protocol}://${request.headers.host}`;
    // A person's session or a service principal's token-bound key; revoking either ends it.
    const sessionId = liveKeyOf(request.principal);
    const release =
      sessionId === undefined
        ? () => {}
        : ctx.auth.live.register(
            sessionId,
            () => {
              dropTicket(id);
              close(id);
            },
            tenantId,
          );
    tickets.set(token, {
      id,
      workspaceId,
      address,
      password,
      origin,
      mode,
      expires: Date.now() + 30_000,
      epoch: ctx.locks.epoch(workspaceId),
      ...(sessionId === undefined ? {} : { sessionId }),
      tenantId,
      release,
    });
    return { accessId: id, path: "/api/desktop-stream", protocol: token, mode };
  };
  app.post<{ Params: { id: string } }>("/api/screen-access/:id/close", async (request) => {
    // Another tenant's ticket is answered like a missing one: closed, and nothing happens.
    const tenantId = requestTenant(request);
    const owned =
      [...tickets.values()].some((t) => t.id === request.params.id && t.tenantId === tenantId) ||
      active.get(request.params.id)?.ticket.tenantId === tenantId;
    if (!owned) return { closed: true };
    dropTicket(request.params.id);
    close(request.params.id);
    return { closed: true };
  });

  // Upgrade bypasses Fastify request handlers; the one-use ticket is the authentication here.
  // This listener is installed only with operator routes, never on the production sandbox app.
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = () => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    };
    if (request.url !== "/api/desktop-stream") {
      reject();
      return;
    }
    const token = request.headers["sec-websocket-protocol"];
    const ticket = typeof token === "string" ? tickets.get(token) : undefined;
    if (typeof token === "string") tickets.delete(token);
    if (
      !ticket ||
      ticket.expires < Date.now() ||
      request.headers.origin !== ticket.origin ||
      (ticket.mode === "control" && !controlIsCurrent(ticket)) ||
      // The session that asked for the ticket must still be signed in, and still a member of the
      // tenant the ticket was issued in, when the socket opens.
      (ticket.sessionId !== undefined &&
        !ctx.auth.sessionStillAuthorized(ticket.sessionId, ticket.tenantId))
    ) {
      ticket?.release();
      reject();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${ticket.address}/websockify`, ["binary"], {
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      });
      active.set(ticket.id, { ticket, client, upstream });
      const forward = (to: WebSocket, data: Buffer | ArrayBuffer | Buffer[]) => {
        if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 4 * 1024 * 1024) {
          close(ticket.id);
          return;
        }
        to.send(data, { binary: true });
      };
      // Until both RFB handshakes are done, frames feed the handshake; then they are forwarded.
      const fromUpstream = new ByteReader();
      const fromClient = new ByteReader();
      let piping = false;
      client.on("message", (data) => {
        if (ticket.mode === "control" && !controlIsCurrent(ticket)) {
          close(ticket.id);
          return;
        }
        if (piping) forward(upstream, data);
        else fromClient.push(toBuffer(data));
      });
      upstream.on("message", (data) => {
        if (piping) forward(client, data);
        else fromUpstream.push(toBuffer(data));
      });
      const ended = () => {
        const reason = new Error("screen connection closed");
        fromUpstream.fail(reason);
        fromClient.fail(reason);
        close(ticket.id);
      };
      client.on("error", ended);
      upstream.on("error", ended);
      client.on("close", ended);
      upstream.on("close", ended);
      const send = (to: WebSocket) => (bytes: Buffer) => to.send(bytes, { binary: true });
      const timeout = setTimeout(ended, HANDSHAKE_MS);
      timeout.unref();
      void (async () => {
        await once(upstream, "open");
        await authenticateUpstream((n) => fromUpstream.read(n), send(upstream), ticket.password);
        await greetClient((n) => fromClient.read(n), send(client));
        clearTimeout(timeout);
        // Both handshakes are done: anything already received goes first, then frames flow.
        const towardUpstream = fromClient.drain();
        const towardClient = fromUpstream.drain();
        piping = true;
        if (towardUpstream.length > 0) forward(upstream, towardUpstream);
        if (towardClient.length > 0) forward(client, towardClient);
      })().catch(() => {
        clearTimeout(timeout);
        ended();
      });
    });
  };
  app.server.on("upgrade", upgrade);
  app.addHook("onClose", async () => {
    clearInterval(timer);
    unsubscribe();
    app.server.off("upgrade", upgrade);
    for (const ticket of tickets.values()) ticket.release();
    tickets.clear();
    for (const id of active.keys()) close(id);
    wss.close();
  });
}
