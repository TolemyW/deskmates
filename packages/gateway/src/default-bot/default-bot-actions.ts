// What the workspace default bot does (ADR-0051): a new workspace's default bot is created with
// it (decision 2), and a run of the default bot creates a bot, edits another bot's role, SOUL and
// schedules, or opens a group chat at once, without a person confirming (decision 3, owner
// decision 2026-10-19). Every such change writes one audit row naming the bot, the run and the
// person whose message started the run, and one system notice in the run's thread (decision 4).
// Nothing here is access control between bots: model, connectors, approval rules and the Vault
// stay on the operator routes, which a run token never reaches.

import { createHash } from "node:crypto";
import {
  type AssistantBotCreateRequest,
  type AssistantBotResult,
  type AssistantBotUpdateRequest,
  type AssistantGroupCreateRequest,
  type AssistantGroupResult,
  type BotDefinition,
  type BotId,
  DEFAULT_BOT_NAME,
  DeskmatesError,
  type MessageId,
  type Thread,
  type ThreadId,
  type UiLocale,
  WEB_CHANNEL,
  type WorkspaceId,
  decidedByBot,
  decidedByHuman,
  parseMentions,
} from "@deskmates/contracts";
import { SOUL_BODY_MAX_BYTES } from "../api/memory-routes.js";
import {
  botConfiguration,
  createWelcomeRun,
  queueVisionProbe,
  requireRuntimeModel,
} from "../api/registry-routes.js";
import { assertBotName } from "../bots/bots.js";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { DEFAULT_BOT_ROLE, DEFAULT_BOT_SOUL } from "./default-bot-soul.js";
import { defaultBots } from "./default-bot-store.js";
import { ASSISTANT_WELCOME_VERSION, assistantWelcomePrompt } from "./default-bot-welcome.js";

/** A role line the default bot gives a teammate: one line, bounded. */
const ROLE_MAX_CHARS = 200;
/** A group chat title the default bot gives: one line, bounded. */
const TITLE_MAX_CHARS = 120;

/**
 * Decision 2: the bot a new workspace is created with, named `assistant`, inheriting the
 * installation's default model and runtime, with the template SOUL as its version 1 and a welcome
 * run in its private chat. Call it inside the transaction that creates the workspace. The welcome
 * shows the creator around in `locale` (decision 11).
 */
export function createDefaultBot(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  actor: string,
  locale?: UiLocale,
) {
  const bot = ctx.bots.create({
    name: DEFAULT_BOT_NAME,
    role: DEFAULT_BOT_ROLE,
    workspaceId,
    webhookTokenHash: hashWebhookToken(newWebhookToken()),
  });
  writeInitialSoul(ctx, bot.id, DEFAULT_BOT_SOUL, actor);
  ctx.audit.record({
    action: "bot.create",
    actor,
    workspaceId,
    targetKind: "bot",
    targetId: bot.id,
    after: botConfiguration(bot),
    reason: "workspace default bot",
  });
  defaultBots(ctx).set(workspaceId, bot.id, actor);
  const privateChat = ctx.privateChats.resolve(bot.id);
  const welcomeRun = createWelcomeRun(ctx, bot, privateChat, {
    prompt: assistantWelcomePrompt(bot.name, locale),
    version: ASSISTANT_WELCOME_VERSION,
  });
  return { bot, privateChat, welcomeRun };
}

/** The events and probes that follow `createDefaultBot` once its transaction committed. */
export function announceCreatedBot(
  ctx: GatewayContext,
  created: { bot: BotDefinition; privateChat: Thread; welcomeRun?: RunRecord },
  actor: string,
): void {
  ctx.bus.publish({ type: "thread_members", threadId: created.privateChat.id });
  if (created.welcomeRun)
    ctx.bus.publish({
      type: "run_status",
      threadId: created.privateChat.id,
      run: created.welcomeRun,
    });
  queueVisionProbe(ctx, created.bot, "model_added", actor);
}

/** The bot and workspace of a run of the default bot, or `forbidden` (decision 3). */
export function assistantRun(ctx: GatewayContext, run: RunRecord) {
  const bot = ctx.bots.mustGet(run.botId);
  defaultBots(ctx).assertAssistantRun(run, bot.workspaceId);
  if (!run.threadId)
    throw new DeskmatesError("validation", "the default bot changes bots only from a chat", {
      runId: run.id,
    });
  return { assistant: bot, threadId: run.threadId as ThreadId };
}

/**
 * Who asked, for the audit row (decision 4): the human author of the message that started the
 * run, when a human's message did; otherwise the thread the run answered in.
 */
export function requesterOf(ctx: GatewayContext, run: RunRecord): string {
  if (run.triggerKind === "thread_message") {
    const message = ctx.messages.get(run.triggerRef as MessageId);
    if (message?.authorKind === "human") return decidedByHuman(message.authorId);
    if (message?.authorKind === "bot") return decidedByBot(message.authorId as BotId);
  }
  return `thread:${run.threadId ?? "none"}`;
}

/** `bot_create`: same name, role and SOUL rules as the operator create (decision 3). */
export function assistantCreateBot(
  ctx: GatewayContext,
  run: RunRecord,
  input: AssistantBotCreateRequest,
): AssistantBotResult {
  const { assistant, threadId } = assistantRun(ctx, run);
  const name = input.name.trim();
  assertBotName(name);
  const role = oneLine(input.role, ROLE_MAX_CHARS, "role");
  if (input.soul !== undefined) assertSoul(input.soul);
  // The same check as the operator create: the bot inherits the installation's loop and model,
  // which must speak the same protocol (ADR-0044 decision 7).
  requireRuntimeModel(ctx, ctx.config.defaultRuntime, ctx.config.defaultModel);
  const actor = decidedByBot(assistant.id);
  const created = ctx.db.transaction(() => {
    const bot = ctx.bots.create({
      name,
      role,
      workspaceId: assistant.workspaceId,
      webhookTokenHash: hashWebhookToken(newWebhookToken()),
    });
    const soulChanged =
      input.soul !== undefined && input.soul !== ""
        ? writeInitialSoul(ctx, bot.id, input.soul, actor)
        : false;
    ctx.audit.record({
      action: "bot.create",
      actor,
      workspaceId: bot.workspaceId,
      targetKind: "bot",
      targetId: bot.id,
      after: botConfiguration(bot),
      runId: run.id,
      reason: `requested by ${requesterOf(ctx, run)}`,
    });
    const privateChat = ctx.privateChats.resolve(bot.id);
    notice(ctx, threadId, `@${assistant.name} created @${bot.name} (${bot.role || "no role"}).`);
    const welcomeRun = createWelcomeRun(ctx, bot, privateChat);
    return { bot, privateChat, soulChanged, welcomeRun };
  })();
  announceCreatedBot(ctx, created, actor);
  return { bot: summary(created.bot), soulChanged: created.soulChanged };
}

/**
 * `bot_update`: role, SOUL and schedules of another active bot of the workspace (decision 3). The
 * default bot never edits itself, and model, connectors, approval rules and the Vault stay on the
 * operator routes.
 */
export function assistantUpdateBot(
  ctx: GatewayContext,
  run: RunRecord,
  targetName: string,
  input: AssistantBotUpdateRequest,
): AssistantBotResult {
  const { assistant, threadId } = assistantRun(ctx, run);
  const target = botNamed(ctx, assistant.workspaceId, targetName);
  if (target.id === assistant.id)
    throw new DeskmatesError(
      "forbidden",
      "the default bot does not change itself; an Owner or Admin edits it on its profile",
      { botId: target.id },
    );
  const role = input.role === undefined ? undefined : oneLine(input.role, ROLE_MAX_CHARS, "role");
  if (input.soul !== undefined) assertSoul(input.soul);
  if (role === undefined && input.soul === undefined && input.cron === undefined)
    throw new DeskmatesError("validation", "send role, soul or cron to change");
  const actor = decidedByBot(assistant.id);
  const changed = ctx.db.transaction(() => {
    const before = ctx.bots.mustGet(target.id);
    const patch = {
      ...(role === undefined ? {} : { role }),
      ...(input.cron === undefined ? {} : { cron: input.cron }),
    };
    const after = Object.keys(patch).length > 0 ? ctx.bots.update(target.id, patch) : before;
    let soulChanged = false;
    if (input.soul !== undefined) {
      const current = ctx.bots.canonicalSoul(target.id);
      if (!current)
        throw new DeskmatesError(
          "invalid_transition",
          `@${target.name}'s SOUL has not been imported yet; an Owner or Admin opens it once on the profile`,
        );
      if (current.body !== input.soul) {
        ctx.bots.updateCanonicalSoul(target.id, input.soul, current.version, { createdBy: actor });
        soulChanged = true;
      }
    }
    const keys = Object.keys(patch).filter(
      (key) =>
        JSON.stringify(botConfiguration(before)[key]) !==
        JSON.stringify(botConfiguration(after)[key]),
    );
    if (keys.length > 0 || soulChanged)
      ctx.audit.record({
        action: "bot.update",
        actor,
        workspaceId: after.workspaceId,
        targetKind: "bot",
        targetId: after.id,
        // SOUL text never enters the audit record (ADR-0043 decision 2): only that it changed.
        before: pick(botConfiguration(before), keys),
        after: { ...pick(botConfiguration(after), keys), ...(soulChanged ? { soulChanged } : {}) },
        runId: run.id,
        reason: `requested by ${requesterOf(ctx, run)}`,
      });
    const what = [
      ...(keys.includes("role") ? ["role"] : []),
      ...(soulChanged ? ["SOUL"] : []),
      ...(keys.includes("cron") ? ["schedules"] : []),
    ];
    if (what.length > 0)
      notice(ctx, threadId, `@${assistant.name} updated @${after.name}: ${what.join(", ")}.`);
    return { bot: after, soulChanged };
  })();
  return { bot: summary(changed.bot), soulChanged: changed.soulChanged };
}

/** `group_create`: a web group chat of the workspace with these bots and the default bot. */
export function assistantCreateGroup(
  ctx: GatewayContext,
  run: RunRecord,
  input: AssistantGroupCreateRequest,
): AssistantGroupResult {
  const { assistant, threadId } = assistantRun(ctx, run);
  const members = [
    assistant,
    ...input.bots.map((name) => botNamed(ctx, assistant.workspaceId, name)),
  ].filter((bot, index, all) => all.findIndex((other) => other.id === bot.id) === index);
  if (members.length < 2)
    throw new DeskmatesError(
      "validation",
      "a group chat needs at least one teammate besides the default bot",
    );
  const title =
    input.title === undefined ? undefined : oneLine(input.title, TITLE_MAX_CHARS, "title");
  const message = input.message?.trim();
  if (input.message !== undefined && (!message || message.length > 16_000))
    throw new DeskmatesError("validation", "message must contain 1 to 16000 characters");
  const starters = input.startWith?.length
    ? [...new Set(input.startWith.map((name) => botNamed(ctx, assistant.workspaceId, name).id))]
    : input.startWith === undefined
      ? undefined
      : members.filter((bot) => bot.id !== assistant.id).map((bot) => bot.id);
  if (starters?.some((id) => id === assistant.id || !members.some((bot) => bot.id === id)))
    throw new DeskmatesError("validation", "startWith must name teammates in this group");
  const externalKey = `assistant-group:${run.id}:${createHash("sha256")
    .update(
      JSON.stringify([
        members.map((bot) => bot.id).sort(),
        title ?? null,
        message ?? null,
        starters?.slice().sort() ?? null,
      ]),
    )
    .digest("hex")}`;
  return ctx.bus.batch(() =>
    ctx.db
      .transaction((): AssistantGroupResult => {
        const existing = ctx.threads.findByExternalKey(
          assistant.workspaceId,
          WEB_CHANNEL,
          externalKey,
        );
        if (existing) {
          const first = ctx.messages.first(existing.id);
          return {
            thread: { id: existing.id, title: existing.title },
            members: ctx.threads.members(existing.id).map((bot) => bot.name),
            ...(first ? { messageId: first.id } : {}),
          };
        }
        const source = ctx.threads.mustGet(threadId);
        const created = ctx.threads.create({
          workspaceId: assistant.workspaceId,
          botIds: members.map((bot) => bot.id),
          channel: WEB_CHANNEL,
          externalKey,
          ...(source.privateToUserId ? { sideChatActor: `user:${source.privateToUserId}` } : {}),
          ...(title ? { title } : {}),
        });
        ctx.audit.record({
          action: "thread.create",
          actor: decidedByBot(assistant.id),
          workspaceId: assistant.workspaceId,
          targetKind: "thread",
          targetId: created.id,
          after: { botIds: members.map((bot) => bot.id) },
          runId: run.id,
          reason: `requested by ${requesterOf(ctx, run)}`,
        });
        let messageId: MessageId | undefined;
        if (message) {
          // A dependency chain starts only its first worker. Preserve explicit recipients;
          // prefix all teammates only when the assignment names nobody to wake.
          const addressed = parseMentions(
            message,
            members.map((bot) => ({ botId: bot.id, name: bot.name })),
            assistant.id,
            ctx.router.mentionOptions,
          );
          const addresses = members
            .filter((bot) => bot.id !== assistant.id && (!starters || starters.includes(bot.id)))
            .map((bot) => `@${bot.name}`)
            .join(" ");
          const posted = ctx.router.postFromRunToThread(
            run,
            created.id,
            addressed.length ? message : `${addresses}\n${message}`,
            [],
            starters,
          );
          messageId = posted.id;
          ctx.bus.publish({ type: "thread_message", threadId: created.id, message: posted });
        }
        notice(
          ctx,
          threadId,
          `@${assistant.name} opened [${created.title}](#/threads/${created.id}) with ${members
            .filter((bot) => bot.id !== assistant.id)
            .map((bot) => `@${bot.name}`)
            .join(", ")}.`,
        );
        ctx.bus.publish({ type: "thread_members", threadId: created.id });
        return {
          thread: { id: created.id, title: created.title },
          members: members.map((bot) => bot.name),
          ...(messageId ? { messageId } : {}),
        };
      })
      .immediate(),
  );
}

function writeInitialSoul(ctx: GatewayContext, botId: BotId, soul: string, actor: string) {
  const initial = ctx.bots.canonicalSoul(botId);
  if (!initial) return false;
  ctx.bots.updateCanonicalSoul(botId, soul, initial.version, { createdBy: actor });
  return true;
}

/** An active bot of the workspace by name, compared case-insensitively like bot names are. */
function botNamed(ctx: GatewayContext, workspaceId: WorkspaceId, name: string): BotDefinition {
  const wanted = name.trim().replace(/^@/, "").toLowerCase();
  const bot = ctx.bots.list(workspaceId).find((item) => item.name.toLowerCase() === wanted);
  if (!bot)
    throw new DeskmatesError("not_found", `no bot named ${name} in this workspace`, { name });
  return bot;
}

function notice(ctx: GatewayContext, threadId: ThreadId, body: string): void {
  // A record of what changed, not a request: it wakes nobody (ADR-0002 amendment 3 A4).
  const posted = ctx.router.postSystem(threadId, body, [], { inert: true });
  ctx.bus.publish({ type: "thread_message", threadId, message: posted.message });
}

function oneLine(value: string, max: number, field: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length > max)
    throw new DeskmatesError("validation", `${field} must be at most ${max} characters`, {
      field,
    });
  return line;
}

function assertSoul(soul: string): void {
  if (Buffer.byteLength(soul) > SOUL_BODY_MAX_BYTES)
    throw new DeskmatesError("validation", `soul must be at most ${SOUL_BODY_MAX_BYTES} bytes`, {
      field: "soul",
    });
}

function summary(bot: BotDefinition): AssistantBotResult["bot"] {
  return { id: bot.id, name: bot.name, role: bot.role, cron: bot.cron };
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}
