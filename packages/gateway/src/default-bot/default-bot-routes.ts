// Routes of the workspace default bot (ADR-0051). The operator route lets an Owner or Admin pick
// the default bot (policy in `api/route-policies/workspaces.ts`); the internal routes answer the
// sidecar of one run with that run's token, and only a run that froze `assistant-v1` and whose
// bot is still the default bot of its workspace (decision 3). The workspace always comes from the
// run row, never from the request.

import {
  type BotId,
  DeskmatesError,
  type RunId,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { requestActorId } from "../api/actor.js";
import {
  asCronEntries,
  asRecord,
  optionalString,
  requireString,
  requireStringArray,
} from "../api/validate.js";
import type { GatewayContext } from "../context.js";
import {
  assistantCreateBot,
  assistantCreateGroup,
  assistantUpdateBot,
} from "./default-bot-actions.js";
import { defaultBots } from "./default-bot-store.js";

type WorkspaceParams = { Params: { id: string } };
type RunParams = { Params: { runId: string } };
type RunBotParams = { Params: { runId: string; name: string } };

/** The keys a body may carry; any other is refused, so no field widens what the call changes. */
function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(body))
    if (!keys.includes(key))
      throw new DeskmatesError("validation", `${key} is not a field of this call`, { field: key });
}

export function registerDefaultBotRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.put<WorkspaceParams>("/api/workspaces/:id/default-bot", async (request) => {
    const workspaceId = request.params.id as WorkspaceId;
    ctx.workspaces.mustGet(workspaceId);
    const body = asRecord(request.body);
    onlyKeys(body, ["botId", "authorId"]);
    defaultBots(ctx).set(
      workspaceId,
      requireString(body, "botId") as BotId,
      decidedByHuman(requestActorId(request, body)),
    );
    const workspace = ctx.workspaces.mustGet(workspaceId);
    ctx.bus.publish({ type: "workspace", workspaceId, workspace });
    return { workspace };
  });
}

export function registerDefaultBotInternalRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  kick: () => void,
): void {
  app.post<RunParams>("/internal/runs/:runId/assistant/bots", async (request, reply) => {
    const run = ctx.runs.mustGet(request.params.runId as RunId);
    const body = asRecord(request.body);
    onlyKeys(body, ["name", "role", "soul"]);
    const soul = optionalString(body, "soul");
    const result = assistantCreateBot(ctx, run, {
      name: requireString(body, "name"),
      role: optionalString(body, "role") ?? "",
      ...(soul === undefined ? {} : { soul }),
    });
    kick();
    return reply.code(201).send(result);
  });

  app.post<RunBotParams>("/internal/runs/:runId/assistant/bots/:name", async (request) => {
    const run = ctx.runs.mustGet(request.params.runId as RunId);
    const body = asRecord(request.body);
    onlyKeys(body, ["role", "soul", "cron"]);
    const role = optionalString(body, "role");
    const soul = optionalString(body, "soul");
    return assistantUpdateBot(ctx, run, request.params.name, {
      ...(role === undefined ? {} : { role }),
      ...(soul === undefined ? {} : { soul }),
      ...(body.cron === undefined || body.cron === null ? {} : { cron: asCronEntries(body.cron) }),
    });
  });

  app.post<RunParams>("/internal/runs/:runId/assistant/groups", async (request, reply) => {
    const run = ctx.runs.mustGet(request.params.runId as RunId);
    const body = asRecord(request.body);
    onlyKeys(body, ["bots", "title", "message", "startWith"]);
    const title = optionalString(body, "title");
    const message = optionalString(body, "message");
    const result = assistantCreateGroup(ctx, run, {
      bots: requireStringArray(body, "bots"),
      ...(title === undefined ? {} : { title }),
      ...(message === undefined ? {} : { message }),
      ...(body.startWith === undefined ? {} : { startWith: requireStringArray(body, "startWith") }),
    });
    if (result.messageId) kick();
    return reply.code(201).send(result);
  });
}
