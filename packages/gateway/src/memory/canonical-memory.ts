// The Gateway-owned MEMORY.md materialization (ADR-0011 A5). Legacy operator notes remain
// separate from learned experience so upgrading a bot cannot erase human-authored content.
import { createHash } from "node:crypto";
import type { BotId } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { renderCanonicalMemory } from "./experience-export.js";

export function canonicalMemoryForBot(
  ctx: GatewayContext,
  botId: BotId,
): { body: string; version: string } {
  const bot = ctx.bots.mustGet(botId);
  const legacy = ctx.bots.legacyMemory(botId);
  if (!legacy) throw new Error(`Legacy MEMORY.md for ${botId} has not been imported`);
  const body = renderCanonicalMemory(
    bot.name,
    legacy.body,
    ctx.memory.entries.list({ workspaceId: bot.workspaceId, botId, scope: "bot" }),
  );
  return { body, version: createHash("sha256").update(body).digest("hex") };
}
