import {
  type BotId,
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

/** Only the authenticated operator can edit persistent memory through the control plane. */
export function registerMemoryRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  _scheduler: Scheduler,
): void {
  app.get<BotParams>("/api/bots/:id/memory", async (request) => ({
    memory: await ensureLegacyMemory(ctx, request.params.id as BotId),
  }));
  app.patch<BotParams>("/api/bots/:id/memory", async (request) => {
    const input = asRecord(request.body);
    if (
      typeof input.body !== "string" ||
      Buffer.byteLength(input.body) > 65536 ||
      typeof input.expectedVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedVersion)
    )
      throw new DeskmatesError("validation", "Expected memory body and current version");
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    if (
      ctx.runs
        .list({ botId: bot.id })
        .some(
          (run) =>
            run.status === "waiting_approval" ||
            run.status === "waiting_browser" ||
            run.status === "waiting_continuation",
        )
    )
      throw new DeskmatesError(
        "invalid_transition",
        "Finish or cancel this bot's parked run before editing memory",
      );
    if (ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === bot.id))
      throw new DeskmatesError(
        "lane_busy",
        "Wait for this bot's current run before editing memory",
      );
    await ensureLegacyMemory(ctx, bot.id);
    if (
      ctx.runs
        .list({ botId: bot.id })
        .some(
          (run) =>
            run.status === "waiting_approval" ||
            run.status === "waiting_browser" ||
            run.status === "waiting_continuation",
        )
    )
      throw new DeskmatesError(
        "invalid_transition",
        "Finish or cancel this bot's parked run before editing memory",
      );
    if (ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === bot.id))
      throw new DeskmatesError(
        "lane_busy",
        "Wait for this bot's current run before editing memory",
      );
    return { memory: ctx.bots.updateLegacyMemory(bot.id, input.body, input.expectedVersion) };
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
    const input = asRecord(request.body);
    if (
      typeof input.body !== "string" ||
      Buffer.byteLength(input.body) > SOUL_BODY_MAX_BYTES ||
      typeof input.expectedVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedVersion)
    )
      throw new DeskmatesError("validation", "Expected SOUL body and current version");
    const bot = ctx.bots.mustGet(request.params.id as BotId);
    if (ctx.runs.list({ botId: bot.id }).some((run) => PARKED_RUN_STATUSES.has(run.status)))
      throw new DeskmatesError(
        "invalid_transition",
        "Finish or cancel this bot's parked run before editing SOUL",
      );
    if (ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === bot.id))
      throw new DeskmatesError("lane_busy", "Wait for this bot's current run before editing SOUL");
    await ensureCanonicalSoul(ctx, bot.id);
    if (ctx.runs.list({ botId: bot.id }).some((run) => PARKED_RUN_STATUSES.has(run.status)))
      throw new DeskmatesError(
        "invalid_transition",
        "Finish or cancel this bot's parked run before editing SOUL",
      );
    if (ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === bot.id))
      throw new DeskmatesError("lane_busy", "Wait for this bot's current run before editing SOUL");
    // SOUL is bot configuration: the audit record keeps its version, not its text.
    const actor = decidedByHuman(requestActorId(request, request.body ?? {}));
    const body = input.body;
    const expectedVersion = input.expectedVersion;
    const soul = ctx.db.transaction(() => {
      const updated = ctx.bots.updateCanonicalSoul(bot.id, body, expectedVersion);
      ctx.audit.record({
        action: "bot.update",
        actor,
        workspaceId: bot.workspaceId,
        targetKind: "bot",
        targetId: bot.id,
        before: { soulVersion: expectedVersion },
        after: { soulVersion: updated.version },
      });
      return updated;
    })();
    return { soul };
  });
  app.get<BotParams>("/api/bots/:id/soul/export", async (request, reply) => {
    const soul = await ensureCanonicalSoul(ctx, request.params.id as BotId);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", 'attachment; filename="SOUL.md"')
      .send(soul.body);
  });
}
