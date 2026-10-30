import {
  type ChannelCommand,
  DeskmatesError,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { withDefaultChannelBot } from "../default-bot/default-bot-channel.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

type WorkspaceParams = { Params: { workspaceId: string } };
type PluginParams = { Params: { workspaceId: string; pluginId: string } };
type CommandParams = {
  Params: { workspaceId: string; pluginId: string; command: string };
};
type ConnectionParams = { Params: { workspaceId: string; connectionId: string } };
type ConnectionCommandParams = {
  Params: { workspaceId: string; connectionId: string; command: string };
};
type BlockParams = { Params: { workspaceId: string; connectionId: string; senderId: string } };

const COMMANDS = new Set<ChannelCommand>(["reconnect", "relink", "test", "disconnect"]);

/** Authenticated, provider-neutral product lifecycle routes. */
export function registerChannelRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/channels", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return ctx.channels.catalog();
  });
  // Not paged (#113 surface 11): a workspace holds one connection per plugin, or for an ABI-2
  // plugin with `multipleConnections` one per external identity its Admins connected (ADR-0047),
  // each shown on its plugin's card; the list stays bounded by what people set up by hand.
  app.get<WorkspaceParams>("/api/workspaces/:workspaceId/channels", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      connections: await ctx.channels.list(request.params.workspaceId as WorkspaceId),
    };
  });
  app.post<PluginParams>(
    "/api/workspaces/:workspaceId/channels/:pluginId/connect",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const connection = await ctx.channels.connect(
        request.params.workspaceId as WorkspaceId,
        request.params.pluginId,
        withDefaultChannelBot(ctx, request.params.workspaceId as WorkspaceId, request.body),
      );
      // The plugin connects asynchronously; the record follows its committed row.
      ctx.audit.record({
        action: "channel.connect",
        actor: decidedByHuman(requestActorId(request, request.body ?? {})),
        workspaceId: request.params.workspaceId,
        targetKind: "channel",
        targetId: connection.apiVersion === 2 ? connection.id : request.params.pluginId,
        ...(connection.identityKey
          ? {
              after: {
                pluginId: connection.pluginId,
                identityKey: connection.identityKey,
                botId: connection.botId,
              },
            }
          : {}),
      });
      return reply.code(201).send({ connection });
    },
  );
  app.post<CommandParams>(
    "/api/workspaces/:workspaceId/channels/:pluginId/commands/:command",
    async (request, reply) => {
      const command = request.params.command as ChannelCommand;
      if (!COMMANDS.has(command)) throw new DeskmatesError("validation", "unknown channel command");
      reply.header("cache-control", "no-store");
      const connection = await ctx.channels.command(
        request.params.workspaceId as WorkspaceId,
        request.params.pluginId,
        command,
        request.body === undefined ? undefined : asRecord(request.body),
      );
      if (command === "disconnect")
        ctx.audit.record({
          action: "channel.disconnect",
          actor: decidedByHuman(requestActorId(request, request.body ?? {})),
          workspaceId: request.params.workspaceId,
          targetKind: "channel",
          targetId: request.params.pluginId,
        });
      return { connection: connection ?? null };
    },
  );
  registerConnectionRoutes(app, ctx);
}

/**
 * Connection-addressed lifecycle (ADR-0047): several connections of one plugin in a workspace,
 * each driven by its id. The handler resolves the id inside the guarded workspace.
 */
function registerConnectionRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const base = "/api/workspaces/:workspaceId/channel-connections/:connectionId";
  app.post<ConnectionCommandParams>(`${base}/commands/:command`, async (request, reply) => {
    const command = request.params.command as ChannelCommand;
    if (!COMMANDS.has(command)) throw new DeskmatesError("validation", "unknown channel command");
    reply.header("cache-control", "no-store");
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const connection = await ctx.channels.connectionCommand(
      workspaceId,
      request.params.connectionId,
      command,
      request.body === undefined ? undefined : asRecord(request.body),
    );
    if (command === "disconnect" || command === "relink")
      ctx.audit.record({
        action: command === "disconnect" ? "channel.disconnect" : "channel.relink",
        actor: decidedByHuman(requestActorId(request, request.body ?? {})),
        workspaceId,
        targetKind: "channel_connection",
        targetId: request.params.connectionId,
      });
    return { connection: connection ?? null };
  });
  app.post<ConnectionParams>(`${base}/command-menu`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const body = asRecord(request.body ?? {});
    const menu = await ctx.channels.commandMenu(workspaceId, request.params.connectionId, body);
    if (body.operation === "sync")
      ctx.audit.record({
        action: "channel.menu_sync",
        actor: decidedByHuman(requestActorId(request, body)),
        workspaceId,
        targetKind: "channel_connection",
        targetId: request.params.connectionId,
        after: {
          scope: body.scope,
          languageCode: body.languageCode,
          chatId: body.chatId,
          replaceMenuButton: body.replaceMenuButton === true,
        },
      });
    return menu;
  });
  app.post<ConnectionParams>(`${base}/rebind`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const body = asRecord(request.body ?? {});
    const result = await ctx.channels.rebind(workspaceId, request.params.connectionId, body.botId);
    ctx.audit.record({
      action: "channel.rebind",
      actor: decidedByHuman(requestActorId(request, body)),
      workspaceId,
      targetKind: "channel_connection",
      targetId: request.params.connectionId,
      before: result.before,
      after: {
        botId: result.connection.botId,
        bindingGeneration: result.connection.bindingGeneration,
        ...result.fence,
      },
    });
    return { connection: result.connection, fence: result.fence };
  });
  app.get<ConnectionParams>(`${base}/blocks`, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      blocks: await ctx.channels.listBlocks(
        request.params.workspaceId as WorkspaceId,
        request.params.connectionId,
      ),
    };
  });
  app.post<ConnectionParams>(`${base}/blocks`, async (request, reply) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const actor = requestActorId(request, request.body ?? {});
    const result = ctx.channels.block(
      workspaceId,
      request.params.connectionId,
      request.body,
      actor,
    );
    if (result.created)
      ctx.audit.record({
        action: "channel.sender_block",
        actor: decidedByHuman(actor),
        workspaceId,
        targetKind: "channel_connection",
        targetId: request.params.connectionId,
        after: { senderId: result.block.senderId },
      });
    return reply.code(result.created ? 201 : 200).send({ block: result.block });
  });
  app.delete<BlockParams>(`${base}/blocks/:senderId`, async (request) => {
    const workspaceId = request.params.workspaceId as WorkspaceId;
    const removed = ctx.channels.unblock(
      workspaceId,
      request.params.connectionId,
      request.params.senderId,
    );
    if (removed)
      ctx.audit.record({
        action: "channel.sender_unblock",
        actor: decidedByHuman(requestActorId(request, {})),
        workspaceId,
        targetKind: "channel_connection",
        targetId: request.params.connectionId,
        before: { senderId: request.params.senderId },
      });
    return { removed };
  });
}

/** External provider ingress. The plugin authenticates the untouched request envelope. */
export function registerChannelWebhookRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      ["application/json", "application/octet-stream", "text/plain"],
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    const deliver = async (
      request: {
        method: string;
        url: string;
        headers: Record<string, string | string[] | undefined>;
        body?: unknown;
        params: { workspaceId: string; pluginId: string; connectionId?: string };
      },
      reply: {
        code(status: number): typeof reply;
        headers(values: Record<string, string>): typeof reply;
        send(body?: string): unknown;
      },
    ) => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      const response = await ctx.channels.webhook(
        request.params.workspaceId as WorkspaceId,
        request.params.pluginId,
        {
          method: request.method as "GET" | "POST",
          url: request.url,
          headers,
          body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        },
        request.params.connectionId,
      );
      reply.code(response.status);
      if (response.headers) reply.headers({ ...response.headers });
      return reply.send(response.body ?? "");
    };
    scope.get<{ Params: { workspaceId: string; pluginId: string } }>(
      "/api/channel-webhooks/:workspaceId/:pluginId",
      deliver,
    );
    scope.post<{ Params: { workspaceId: string; pluginId: string } }>(
      "/api/channel-webhooks/:workspaceId/:pluginId",
      deliver,
    );
    // ADR-0047: one URL per connection when a plugin holds several in a workspace.
    scope.get<{ Params: { workspaceId: string; pluginId: string; connectionId: string } }>(
      "/api/channel-webhooks/:workspaceId/:pluginId/:connectionId",
      deliver,
    );
    scope.post<{ Params: { workspaceId: string; pluginId: string; connectionId: string } }>(
      "/api/channel-webhooks/:workspaceId/:pluginId/:connectionId",
      deliver,
    );
  });
}
