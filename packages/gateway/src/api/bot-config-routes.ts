// A bot after creation (ADR-0043): the saved versions of SOUL.md and MEMORY.md with diff and
// restore, the bot's diary with audited line deletes, and "Run now" on a cron entry. The fields
// on the bot row are edited through `PATCH /api/bots/:id` (`registry-routes.ts`).

import {
  type BotId,
  type BotRuleFile,
  type BotRuleVersionList,
  DeskmatesError,
  decidedByHuman,
  diffSoulLines,
  isBotRuleFile,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { deleteDiaryLine, listDiaryDays, readDiaryDay } from "../bots/bot-diary.js";
import { ruleBodySha256 } from "../bots/rule-versions.js";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { ensureCanonicalSoul, ensureLegacyMemory, saveRuleFile } from "./memory-routes.js";
import { asRecord } from "./validate.js";

type FileParams = { Params: { id: string; file: string } };
type VersionParams = { Params: { id: string; file: string; version: string } };
type DayParams = { Params: { id: string; day: string } };

/** How many of the bot's newest runs are searched for the version the last one used. */
const LAST_RUN_SCAN = 20;

export function registerBotConfigRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
): void {
  app.get<FileParams>("/api/bots/:id/rule-versions/:file", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const file = ruleFile(request.params.file);
    // A bot from before versions existed gets its imported body as version 1 on first read.
    if (file === "soul") await ensureCanonicalSoul(ctx, bot.id);
    else await ensureLegacyMemory(ctx, bot.id);
    const versions = ctx.bots.versions.list(bot.id, file);
    const lastRun = lastRunVersion(ctx, bot.id, file, versions);
    const answer: BotRuleVersionList = { file, versions, ...(lastRun ? { lastRun } : {}) };
    return answer;
  });

  // Registered before `:version` so the literal segment wins.
  app.get<FileParams & { Querystring: { from?: string; to?: string } }>(
    "/api/bots/:id/rule-versions/:file/diff",
    async (request) => {
      const bot = ctx.bots.mustGet(request.params.id as BotId);
      const file = ruleFile(request.params.file);
      const from = ctx.bots.versions.mustGet(bot.id, file, versionNumber(request.query.from));
      const to = ctx.bots.versions.mustGet(bot.id, file, versionNumber(request.query.to));
      return { from: from.version, to: to.version, lines: diffSoulLines(from.body, to.body) };
    },
  );

  app.get<VersionParams>("/api/bots/:id/rule-versions/:file/:version", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const file = ruleFile(request.params.file);
    return {
      version: ctx.bots.versions.mustGet(bot.id, file, versionNumber(request.params.version)),
    };
  });

  /**
   * Restore writes the chosen version's body as a new version; history is never rewritten. Like
   * any save it applies from the bot's next run. `expectedVersion`, when sent, must be the
   * current body's hash, as for a hand edit.
   */
  app.post<VersionParams>("/api/bots/:id/rule-versions/:file/:version/restore", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const file = ruleFile(request.params.file);
    const target = ctx.bots.versions.mustGet(bot.id, file, versionNumber(request.params.version));
    const body = asRecord(request.body ?? {});
    const current =
      file === "soul"
        ? await ensureCanonicalSoul(ctx, bot.id)
        : await ensureLegacyMemory(ctx, bot.id);
    const expected = body.expectedVersion === undefined ? current.version : body.expectedVersion;
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
      throw new DeskmatesError("validation", "expectedVersion must be a sha256 hex string");
    const { appliesFromNextRun, ...saved } = await saveRuleFile(ctx, {
      botId: bot.id,
      file,
      body: target.body,
      expectedVersion: expected,
      actor: decidedByHuman(requestActorId(request, body)),
      restoredFrom: target.version,
    });
    return {
      [file]: saved,
      version: ctx.bots.versions.latestNumber(bot.id, file) ?? null,
      appliesFromNextRun,
    };
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/diary", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    return { days: await listDiaryDays(ctx, bot) };
  });

  app.get<DayParams>("/api/bots/:id/diary/:day", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    return { day: await readDiaryDay(ctx, bot, request.params.day) };
  });

  /**
   * One line out of one day. Refused while the bot has a live run, whose end appends to today's
   * file; the audit row keeps the line's hash and length, never its text.
   */
  app.post<DayParams>("/api/bots/:id/diary/:day/delete-line", async (request) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    const body = asRecord(request.body);
    const { line, text, version } = body;
    if (
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      line < 0 ||
      typeof text !== "string" ||
      typeof version !== "string" ||
      !/^[a-f0-9]{64}$/.test(version)
    )
      throw new DeskmatesError("validation", "send line (index), text and version of the day");
    if (ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === bot.id))
      throw new DeskmatesError(
        "lane_busy",
        "Wait for this bot's current run to finish; it writes to its diary when it ends",
      );
    const day = await deleteDiaryLine(ctx, bot, {
      day: request.params.day,
      line,
      text,
      version,
    });
    ctx.audit.record({
      action: "bot.diary_edit",
      actor: decidedByHuman(requestActorId(request, body)),
      workspaceId: bot.workspaceId,
      targetKind: "bot",
      targetId: bot.id,
      before: { day: day.day, line, lineSha256: ruleBodySha256(text), chars: text.length },
      after: { day: day.day, version: day.version, lines: day.lines.length },
    });
    return { day };
  });

  /**
   * "Run now" on one cron entry: a normal background run with trigger `manual`, queued behind the
   * bot's lane like a cron round. A paused bot is resumed first; nothing starts behind a pause.
   */
  app.post<{ Params: { id: string; entry: string } }>(
    "/api/bots/:id/cron/:entry/run",
    async (request, reply) => {
      const bot = ctx.bots.mustGet(request.params.id as BotId);
      const index = Number(request.params.entry);
      const entry = Number.isSafeInteger(index) ? bot.cron[index] : undefined;
      if (!entry)
        throw new DeskmatesError("not_found", "no such cron entry", {
          entry: request.params.entry,
        });
      if (bot.pausedAt !== undefined)
        throw new DeskmatesError("invalid_transition", "the bot is paused; resume it first", {
          reason: "bot_paused",
        });
      const run = ctx.runs.create({
        botId: bot.id,
        lane: "background",
        triggerKind: "manual",
        triggerRef: `manual:${index}:${newId("now")}`,
        triggerPayload: {
          prompt: entry.prompt,
          schedule: entry.schedule,
          entry: index,
          requestedBy: decidedByHuman(requestActorId(request, request.body ?? {})),
        },
        config: ctx.runConfig(),
      });
      ctx.bus.publish({ type: "run_status", run });
      scheduler.kick();
      return reply.code(202).send({ run });
    },
  );
}

function ruleFile(value: string): BotRuleFile {
  if (!isBotRuleFile(value))
    throw new DeskmatesError("validation", "file must be soul or memory", { file: value });
  return value;
}

function versionNumber(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new DeskmatesError("validation", "version must be a positive integer", {
      version: value,
    });
  return n;
}

/**
 * The version the bot's newest started run was given: its recorded revision, or, for a run from
 * before revisions were recorded, the newest version whose body has the hash it recorded.
 */
function lastRunVersion(
  ctx: GatewayContext,
  botId: BotId,
  file: BotRuleFile,
  versions: readonly { version: number; bodySha256: string }[],
): BotRuleVersionList["lastRun"] {
  const revisionKey = file === "soul" ? "canonicalSoulRevision" : "operatorMemoryRevision";
  for (const run of ctx.runs.latestStartedOwnRuns(botId, LAST_RUN_SCAN)) {
    const revision = run.config[revisionKey];
    if (typeof revision === "number") return { runId: run.id, version: revision };
    const hash = file === "soul" ? run.config.canonicalSoulVersion : undefined;
    if (typeof hash === "string") {
      const match = versions.find((v) => v.bodySha256 === hash);
      return match ? { runId: run.id, version: match.version } : undefined;
    }
  }
  return undefined;
}
