import {
  type BotId,
  type BotRuleFile,
  type BotRuleWriteNotice,
  DeskmatesError,
  PARKED_RUN_STATUSES,
  decidedByHuman,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { canonicalMemoryForBot } from "../memory/canonical-memory.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

/** Largest canonical SOUL body, in UTF-8 bytes, any route accepts (PATCH soul, create). */
export const SOUL_BODY_MAX_BYTES = 65536;
/** Largest operator MEMORY.md body, in UTF-8 bytes. */
export const MEMORY_BODY_MAX_BYTES = 65536;

type BotParams = { Params: { id: string } };
export type BotContextFile = "MEMORY.md" | "SOUL.md";
export interface BotFileView {
  body: string;
  version: string;
}

export async function executeBotFile(
  ctx: GatewayContext,
  id: string,
  fileName: BotContextFile,
  op: "read" | "write",
  input: Record<string, unknown> = {},
): Promise<BotFileView> {
  const bot = ctx.bots.mustGet(id as BotId);
  if (op === "write" && ctx.runs.listLiveInWorkspace(bot.workspaceId).length)
    throw new DeskmatesError(
      "lane_busy",
      "Wait for workspace runs to finish before editing bot files",
    );
  const handle = await ctx.sandboxes.peek(bot.workspaceId);
  if (!handle)
    throw new DeskmatesError(
      "not_found",
      "Workspace is not running; no bot file was opened or changed",
    );
  const result = await ctx.provider.exec(handle, {
    cmd: ["deskmates-sidecar", "memory"],
    stdin: JSON.stringify({ ...input, botName: bot.name, fileName, op }),
    timeoutMs: 10_000,
  });
  if (result.timedOut)
    throw new DeskmatesError(
      "sandbox_unavailable",
      "Bot file operation timed out; reload before retrying",
    );
  let value: { body?: unknown; version?: unknown; error?: unknown };
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new DeskmatesError(
      "sandbox_unavailable",
      "Bot file operation returned an invalid response",
    );
  }
  if (result.exitCode !== 0)
    throw new DeskmatesError(
      "invalid_transition",
      typeof value.error === "string" ? value.error : "Bot file operation failed",
    );
  if (
    typeof value.body !== "string" ||
    typeof value.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.version)
  )
    throw new DeskmatesError("sandbox_unavailable", "Invalid bot file response");
  return { body: value.body, version: value.version };
}

/** Import pre-A5 files once, after the workspace has been opened but before any canonical write. */
export async function ensureCanonicalSoul(ctx: GatewayContext, id: BotId): Promise<BotFileView> {
  const existing = ctx.bots.canonicalSoul(id);
  if (existing) return existing;
  const physical = await executeBotFile(ctx, id, "SOUL.md", "read");
  return ctx.bots.initializeCanonicalSoul(id, physical.body);
}

export async function ensureLegacyMemory(ctx: GatewayContext, id: BotId): Promise<BotFileView> {
  const existing = ctx.bots.legacyMemory(id);
  if (existing) return existing;
  const physical = await executeBotFile(ctx, id, "MEMORY.md", "read");
  return ctx.bots.initializeLegacyMemory(id, physical.body);
}

/**
 * True when a run of this bot is live or parked. Such a run keeps the SOUL and MEMORY it started
 * its current process with; the sidecar rewrites both files from the canonical copies at the
 * start of every attempt (`canonical-files.ts`), so a saved edit applies from the bot's next run
 * or resumed attempt (ADR-0043 decision 3). A write is never refused for it.
 */
export function ruleWriteNotice(ctx: GatewayContext, botId: BotId): BotRuleWriteNotice {
  const busy =
    ctx.runs.list({ botId }).some((run) => PARKED_RUN_STATUSES.has(run.status)) ||
    ctx.runs
      .listLiveInWorkspace(ctx.bots.mustGet(botId).workspaceId)
      .some((r) => r.botId === botId);
  return { appliesFromNextRun: busy };
}

/**
 * The one SOUL/MEMORY write every route uses: version-checked, a new numbered version, the bot's
 * SDK sessions cleared and an audit row with the versions (never the text), in one transaction.
 */
export async function saveRuleFile(
  ctx: GatewayContext,
  input: {
    botId: BotId;
    file: BotRuleFile;
    body: string;
    expectedVersion: string;
    actor: string;
    restoredFrom?: number;
    proposalId?: string;
  },
): Promise<BotFileView & BotRuleWriteNotice> {
  const bot = ctx.bots.mustGet(input.botId);
  if (input.file === "soul") await ensureCanonicalSoul(ctx, bot.id);
  else await ensureLegacyMemory(ctx, bot.id);
  const key = input.file === "soul" ? "soul" : "memory";
  const write = {
    createdBy: input.actor,
    ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
  };
  const saved = ctx.db.transaction(() => {
    const updated =
      input.file === "soul"
        ? ctx.bots.updateCanonicalSoul(bot.id, input.body, input.expectedVersion, write)
        : ctx.bots.updateLegacyMemory(bot.id, input.body, input.expectedVersion, write);
    ctx.audit.record({
      action: "bot.update",
      actor: input.actor,
      workspaceId: bot.workspaceId,
      targetKind: "bot",
      targetId: bot.id,
      before: { [`${key}Version`]: input.expectedVersion },
      after: {
        [`${key}Version`]: updated.version,
        [`${key}Revision`]: ctx.bots.versions.latestNumber(bot.id, input.file) ?? null,
        ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
        ...(input.proposalId === undefined ? {} : { soulProposalId: input.proposalId }),
      },
    });
    return updated;
  })();
  return { ...saved, ...ruleWriteNotice(ctx, bot.id) };
}

/** Only the authenticated operator can edit persistent memory through the control plane. */
export function registerMemoryRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  _scheduler: Scheduler,
): void {
  app.get<BotParams>("/api/bots/:id/memory", async (request) => ({
    memory: await ensureLegacyMemory(ctx, request.params.id as BotId),
  }));
  // A live or parked run of this bot no longer refuses the edit: it is saved and applies from the
  // next run (ADR-0043 decision 3); `appliesFromNextRun` tells the operator which happened.
  app.patch<BotParams>("/api/bots/:id/memory", async (request) => {
    const { body, expectedVersion } = ruleFileInput(request.body, MEMORY_BODY_MAX_BYTES, "memory");
    const { appliesFromNextRun, ...memory } = await saveRuleFile(ctx, {
      botId: request.params.id as BotId,
      file: "memory",
      body,
      expectedVersion,
      actor: decidedByHuman(requestActorId(request, request.body ?? {})),
    });
    return { memory, appliesFromNextRun };
  });
  // The canonical export includes preserved operator notes and trusted learned experience.
  app.get<BotParams>("/api/bots/:id/memory/export", async (request, reply) => {
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    await ensureLegacyMemory(ctx, bot.id);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", 'attachment; filename="MEMORY.md"')
      .send(canonicalMemoryForBot(ctx, bot.id).body);
  });
  app.get<BotParams>("/api/bots/:id/soul", async (request) => ({
    soul: await ensureCanonicalSoul(ctx, request.params.id as BotId),
  }));
  app.patch<BotParams>("/api/bots/:id/soul", async (request) => {
    const { body, expectedVersion } = ruleFileInput(request.body, SOUL_BODY_MAX_BYTES, "SOUL");
    // SOUL is bot configuration: the audit record keeps its versions, the version table its text.
    const { appliesFromNextRun, ...soul } = await saveRuleFile(ctx, {
      botId: request.params.id as BotId,
      file: "soul",
      body,
      expectedVersion,
      actor: decidedByHuman(requestActorId(request, request.body ?? {})),
    });
    return { soul, appliesFromNextRun };
  });
  app.get<BotParams>("/api/bots/:id/soul/export", async (request, reply) => {
    const soul = await ensureCanonicalSoul(ctx, request.params.id as BotId);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", 'attachment; filename="SOUL.md"')
      .send(soul.body);
  });
}

function ruleFileInput(
  raw: unknown,
  maxBytes: number,
  label: string,
): { body: string; expectedVersion: string } {
  const input = asRecord(raw);
  if (
    typeof input.body !== "string" ||
    Buffer.byteLength(input.body) > maxBytes ||
    typeof input.expectedVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.expectedVersion)
  )
    throw new DeskmatesError("validation", `Expected ${label} body and current version`);
  return { body: input.body, expectedVersion: input.expectedVersion };
}
