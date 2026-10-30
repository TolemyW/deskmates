// The workspace default bot (ADR-0051): one bot per workspace that a person talks to first, that
// creates other bots and group chats through its own run, and that a new chat channel connection
// is bound to when no bot is named. Shapes and names only; the Gateway decides who may call.

import type { CronEntry } from "./bot.js";
import type { BotId, ThreadId } from "./ids.js";

/** The name a new workspace's default bot is created with (decision 2). */
export const DEFAULT_BOT_NAME = "assistant";

/** The tools a run of the default bot is offered on the `deskmates` MCP server (decision 4). */
export const DEFAULT_BOT_TOOL_NAMES = ["bot_create", "bot_update", "group_create"] as const;
export type DefaultBotToolName = (typeof DEFAULT_BOT_TOOL_NAMES)[number];

/**
 * What a run froze in `runs.config_json.workspaceAssistant` when attempt 1 started (decision 5):
 * `assistant-v1` when its bot was the workspace's default bot, else `off`. Absent is `off`.
 */
export const WORKSPACE_ASSISTANT_MODES = ["off", "assistant-v1"] as const;
export type WorkspaceAssistantMode = (typeof WORKSPACE_ASSISTANT_MODES)[number];

export function isWorkspaceAssistantMode(value: unknown): value is WorkspaceAssistantMode {
  return (
    typeof value === "string" && (WORKSPACE_ASSISTANT_MODES as readonly string[]).includes(value)
  );
}

/** `details.reason` of the `forbidden` refusal a run of any other bot gets (decision 3). */
export const NOT_DEFAULT_BOT = "not_default_bot";

/** `bot_create`: a new bot in the run's workspace, created at once (decision 3). */
export interface AssistantBotCreateRequest {
  name: string;
  role: string;
  soul?: string;
}

/** `bot_update`: the fields the default bot may change on another bot (decision 3). */
export interface AssistantBotUpdateRequest {
  role?: string;
  soul?: string;
  cron?: readonly CronEntry[];
}

/** `group_create`: a group chat in the run's workspace with these bots (decision 3). */
export interface AssistantGroupCreateRequest {
  /** Bot names in the run's workspace. */
  bots: readonly string[];
  title?: string;
  /** Initial assignment. Explicit mentions select starters; otherwise all teammates are addressed. */
  message?: string;
  /** Initial workers by name; empty means all teammates. Omitted keeps legacy mention routing. */
  startWith?: readonly string[];
}

/** What the Gateway answers `bot_create` and `bot_update` with. */
export interface AssistantBotResult {
  bot: { id: BotId; name: string; role: string; cron: readonly CronEntry[] };
  /** Whether the call wrote a new SOUL version. */
  soulChanged: boolean;
}

/** What the Gateway answers `group_create` with. */
export interface AssistantGroupResult {
  thread: { id: ThreadId; title: string };
  members: readonly string[];
  /** An initial assignment was posted; this is not a claim that execution succeeded. */
  messageId?: import("./ids.js").MessageId;
}
