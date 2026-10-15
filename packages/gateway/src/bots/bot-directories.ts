// A renamed bot keeps its files (ADR-0043 decision 1). Its home `/home/<name>` holds SOUL.md,
// MEMORY.md, the diary and the SDK's stored sessions; its working directory `/work/bots/<name>`
// holds its work (ADR-0038). Both follow the name, moved inside the workspace container by
// `deskmates-sidecar bot-rename` before the new name is committed.

import { type BotDefinition, DeskmatesError } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { execSidecarJson } from "../workspaces/sidecar-json.js";

/**
 * Starts the workspace container if it is stopped (the directories live in its volumes), then
 * moves both directories. Refused, with nothing moved, when a directory of the new name holds
 * files already. Returns the directories that were moved; a bot that never ran has none.
 */
export async function moveBotDirectories(
  ctx: GatewayContext,
  bot: BotDefinition,
  to: string,
): Promise<string[]> {
  const handle = await ctx.sandboxes.ensure(ctx.workspaces.mustGet(bot.workspaceId));
  const answer = await execSidecarJson(ctx, handle, "bot-rename", { from: bot.name, to }, 60_000);
  const moved = answer.moved;
  if (!Array.isArray(moved) || !moved.every((path) => typeof path === "string"))
    throw new DeskmatesError("sandbox_unavailable", "bot-rename returned an invalid response");
  return moved as string[];
}
