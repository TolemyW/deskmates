import {
  type ChannelCommand,
  DeskmatesError,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

type WorkspaceParams = { Params: { workspaceId: string } };
type PluginParams = { Params: { workspaceId: string; pluginId: string } };
type CommandParams = {
  Params: { workspaceId: string; pluginId: string; command: string };
};

const COMMANDS = new Set<ChannelCommand>(["reconnect", "relink", "test", "disconnect"]);

/** Authenticated, provider-neutral product lifecycle routes. */
export function registerChannelRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get("/api/channels", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return ctx.channels.catalog();
  });
  // Not paged (#113 surface 11): a workspace holds at most one connection per plugin
  // (`UNIQUE (workspace_id, plugin_id)`) and plugins are release-bundled, so the list is bounded
  // by the build like the catalog above, and each connection is shown on its plugin's card.
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
        request.body,
      );
      // The plugin connects asynchronously; the record follows its committed row.
      ctx.audit.record({
        action: "channel.connect",
        actor: decidedByHuman(requestActorId(request, request.body ?? {})),
        workspaceId: request.params.workspaceId,
        targetKind: "channel",
        targetId: request.params.pluginId,
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
        params: { workspaceId: string; pluginId: string };
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
  });
}
