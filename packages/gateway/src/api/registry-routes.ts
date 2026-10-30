// Operator-facing registry routes: bots (packages/gateway/docs/http-api.md). Workspace routes
// are in `workspace-routes.ts`.

import type {
  AgentRuntime,
  BotAvatar,
  BotDefinition,
  BotId,
  Thread,
  WorkspaceId,
} from "@deskmates/contracts";
import {
  AGENT_RUNTIMES,
  DeskmatesError,
  canRetryWelcome,
  decidedByHuman,
  isAgentRuntime,
  isBotAvatar,
  isIntegrationService,
  runtimeProtocol,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { moveBotDirectories } from "../bots/bot-directories.js";
import { type BotPatch, assertBotName } from "../bots/bots.js";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import { modelRegistryOf, upstreamSpeaks } from "../config/model-upstreams.js";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { welcomeDeliveryOf } from "../threads/welcome-delivery.js";
import { requestActorId } from "./actor.js";
import { SOUL_BODY_MAX_BYTES } from "./memory-routes.js";
import { botsByIds } from "./name-lookup.js";
import { parseOffsetQuery } from "./pagination.js";
import { requestTenant } from "./route-policy.js";
import {
  asCronEntries,
  asRecord,
  optionalBoolean,
  optionalEffort,
  optionalString,
  optionalStringArray,
  optionalThinking,
  requireString,
} from "./validate.js";
import { readableWorkspaceIds } from "./workspace-access.js";

/** A workspace's bots in a rail: 50 per page, at most 100 (#113 slice B, plan rows 29, 41). */
const BOT_PAGE = { default: 50, max: 100 } as const;

export function registerRegistryRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.get<{
    Querystring: {
      workspaceId?: string;
      offset?: string;
      limit?: string;
      q?: string;
      ids?: string;
    };
  }>("/api/bots", async (request) => {
    // A name lookup asks for the bots it labels, at most 100 (#113 §3.2).
    if (request.query.ids !== undefined)
      return { bots: botsByIds(ctx, request, request.query.ids, request.query.workspaceId) };
    const readable = readableWorkspaceIds(ctx, request, "guest");
    // #113 slice B: the Contacts and Computer rails read one workspace's bots a page at a time
    // (`name, id`, 50 by default, at most 100) with server search. Without paging parameters the
    // list stays whole: it is the name map every screen labels bots with (plan §3.2).
    const { offset, limit, q } = request.query;
    if (offset !== undefined || limit !== undefined || q !== undefined) {
      const workspaceId = request.query.workspaceId as WorkspaceId | undefined;
      if (!workspaceId)
        throw new DeskmatesError("validation", "a bot page needs workspaceId", {
          field: "workspaceId",
        });
      const query = parseOffsetQuery(request.query, BOT_PAGE);
      const page = ctx.bots.page(workspaceId, requestTenant(request), {
        ...query,
        ...(q ? { q } : {}),
      });
      return { bots: page.bots, offset: query.offset, limit: query.limit, total: page.total };
    }
    return {
      bots: ctx.bots
        .list(request.query.workspaceId as WorkspaceId | undefined, requestTenant(request))
        .filter((bot) => readable === undefined || readable.has(bot.workspaceId)),
    };
  });

  app.post("/api/bots", async (request, reply) => {
    const body = asRecord(request.body);
    // Same rule as PATCH (ADR-0023 decision 1): absent or null inherits the Gateway default; a
    // string must be a priced model id. The empty string is an error, not a silent default.
    const model = optionalString(body, "model");
    const cheapModel = optionalString(body, "cheapModel");
    if (model !== undefined) requirePricedModel(ctx, "model", model);
    if (cheapModel !== undefined) requirePricedModel(ctx, "cheapModel", cheapModel);
    // ADR-0044 decision 7: the loop and the model it will drive must speak the same protocol.
    const runtime = optionalRuntime(body) ?? undefined;
    requireRuntimeModel(
      ctx,
      runtime ?? ctx.config.defaultRuntime,
      model ?? ctx.config.defaultModel,
    );
    // The reasoning knob (contracts `reasoning.ts`); `null` at create means the same as absent.
    const effort = optionalEffort(body) ?? undefined;
    const thinking = optionalThinking(body) ?? undefined;
    const avatar = optionalAvatar(body) ?? undefined;
    const connectors = optionalStringArray(body, "connectors");
    const messageAllowlist = optionalStringArray(body, "messageAllowlist");
    // Every schedule is parsed before the row exists: a bot whose cron the runner cannot read is
    // a bot that silently never fires.
    const cron =
      body.cron === undefined || body.cron === null ? undefined : asCronEntries(body.cron);
    const soul = optionalSoul(body);
    // Issue #77: `welcome: false` creates the bot unstarted, for a SOUL drafted after creation;
    // its welcome run is started by `POST /api/bots/:id/welcome` once that SOUL is applied or
    // the operator starts it without one (#89 ordering: no welcome before the chosen SOUL).
    const startWelcome = optionalWelcome(body);
    const webhookToken = newWebhookToken();
    const created = ctx.db.transaction(() => {
      const bot = ctx.bots.create({
        name: requireString(body, "name"),
        role: optionalString(body, "role") ?? "",
        workspaceId: requireString(body, "workspaceId") as WorkspaceId,
        ...(model !== undefined ? { model } : {}),
        ...(cheapModel !== undefined ? { cheapModel } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        ...(effort ? { effort } : {}),
        ...(thinking ? { thinking } : {}),
        ...(avatar ? { avatar } : {}),
        ...(connectors ? { connectors } : {}),
        ...(messageAllowlist ? { messageAllowlist } : {}),
        ...(cron ? { cron } : {}),
        webhookTokenHash: hashWebhookToken(webhookToken),
      });
      // Issue #89: a SOUL PATCH right after create would only reach the welcome run's next
      // attempt (ADR-0043 decision 3). Writing the initial SOUL here, through the canonical
      // write, commits it with the bot and its welcome run, so the welcome already speaks in it.
      if (soul !== undefined) {
        const initial = ctx.bots.canonicalSoul(bot.id);
        if (initial)
          ctx.bots.updateCanonicalSoul(bot.id, soul, initial.version, {
            createdBy: decidedByHuman(requestActorId(request, body)),
          });
      }
      ctx.audit.record({
        action: "bot.create",
        actor: decidedByHuman(requestActorId(request, body)),
        workspaceId: bot.workspaceId,
        targetKind: "bot",
        targetId: bot.id,
        after: botConfiguration(bot),
      });
      const privateChat = ctx.privateChats.resolve(bot.id);
      const welcomeRun = startWelcome ? createWelcomeRun(ctx, bot, privateChat) : null;
      return { bot, privateChat, welcomeRun };
    })();
    ctx.bus.publish({ type: "thread_members", threadId: created.privateChat.id });
    if (created.welcomeRun)
      ctx.bus.publish({
        type: "run_status",
        threadId: created.privateChat.id,
        run: created.welcomeRun,
      });
    // ADR-0023 amendment 1, decision 6: a bot brings its model into the workspace.
    queueVisionProbe(ctx, created.bot, "model_added", requestActorId(request, body));
    scheduler.kick();
    // The only time the plaintext token is readable; `POST /api/bots/:id/webhook-token` issues a
    // new one and invalidates this.
    return reply.code(201).send({ ...created, webhookToken });
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/welcome", async (request, reply) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    // ADR-0024 amendment 2, decision 11: only a finished welcome whose greeting never reached the
    // chat is retried; a silent run that greeted through `thread_post` is delivered. The check and
    // the insert below run without an await between them, so two submissions cannot both pass.
    const prior = ctx.runs.latestOfTrigger(bot.id, "welcome");
    const delivery = prior ? welcomeDeliveryOf(ctx.db, prior) : undefined;
    if (prior && delivery && !canRetryWelcome(delivery)) {
      throw new DeskmatesError("invalid_transition", `welcome is already ${delivery}`, {
        runId: prior.id,
        status: prior.status,
        delivery,
      });
    }
    const privateChat = ctx.privateChats.resolve(bot.id);
    const welcomeRun = createWelcomeRun(ctx, bot, privateChat);
    ctx.bus.publish({ type: "run_status", threadId: privateChat.id, run: welcomeRun });
    scheduler.kick();
    return reply.code(202).send({ run: welcomeRun, thread: privateChat });
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id", async (request) => ({
    bot: ctx.bots.mustGet(request.params.id as BotId),
  }));

  /**
   * Every field but the workspace is editable after create (ADR-0043 decision 1): name, role,
   * connectors, message allowlist, the two model overrides, the reasoning knob, avatar, cron, and
   * the pause flag (ADR-0026 amendment 1). Each key is independent: absent leaves the field alone
   * and `null` clears an override, so the bot inherits `DEFAULT_MODEL` / `CHEAP_MODEL` (or the
   * SDK's own reasoning default) again. A change reaches the bot from its next run: a live run
   * keeps the configuration its row froze.
   *
   * A rename moves `/home/<name>` and `/work/bots/<name>` in the workspace container first and is
   * refused while the bot has a live or parked run; the peers' allowlists, the private chat title
   * and generated group titles follow it in the same transaction.
   */
  app.patch<{ Params: { id: string } }>("/api/bots/:id", async (request) => {
    const body = asRecord(request.body);
    const id = request.params.id as BotId;
    const current = ctx.bots.mustGet(id);
    const patch: BotPatch = {};
    if (body.name !== undefined) {
      const name = requireString(body, "name").trim();
      assertBotName(name);
      if (name !== current.name) {
        ctx.bots.assertNameFree(current.workspaceId, name, id);
        patch.name = name;
      }
    }
    if (body.role !== undefined) patch.role = (optionalString(body, "role") ?? "").trim();
    for (const key of ["connectors", "messageAllowlist"] as const) {
      if (body[key] === undefined) continue;
      patch[key] = [
        ...new Set((optionalStringArray(body, key) ?? []).map((s) => s.trim()).filter(Boolean)),
      ];
    }
    if (body.cron !== undefined && body.cron !== null) patch.cron = asCronEntries(body.cron);
    // ADR-0055 decision 2: `null` is every connected app; a list holds integration service ids.
    if (body.integrationApps !== undefined) {
      if (body.integrationApps === null) patch.integrationApps = null;
      else {
        const apps = optionalStringArray(body, "integrationApps") ?? [];
        for (const service of apps)
          if (!isIntegrationService(service))
            throw new DeskmatesError("validation", "integrationApps must list service ids", {
              field: "integrationApps",
            });
        patch.integrationApps = apps;
      }
    }
    for (const key of ["model", "cheapModel"] as const) {
      if (body[key] === undefined) continue;
      // `null` is the clear; anything else must be a priced model id (ADR-0023 decision 1), and
      // the empty string is not one.
      if (body[key] === null) {
        patch[key] = null;
        continue;
      }
      const value = requireString(body, key);
      requirePricedModel(ctx, key, value);
      patch[key] = value;
    }
    const runtime = optionalRuntime(body);
    if (runtime !== undefined) patch.runtime = runtime;
    const effort = optionalEffort(body);
    if (effort !== undefined) patch.effort = effort;
    const thinking = optionalThinking(body);
    if (thinking !== undefined) patch.thinking = thinking;
    const avatar = optionalAvatar(body);
    if (avatar !== undefined) patch.avatar = avatar;
    const paused = optionalBoolean(body, "paused");
    if (Object.keys(patch).length === 0 && paused === undefined && body.name === undefined) {
      throw new DeskmatesError(
        "validation",
        "nothing to update: send name, role, connectors, messageAllowlist, integrationApps, cron, model, cheapModel, runtime, effort, thinking, avatar or paused",
      );
    }
    // ADR-0044 decision 7: judged on what the bot will run with after the patch.
    if (
      patch.runtime !== undefined ||
      patch.model !== undefined ||
      patch.cheapModel !== undefined
    ) {
      const current = ctx.bots.mustGet(id);
      const effectiveRuntime =
        (patch.runtime === undefined ? current.runtime : (patch.runtime ?? undefined)) ??
        ctx.config.defaultRuntime;
      const effectiveModel =
        (patch.model === undefined ? current.model : (patch.model ?? undefined)) ??
        ctx.config.defaultModel;
      const effectiveCheap =
        (patch.cheapModel === undefined ? current.cheapModel : (patch.cheapModel ?? undefined)) ??
        ctx.config.cheapModel;
      requireRuntimeModel(ctx, effectiveRuntime, effectiveModel);
      requireRuntimeModel(ctx, effectiveRuntime, effectiveCheap);
    }
    const actor = decidedByHuman(requestActorId(request, body));
    const commit = () =>
      ctx.db.transaction(() => {
        const before = ctx.bots.mustGet(id);
        let after = ctx.bots.update(id, patch);
        const retitled =
          patch.name === undefined
            ? []
            : ctx.threads.renameBotInTitles(id, before.name, patch.name);
        if (paused !== undefined) after = ctx.bots.setPaused(id, paused, actor);
        const keys = [...Object.keys(patch), ...(paused === undefined ? [] : ["paused"])];
        if (keys.length > 0 && JSON.stringify(before) !== JSON.stringify(after))
          ctx.audit.record({
            action: "bot.update",
            actor,
            workspaceId: after.workspaceId,
            targetKind: "bot",
            targetId: id,
            before: pick(botConfiguration(before), keys),
            after: pick(botConfiguration(after), keys),
          });
        return { bot: after, retitled };
      })();
    const saved =
      patch.name === undefined
        ? commit()
        : await scheduler.withIdleBot(id, async () => {
            await moveBotDirectories(ctx, current, patch.name as string);
            return commit();
          });
    for (const threadId of saved.retitled) ctx.bus.publish({ type: "thread_members", threadId });
    if (patch.model !== undefined) queueVisionProbe(ctx, saved.bot, "model_changed", actor);
    // Resuming lets the runs that waited out the pause start; a new model queues a probe.
    if (patch.model !== undefined || paused === false) scheduler.kick();
    return { bot: saved.bot };
  });
}

/** Decision 6: probe a bot's effective model unless its key has a result or a pending probe. */
export function queueVisionProbe(
  ctx: GatewayContext,
  bot: BotDefinition,
  trigger: "model_added" | "model_changed",
  actor: string,
): void {
  const queued = ctx.modelJobs.vision.queue({
    workspaceId: bot.workspaceId,
    model: ctx.modelJobs.vision.effectiveModel(bot),
    trigger,
    requestedBy: decidedByHuman(actor),
    host: bot,
  });
  if (queued.run) ctx.bus.publish({ type: "run_status", run: queued.run });
}

function optionalWelcome(body: Record<string, unknown>): boolean {
  if (body.welcome === undefined || body.welcome === null) return true;
  if (typeof body.welcome !== "boolean")
    throw new DeskmatesError("validation", "welcome must be a boolean");
  return body.welcome;
}

/** The configuration a bot's audit rows record: never its webhook token or SOUL text. */
/** `runtime` in a body: absent → undefined, `null` → null (clear), else a known runtime. */
function optionalRuntime(body: Record<string, unknown>): AgentRuntime | null | undefined {
  const value = body.runtime;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isAgentRuntime(value)) return value;
  throw new DeskmatesError("validation", `runtime must be one of ${AGENT_RUNTIMES.join(", ")}`, {
    field: "runtime",
  });
}

/**
 * ADR-0044 decision 7: a bot's loop and the upstream serving its effective model must speak the
 * same protocol, since the proxy never translates. A model with no upstream is refused too.
 */
export function requireRuntimeModel(
  ctx: GatewayContext,
  runtime: AgentRuntime,
  model: string,
): void {
  const upstream = modelRegistryOf(ctx.config).resolve(model);
  const expected = runtimeProtocol(runtime);
  if (upstream === undefined || !upstreamSpeaks(upstream, expected)) {
    throw new DeskmatesError(
      "validation",
      `runtime ${runtime} needs model ${model} on a ${expected}-protocol upstream`,
      { field: "runtime", runtime, model, upstreamProtocol: upstream?.protocol ?? null },
    );
  }
}

export function botConfiguration(bot: BotDefinition): Record<string, unknown> {
  return {
    name: bot.name,
    role: bot.role,
    model: bot.model ?? null,
    cheapModel: bot.cheapModel ?? null,
    runtime: bot.runtime ?? null,
    effort: bot.effort ?? null,
    thinking: bot.thinking ?? null,
    avatar: bot.avatar ?? null,
    connectors: bot.connectors,
    messageAllowlist: bot.messageAllowlist,
    integrationApps: bot.integrationApps ?? null,
    cron: bot.cron,
    paused: bot.pausedAt !== undefined,
  };
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}

/** A welcome other than the generic one: the default bot's onboarding (ADR-0051 decision 11). */
export interface WelcomeOverride {
  prompt: string;
  version: string;
}

export function createWelcomeRun(
  ctx: GatewayContext,
  bot: BotDefinition,
  thread: Thread,
  welcome?: WelcomeOverride,
) {
  const role = bot.role.trim() || "a helpful teammate";
  return ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "welcome",
    triggerRef: newId("welcome"),
    triggerPayload: {
      prompt:
        welcome?.prompt ??
        `You have just joined this workspace as ${bot.name}, whose role is ${role}. Following your own instructions and voice, write a brief first welcome message to the people in this private chat. Introduce how you can help and invite them to start. Reply only with the welcome message.`,
    },
    config: { ...ctx.runConfig(), welcomeVersion: welcome?.version ?? 1 },
  });
}

/**
 * A bot's model override must have a row in the price table (ADR-0023 decision 1), so every model
 * a run can be frozen on is one the Gateway can price; an unpriced override is refused at write
 * time rather than discovered as `pricing_missing` after the money is spent. It must also have an
 * upstream (ADR-0039 decision 4), so it is not discovered as `model_upstream_missing` at run time.
 */
function requirePricedModel(ctx: GatewayContext, key: string, model: string): void {
  if (model === "") {
    throw new DeskmatesError("validation", `${key} must be a model id, not empty`, { key });
  }
  if (modelRegistryOf(ctx.config).resolve(model) === undefined) {
    throw new DeskmatesError(
      "validation",
      `${key} "${model}" is served by no model upstream; list it in MODEL_UPSTREAMS first`,
      { key, model },
    );
  }
  if (ctx.prices.listForModel(model).length === 0) {
    throw new DeskmatesError(
      "validation",
      `${key} "${model}" has no price row; add it to the price table before setting it on a bot`,
      { key, model },
    );
  }
}

/**
 * The initial SOUL at create (issue #89): `undefined` when absent or `null`, otherwise a string
 * within the same size limit as `PATCH /api/bots/:id/soul`.
 */
function optionalSoul(body: Record<string, unknown>): string | undefined {
  const value = body.soul;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value) > SOUL_BODY_MAX_BYTES) {
    throw new DeskmatesError(
      "validation",
      `soul must be a string of at most ${SOUL_BODY_MAX_BYTES} bytes`,
    );
  }
  return value;
}

/** `undefined` when absent, `null` to clear, otherwise a validated `BotAvatar`. */
function optionalAvatar(body: Record<string, unknown>): BotAvatar | null | undefined {
  const value = body.avatar;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isBotAvatar(value)) {
    throw new DeskmatesError(
      "validation",
      "avatar must be {emoji?: one character, color?: one of the named colours}",
      { avatar: value },
    );
  }
  return value;
}
