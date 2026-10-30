// Bot definition row (design v0.3 §3.1). SOUL.md, MEMORY.md, diary and skills live in the
// workspace filesystem under /home/<bot>/, not here.

import type { AgentRuntime } from "./agent-runtime.js";
import type { BotId, IsoTimestamp, WorkspaceId } from "./ids.js";
import type { EffortLevel, ThinkingConfig } from "./reasoning.js";

/** A bot's mention handle and directory name: ASCII letters, numbers, `_` and `-`. */
export const BOT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Whether a value is a valid bot mention handle. */
export function isBotName(value: string): boolean {
  return BOT_NAME_PATTERN.test(value);
}

/**
 * Turn free text into a valid, readable `@name` suggestion. Runs of unsupported characters
 * become one hyphen; an input with no supported characters falls back to `bot`.
 */
export function suggestBotName(value: string): string {
  const suggestion = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return suggestion || "bot";
}

/** Cron entry as stored in `bots.cron_json`. Scheduling itself is M1. */
export interface CronEntry {
  /** Five-field cron expression, evaluated in the Gateway's timezone. */
  schedule: string;
  /** Text delivered as the trigger payload when the entry fires. */
  prompt: string;
  /**
   * What a minute that passed while the Gateway was stopped does (ADR-0029 decision 11). Absent
   * or `skip`, the default: nothing fires later, and the next start logs the skipped minutes.
   * `run_once`: the next start fires one catch-up round for the latest missed minute, never more.
   */
  misfire?: CronMisfirePolicy;
}

export type CronMisfirePolicy = "skip" | "run_once";

/** The named colours an avatar may use; the UI maps each to a light and a dark value. */
export const AVATAR_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/**
 * How a bot is drawn wherever it appears: one emoji (or the name's initials when absent) on a
 * named colour (or a colour derived from the name when absent). A display preference, nothing
 * else reads it; the sidecar never sees it.
 */
export interface BotAvatar {
  emoji?: string;
  color?: AvatarColor;
}

const AVATAR_EMOJI_MAX_LENGTH = 16;

/** One user-perceived character; a flag or a skin-toned emoji is several code points. */
function isSingleGrapheme(value: string): boolean {
  if (value.length === 0 || value.length > AVATAR_EMOJI_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segments = [...new Intl.Segmenter().segment(value)];
    return segments.length === 1;
  }
  return true;
}

export function isBotAvatar(value: unknown): value is BotAvatar {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== "emoji" && key !== "color") return false;
  if (
    record.emoji !== undefined &&
    !(typeof record.emoji === "string" && isSingleGrapheme(record.emoji))
  )
    return false;
  if (record.color !== undefined && !(AVATAR_COLORS as readonly unknown[]).includes(record.color))
    return false;
  return true;
}

export interface BotDefinition {
  id: BotId;
  /** Unique within the workspace; this is what `@name` mentions resolve against. */
  name: string;
  role: string;
  workspaceId: WorkspaceId;
  /** Display preference for the operator UI; absent means initials on a name-derived colour. */
  avatar?: BotAvatar;
  /** Model ids are deployment configuration; `undefined` means use DEFAULT_MODEL / CHEAP_MODEL. */
  model?: string;
  cheapModel?: string;
  /** The agent loop this bot's runs use (ADR-0044); `undefined` means `DEFAULT_RUNTIME`. */
  runtime?: AgentRuntime;
  /**
   * Reasoning overrides, recorded on every run row (`runs.config_json.reasoning`). `undefined`
   * means the SDK's own default, which is a real configuration and is recorded as `sdk-default`.
   */
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  soulVersion: number;
  /** Connector MCP servers registered for this bot's runs. A prompt-level choice, not access control. */
  connectors: readonly string[];
  /** Bots this one may `message_bot`. Routing configuration, not access control (ADR-0005 item 5). */
  messageAllowlist: readonly string[];
  /**
   * The connected apps (integration service ids) this bot's runs may use; absent means every app
   * the workspace connected (ADR-0055). A soft distinction: a teammate with access can be asked.
   */
  integrationApps?: readonly string[];
  cron: readonly CronEntry[];
  createdAt: IsoTimestamp;
  /**
   * Present while the bot is paused (ADR-0026 amendment 1): cron, webhook and thread wakes are
   * skipped and its queued runs wait; a live run finishes and a parked run stays parked. Unlike
   * Trash, nothing is cancelled or denied, and resuming needs no restore.
   */
  pausedAt?: IsoTimestamp;
  pausedBy?: string;
  /** Present only in Trash views. Archived bots cannot be scheduled or woken. */
  archivedAt?: IsoTimestamp;
  archivedBy?: string;
}

/** Where a bot's files live inside the workspace filesystem. */
export function botHomeDir(botName: string): string {
  return `/home/${botName}`;
}

/**
 * Where a bot's runs start under the `per-bot` working-directory mode, the default (ADR-0038).
 * Every bot may read it; the sidecar's soft guard refuses other bots' obvious writes into it. A
 * guard against mistakes, not a security boundary: all bots run as one Unix user.
 */
export function botWorkDir(botName: string): string {
  return `/work/bots/${botName}`;
}

/** ADR-0055 decision 4: a run refused an app its bot may not use (`details.reason`). */
export const APP_NOT_ENABLED_FOR_BOT = "app_not_enabled_for_bot";

/** ADR-0055 decision 3: what a run froze, `"all"` or a list of service ids. */
export type BotIntegrationAppsScope = "all" | readonly string[];
