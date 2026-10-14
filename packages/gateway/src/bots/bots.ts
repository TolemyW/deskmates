// Bot registry (design v0.3 §3.1). Names are unique per workspace because `@name` mentions
// resolve against them (ADR-0005 definitions).

import { createHash } from "node:crypto";
import {
  type BotAvatar,
  type BotDefinition,
  type BotId,
  type CronEntry,
  DeskmatesError,
  type EffortLevel,
  type ThinkingConfig,
  type WorkspaceId,
  isBotAvatar,
  isThinkingConfig,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface BotRow {
  id: string;
  name: string;
  role: string;
  workspace_id: string;
  model: string | null;
  cheap_model: string | null;
  effort: string | null;
  thinking_json: string | null;
  avatar_json: string | null;
  soul_version: number;
  soul_body: string | null;
  memory_body: string | null;
  connectors_json: string;
  message_allowlist_json: string;
  cron_json: string;
  webhook_token_hash: string | null;
  created_at: string;
  archived_at: string | null;
  archived_by: string | null;
}

export interface CreateBotInput {
  name: string;
  role: string;
  workspaceId: WorkspaceId;
  model?: string;
  cheapModel?: string;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  avatar?: BotAvatar;
  connectors?: readonly string[];
  messageAllowlist?: readonly string[];
  cron?: readonly CronEntry[];
  /** SHA-256 of the bot's webhook token. The plaintext is never stored, here or anywhere. */
  webhookTokenHash?: string;
}

/**
 * The fields an operator may change after a bot exists. `undefined` means "leave it"; `null` on
 * a model means "clear the override". Name, role and workspace stay create-time: a name is what
 * `@name` mentions resolve against and a workspace is a trust domain, not a setting.
 */
export interface BotPatch {
  model?: string | null;
  cheapModel?: string | null;
  /** Reasoning knob (contracts `reasoning.ts`); `null` clears it back to the SDK default. */
  effort?: EffortLevel | null;
  thinking?: ThinkingConfig | null;
  /** Display preference; `null` goes back to initials on the name-derived colour. */
  avatar?: BotAvatar | null;
  cron?: readonly CronEntry[];
}

const NAME_PATTERN = /^[\w-]+$/;

export class BotStore {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateBotInput): BotDefinition {
    if (!NAME_PATTERN.test(input.name)) {
      throw new DeskmatesError("validation", "bot name must match [A-Za-z0-9_-]+", {
        name: input.name,
      });
    }
    const wsExists = this.db
      .prepare("SELECT 1 FROM workspaces WHERE id = ? AND archived_at IS NULL")
      .get(input.workspaceId);
    if (!wsExists) {
      throw new DeskmatesError("not_found", `workspace ${input.workspaceId} not found`, {
        workspaceId: input.workspaceId,
      });
    }
    const dup = this.db
      .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND lower(name) = lower(?)")
      .get(input.workspaceId, input.name);
    if (dup) {
      throw new DeskmatesError("validation", `bot name ${input.name} already exists in workspace`, {
        name: input.name,
        workspaceId: input.workspaceId,
      });
    }
    const id = newId("bot") as BotId;
    this.db
      .prepare(
        `INSERT INTO bots (id, name, role, workspace_id, model, cheap_model, effort, thinking_json,
           avatar_json, soul_version, soul_body, memory_body, connectors_json,
           message_allowlist_json, cron_json, webhook_token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', '', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.role,
        input.workspaceId,
        input.model ?? null,
        input.cheapModel ?? null,
        input.effort ?? null,
        input.thinking === undefined ? null : JSON.stringify(input.thinking),
        input.avatar === undefined ? null : JSON.stringify(input.avatar),
        JSON.stringify(input.connectors ?? []),
        JSON.stringify(input.messageAllowlist ?? []),
        JSON.stringify(input.cron ?? []),
        input.webhookTokenHash ?? null,
        nowIso(),
      );
    return this.mustGet(id);
  }

  /** NULL means an older bot still needs its physical file imported before A5 delivery. */
  canonicalSoul(id: BotId): { body: string; version: string } | undefined {
    const row = this.db.prepare("SELECT soul_body FROM bots WHERE id = ?").get(id) as
      | { soul_body: string | null }
      | undefined;
    if (!row) this.mustGet(id);
    return row?.soul_body === null || row === undefined
      ? undefined
      : { body: row.soul_body, version: bodyVersion(row.soul_body) };
  }

  /** The historical operator notes, kept distinct from learned experience. */
  legacyMemory(id: BotId): { body: string; version: string } | undefined {
    const row = this.db.prepare("SELECT memory_body FROM bots WHERE id = ?").get(id) as
      | { memory_body: string | null }
      | undefined;
    if (!row) this.mustGet(id);
    return row?.memory_body === null || row === undefined
      ? undefined
      : { body: row.memory_body, version: bodyVersion(row.memory_body) };
  }

  /** Import only once; a competing editor always wins over an older physical read. */
  initializeCanonicalSoul(id: BotId, body: string): { body: string; version: string } {
    this.mustGet(id);
    this.db
      .prepare("UPDATE bots SET soul_body = ? WHERE id = ? AND soul_body IS NULL")
      .run(body, id);
    return this.canonicalSoul(id) as { body: string; version: string };
  }

  initializeLegacyMemory(id: BotId, body: string): { body: string; version: string } {
    this.mustGet(id);
    this.db
      .prepare("UPDATE bots SET memory_body = ? WHERE id = ? AND memory_body IS NULL")
      .run(body, id);
    return this.legacyMemory(id) as { body: string; version: string };
  }

  /** Operator notes remain separate from learned experience and are version-checked. */
  updateLegacyMemory(
    id: BotId,
    body: string,
    expectedVersion: string,
  ): { body: string; version: string } {
    return this.db.transaction(() => {
      const before = this.legacyMemory(id);
      if (!before || before.version !== expectedVersion)
        throw new DeskmatesError("invalid_transition", "MEMORY changed; reload before editing");
      if (before.body !== body) {
        this.db.prepare("UPDATE bots SET memory_body = ? WHERE id = ?").run(body, id);
        this.db.prepare("DELETE FROM bot_sessions WHERE bot_id = ?").run(id);
      }
      return { body, version: bodyVersion(body) };
    })();
  }

  /** Save an operator edit and clear that bot's SDK sessions in the same transaction. */
  updateCanonicalSoul(
    id: BotId,
    body: string,
    expectedVersion: string,
  ): {
    body: string;
    version: string;
  } {
    return this.db.transaction(() => {
      const before = this.canonicalSoul(id);
      if (!before || before.version !== expectedVersion)
        throw new DeskmatesError("invalid_transition", "SOUL changed; reload before editing");
      if (before.body !== body) {
        this.db
          .prepare("UPDATE bots SET soul_body = ?, soul_version = soul_version + 1 WHERE id = ?")
          .run(body, id);
        this.db.prepare("DELETE FROM bot_sessions WHERE bot_id = ?").run(id);
      }
      return { body, version: bodyVersion(body) };
    })();
  }

  /**
   * Applies the editable fields in one statement. A key the patch omits is left alone; `null` on
   * a model clears the override, which is what `undefined` means on `BotDefinition`: the bot
   * inherits `DEFAULT_MODEL` / `CHEAP_MODEL` again. The caller validates every cron schedule.
   */
  update(id: BotId, patch: BotPatch): BotDefinition {
    this.mustGet(id);
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.model !== undefined) {
      sets.push("model = ?");
      values.push(patch.model);
    }
    if (patch.cheapModel !== undefined) {
      sets.push("cheap_model = ?");
      values.push(patch.cheapModel);
    }
    if (patch.effort !== undefined) {
      sets.push("effort = ?");
      values.push(patch.effort);
    }
    if (patch.thinking !== undefined) {
      sets.push("thinking_json = ?");
      values.push(patch.thinking === null ? null : JSON.stringify(patch.thinking));
    }
    if (patch.avatar !== undefined) {
      sets.push("avatar_json = ?");
      values.push(patch.avatar === null ? null : JSON.stringify(patch.avatar));
    }
    if (patch.cron !== undefined) {
      sets.push("cron_json = ?");
      values.push(JSON.stringify(patch.cron));
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.mustGet(id);
  }

  /** Replaces the bot's cron entries; the caller validates every schedule first. */
  setCron(id: BotId, cron: readonly CronEntry[]): BotDefinition {
    return this.update(id, { cron });
  }

  /** Stores a new webhook token hash, which invalidates the previous token. */
  setWebhookTokenHash(id: BotId, hash: string): void {
    this.mustGet(id);
    this.db.prepare("UPDATE bots SET webhook_token_hash = ? WHERE id = ?").run(hash, id);
  }

  /**
   * The stored hash, for the hook route to compare against. Deliberately not part of
   * `BotDefinition`: nothing that answers `GET /api/bots/:id` may carry it.
   */
  webhookTokenHash(id: BotId): string | undefined {
    const row = this.db.prepare("SELECT webhook_token_hash FROM bots WHERE id = ?").get(id) as
      | { webhook_token_hash: string | null }
      | undefined;
    return row?.webhook_token_hash ?? undefined;
  }

  get(id: BotId): BotDefinition | undefined {
    const row = this.db
      .prepare(
        `SELECT b.* FROM bots b JOIN workspaces w ON w.id = b.workspace_id
         WHERE b.id = ? AND b.archived_at IS NULL AND w.archived_at IS NULL`,
      )
      .get(id) as BotRow | undefined;
    return row ? toBot(row) : undefined;
  }

  mustGet(id: BotId): BotDefinition {
    const bot = this.get(id);
    if (!bot) throw new DeskmatesError("not_found", `bot ${id} not found`, { botId: id });
    return bot;
  }

  mustGetIncludingArchived(id: BotId): BotDefinition {
    const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | undefined;
    const bot = row ? toBot(row) : undefined;
    if (!bot) throw new DeskmatesError("not_found", `bot ${id} not found`, { botId: id });
    return bot;
  }

  /**
   * With a tenant, only that tenant's bots (ADR-0022 P2); routes always pass it. Like get(), a bot
   * whose workspace is in Trash is not listed, with or without a tenant: archiving marks only the
   * workspace, and callers such as startup reconciliation and cron call get() on what they list.
   */
  list(workspaceId?: WorkspaceId, tenantId?: string): BotDefinition[] {
    const active =
      "archived_at IS NULL AND workspace_id IN (SELECT id FROM workspaces WHERE archived_at IS NULL)";
    const activeWorkspace = "AND archived_at IS NULL";
    const rows = (
      workspaceId
        ? this.db
            .prepare(
              `SELECT * FROM bots WHERE workspace_id = ? AND ${active} AND (? IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ? ${activeWorkspace})) ORDER BY created_at, id`,
            )
            .all(workspaceId, tenantId ?? null, tenantId ?? null)
        : this.db
            .prepare(
              `SELECT * FROM bots WHERE ${active} AND (? IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ? ${activeWorkspace})) ORDER BY created_at, id`,
            )
            .all(tenantId ?? null, tenantId ?? null)
    ) as BotRow[];
    return rows.map(toBot);
  }

  /**
   * One page of a workspace's active bots by `name, id`, with the honest total (#113 slice B).
   * `q` matches the name or role, case-insensitively. Uses `bots(workspace_id, archived_at,
   * name, id)`.
   */
  page(
    workspaceId: WorkspaceId,
    tenantId: string,
    page: { offset: number; limit: number; q?: string },
  ): { bots: BotDefinition[]; total: number } {
    const where = `workspace_id = ? AND archived_at IS NULL
      AND workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ? AND archived_at IS NULL)
      AND (? IS NULL OR instr(lower(name), lower(?)) > 0 OR instr(lower(role), lower(?)) > 0)`;
    const q = page.q?.trim() ? page.q.trim() : null;
    const params = [workspaceId, tenantId, q, q, q];
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM bots WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM bots WHERE ${where} ORDER BY name, id LIMIT ? OFFSET ?`)
      .all(...params, page.limit, page.offset) as BotRow[];
    return { bots: rows.map(toBot), total };
  }

  listArchived(tenantId: string): BotDefinition[] {
    return (
      this.db
        .prepare(
          "SELECT b.* FROM bots b JOIN workspaces w ON w.id = b.workspace_id WHERE w.tenant_id = ? AND b.archived_at IS NOT NULL ORDER BY b.archived_at DESC, b.id",
        )
        .all(tenantId) as BotRow[]
    ).map(toBot);
  }

  archive(id: BotId, actor: string): BotDefinition {
    const current = this.mustGetIncludingArchived(id);
    if (!current.archivedAt) {
      this.db
        .prepare("UPDATE bots SET archived_at = ?, archived_by = ? WHERE id = ?")
        .run(nowIso(), actor, id);
    }
    return this.mustGetIncludingArchived(id);
  }

  restore(id: BotId): BotDefinition {
    const current = this.mustGetIncludingArchived(id);
    if (!current.archivedAt) return current;
    this.db.prepare("UPDATE bots SET archived_at = NULL, archived_by = NULL WHERE id = ?").run(id);
    return this.mustGet(id);
  }
}

function toBot(row: BotRow): BotDefinition {
  const bot: BotDefinition = {
    id: row.id as BotId,
    name: row.name,
    role: row.role,
    workspaceId: row.workspace_id as WorkspaceId,
    soulVersion: row.soul_version,
    connectors: parseJson<string[]>(row.connectors_json, []),
    messageAllowlist: parseJson<string[]>(row.message_allowlist_json, []),
    cron: parseJson<CronEntry[]>(row.cron_json, []),
    createdAt: row.created_at,
    ...(row.archived_at == null ? {} : { archivedAt: row.archived_at }),
    ...(row.archived_by == null ? {} : { archivedBy: row.archived_by }),
  };
  if (row.model !== null) bot.model = row.model;
  if (row.cheap_model !== null) bot.cheapModel = row.cheap_model;
  if (row.effort !== null) bot.effort = row.effort as EffortLevel;
  if (row.thinking_json !== null) {
    const thinking = parseJson<unknown>(row.thinking_json, undefined);
    // A row written by a newer Gateway with a shape this one does not know is left unset rather
    // than handed to the SDK as something it never validated.
    if (isThinkingConfig(thinking)) bot.thinking = thinking;
  }
  if (row.avatar_json !== null) {
    const avatar = parseJson<unknown>(row.avatar_json, undefined);
    if (isBotAvatar(avatar)) bot.avatar = avatar;
  }
  return bot;
}

function bodyVersion(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
