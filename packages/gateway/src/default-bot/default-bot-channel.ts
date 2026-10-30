// ADR-0051 decision 8: a new chat channel connection that names no bot is bound to the workspace's
// default bot. Naming a bot works as before; with neither, the connect is refused as before.

import { DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import { defaultBots } from "./default-bot-store.js";

/** The connect body with `botId` filled in from the default bot when it names none. */
export function withDefaultChannelBot(
  ctx: Parameters<typeof defaultBots>[0],
  workspaceId: WorkspaceId,
  input: unknown,
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const body = input as Record<string, unknown>;
  if (typeof body.botId === "string" && body.botId !== "") return body;
  const botId = defaultBots(ctx).get(workspaceId);
  if (botId === undefined)
    throw new DeskmatesError(
      "validation",
      "name a bot for this connection: the workspace has no default bot",
      { field: "botId" },
    );
  return { ...body, botId };
}
