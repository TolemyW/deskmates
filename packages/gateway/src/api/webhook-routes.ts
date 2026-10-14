// The webhook trigger: `POST /hooks/:botId/:token` (design v0.3 §3.4), plus token rotation.
//
// The body is taken raw, whatever the content type: a webhook sender picks its own encoding, and
// the Gateway is not the one that interprets it. It is external data — the sidecar wraps it as
// untrusted before it enters model context (AGENTS.md, "page content is untrusted").
//
// Every delivery creates its own run row before anything else happens; bodies differ, so two
// deliveries are never merged the way two thread wakes are. They queue behind each other on the
// bot's background lane, bounded by `WEBHOOK_QUEUE_MAX`.

import { type BotId, DeskmatesError } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { hashWebhookToken, newWebhookToken, webhookTokenMatches } from "../bots/webhook-token.js";
import type { GatewayContext } from "../context.js";
import { newId, nowIso } from "../db/ids.js";
import type { Scheduler } from "../scheduler/scheduler.js";

/**
 * The same answer for an unknown bot and a wrong token. Telling the two apart would turn the
 * route into an oracle for which bot ids exist.
 */
function hookNotFound(): DeskmatesError {
  return new DeskmatesError("not_found", "webhook not found");
}

export function registerWebhookTokenRoute(app: FastifyInstance, ctx: GatewayContext): void {
  app.post<{ Params: { id: string } }>("/api/bots/:id/webhook-token", async (request) => {
    const id = request.params.id as BotId;
    ctx.bots.mustGet(id);
    const token = newWebhookToken();
    ctx.bots.setWebhookTokenHash(id, hashWebhookToken(token));
    return { bot: ctx.bots.mustGet(id), webhookToken: token };
  });
}

export function registerWebhookDeliveryRoute(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  // Content type parsers are encapsulated, so the raw-body parser below belongs to this plugin
  // only: `/api/...` keeps Fastify's JSON parsing.
  app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      "*",
      { parseAs: "string", bodyLimit: ctx.config.webhookBodyMaxBytes },
      (_req, body, done) => {
        done(null, body);
      },
    );

    hooks.post<{ Params: { botId: string; token: string } }>(
      "/hooks/:botId/:token",
      { bodyLimit: ctx.config.webhookBodyMaxBytes },
      async (request, reply) => {
        const botId = request.params.botId as BotId;
        const bot = ctx.bots.get(botId);
        if (!bot || !webhookTokenMatches(request.params.token, ctx.bots.webhookTokenHash(botId))) {
          throw hookNotFound();
        }
        const tenantId = ctx.ownership.tenantOf("bot", bot.id);
        if (tenantId === undefined) throw hookNotFound();
        ctx.quotas.assertQueueRoom(tenantId);
        const queued = ctx.runs.countQueued(bot.id, "webhook");
        if (queued >= ctx.config.webhookQueueMax) {
          throw new DeskmatesError("queue_full", "the bot's webhook queue is full", {
            botId: bot.id,
            queued,
            max: ctx.config.webhookQueueMax,
          });
        }
        const run = ctx.runs.create({
          botId: bot.id,
          lane: "background",
          triggerKind: "webhook",
          triggerRef: newId("whk"),
          triggerPayload: {
            body: typeof request.body === "string" ? request.body : "",
            contentType: request.headers["content-type"] ?? "",
            receivedAt: nowIso(),
          },
          config: ctx.runConfig(),
        });
        // Every status change reaches the SSE feed, `queued` included, as for a thread wake.
        ctx.bus.publish({ type: "run_status", run });
        scheduler.kick();
        return reply.code(202).send({ runId: run.id });
      },
    );
  });
}

/** Compatibility helper for tests and embedders that intentionally expose both route classes. */
export function registerWebhookRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  registerWebhookTokenRoute(app, ctx);
  registerWebhookDeliveryRoute(app, ctx, scheduler);
}
