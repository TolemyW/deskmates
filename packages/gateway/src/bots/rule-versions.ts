// Saved versions of a bot's SOUL.md and MEMORY.md (ADR-0043 decision 2). Append-only: a row is
// never updated (a trigger refuses it) and a restore appends a new version with an older body.
// The bot row keeps the current body; the newest version here always equals it once the bot has
// been saved at least once.

import { createHash } from "node:crypto";
import {
  type BotId,
  type BotRuleFile,
  type BotRuleVersion,
  type BotRuleVersionSummary,
  DeskmatesError,
  type WorkspaceId,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface VersionRow {
  file: BotRuleFile;
  version: number;
  body: string;
  restored_from: number | null;
  created_by: string;
  created_at: string;
}

/** How many versions one list answer carries, newest first. */
export const RULE_VERSION_LIST_MAX = 200;

export function ruleBodySha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class BotRuleVersionStore {
  constructor(private readonly db: GatewayDb) {}

  /**
   * Append the next version. The caller runs this in the transaction that changes the bot row, so
   * the newest version and the bot's current body never disagree.
   */
  append(input: {
    workspaceId: WorkspaceId;
    botId: BotId;
    file: BotRuleFile;
    body: string;
    createdBy: string;
    restoredFrom?: number;
  }): BotRuleVersion {
    const next = (this.latestNumber(input.botId, input.file) ?? 0) + 1;
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO bot_rule_versions
           (workspace_id, bot_id, file, version, body, restored_from, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        input.botId,
        input.file,
        next,
        input.body,
        input.restoredFrom ?? null,
        input.createdBy,
        createdAt,
      );
    return toVersion({
      file: input.file,
      version: next,
      body: input.body,
      restored_from: input.restoredFrom ?? null,
      created_by: input.createdBy,
      created_at: createdAt,
    });
  }

  /** The newest version number, or undefined before the first save. */
  latestNumber(botId: BotId, file: BotRuleFile): number | undefined {
    const row = this.db
      .prepare(
        `SELECT max(version) AS version FROM bot_rule_versions
          WHERE workspace_id = (SELECT workspace_id FROM bots WHERE id = ?) AND bot_id = ? AND file = ?`,
      )
      .get(botId, botId, file) as { version: number | null } | undefined;
    return row?.version ?? undefined;
  }

  /** Newest first, at most `RULE_VERSION_LIST_MAX`. */
  list(botId: BotId, file: BotRuleFile): BotRuleVersionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT file, version, body, restored_from, created_by, created_at FROM bot_rule_versions
          WHERE workspace_id = (SELECT workspace_id FROM bots WHERE id = ?) AND bot_id = ? AND file = ?
          ORDER BY version DESC LIMIT ?`,
      )
      .all(botId, botId, file, RULE_VERSION_LIST_MAX) as VersionRow[];
    return rows.map((row) => {
      const { body: _body, ...summary } = toVersion(row);
      return summary;
    });
  }

  get(botId: BotId, file: BotRuleFile, version: number): BotRuleVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT file, version, body, restored_from, created_by, created_at FROM bot_rule_versions
          WHERE workspace_id = (SELECT workspace_id FROM bots WHERE id = ?) AND bot_id = ?
            AND file = ? AND version = ?`,
      )
      .get(botId, botId, file, version) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  mustGet(botId: BotId, file: BotRuleFile, version: number): BotRuleVersion {
    const found = this.get(botId, file, version);
    if (!found)
      throw new DeskmatesError("not_found", `${file} version ${version} not found`, {
        botId,
        file,
        version,
      });
    return found;
  }
}

function toVersion(row: VersionRow): BotRuleVersion {
  return {
    file: row.file,
    version: row.version,
    body: row.body,
    bodySha256: ruleBodySha256(row.body),
    bytes: Buffer.byteLength(row.body),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.restored_from === null ? {} : { restoredFrom: row.restored_from }),
  };
}
