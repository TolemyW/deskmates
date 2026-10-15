// A bot's operator-owned rule files after creation (ADR-0043): the saved versions of SOUL.md and
// MEMORY.md, and the bot's own diary under /home/<bot>/memory/. Versions are append-only: a
// restore writes a new version with an older body, it never rewrites history.

/** Which operator-owned file a version belongs to. */
export type BotRuleFile = "soul" | "memory";

export const BOT_RULE_FILES: readonly BotRuleFile[] = ["soul", "memory"];

export function isBotRuleFile(value: unknown): value is BotRuleFile {
  return value === "soul" || value === "memory";
}

/** One saved version, without its body (the list view). */
export interface BotRuleVersionSummary {
  file: BotRuleFile;
  /** 1, 2, 3, ... per bot and file, in the order they were saved. */
  version: number;
  /** Hex sha256 of the body: the same value as `runs.config_json.canonicalSoulVersion`. */
  bodySha256: string;
  /** UTF-8 bytes of the body. */
  bytes: number;
  /** Actor label of whoever saved it (`user:<id>`, `web`, `import`, `migration`, ...). */
  createdBy: string;
  createdAt: string;
  /** The version whose body this one restored, when it came from a restore. */
  restoredFrom?: number;
}

export interface BotRuleVersion extends BotRuleVersionSummary {
  body: string;
}

/** What `GET /api/bots/:id/rule-versions/:file` answers. */
export interface BotRuleVersionList {
  file: BotRuleFile;
  versions: BotRuleVersionSummary[];
  /**
   * The version the bot's most recent run started with (`runs.config_json.canonicalSoulRevision`
   * or `operatorMemoryRevision`), when a run recorded one.
   */
  lastRun?: { runId: string; version: number };
}

/** A SOUL or MEMORY write that a live or parked run will only see from its next attempt. */
export interface BotRuleWriteNotice {
  /** True when a run of this bot was live or parked at the time of the write. */
  appliesFromNextRun: boolean;
}

/** `YYYY-MM-DD`, the diary file name without `.md`. */
export const DIARY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Largest diary day file the operator view reads or edits, in bytes. */
export const DIARY_DAY_MAX_BYTES = 262_144;

/** One diary day as the operator reads it: the file's lines and the version of its bytes. */
export interface BotDiaryDay {
  day: string;
  lines: string[];
  /** Hex sha256 of the file; a line delete names it so a concurrent append is never lost. */
  version: string;
}

export interface BotDiaryDaySummary {
  day: string;
  bytes: number;
}
