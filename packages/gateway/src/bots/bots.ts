// Bot registry (design v0.3 §3.1). Names are unique per workspace because `@name` mentions
// resolve against them (ADR-0005 definitions).

import { createHash } from "node:crypto";
import {
  type BotAvatar,
  type BotDefinition,
  type BotId,
  type BotRuleFile,
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
import { BotRuleVersionStore } from "./rule-versions.js";

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
  paused_at: string | null;
  paused_by: string | null;
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
 * a model means "clear the override". Only the workspace stays create-time: it is a trust domain,
 * not a setting (ADR-0004). A new name keeps `[\w-]+` and per-workspace uniqueness; the caller
 * moves the bot's directories and the store rewrites the name in its peers' allowlists
 * (ADR-0043 decision 1).
 */
export interface BotPatch {
  name?: string;
  role?: string;
  /** Connector MCP servers for this bot's runs; a prompt-level choice, not access control. */
  connectors?: readonly string[];
  /** Bot names this one may `message_bot`; routing configuration, not access control. */
  messageAllowlist?: readonly string[];
  model?: string | null;
  cheapModel?: string | null;
  /** Reasoning knob (contracts `reasoning.ts`); `null` clears it back to the SDK default. */
  effort?: EffortLevel | null;
  thinking?: ThinkingConfig | null;
  /** Display preference; `null` goes back to initials on the name-derived colour. */
  avatar?: BotAvatar | null;
  cron?: readonly CronEntry[];
}

/** Who wrote a SOUL or MEMORY body, and which version it restored when it is a restore. */
export interface RuleWrite {
  /** Actor label recorded on the version (`user:<id>`, `web`, ...). */
  createdBy: string;
  restoredFrom?: number;
}

const NAME_PATTERN = /^[\w-]+$/;

/** A bot name is what `@name` resolves against and a directory name: `[A-Za-z0-9_-]+`. */
export function assertBotName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new DeskmatesError("validation", "bot name must match [A-Za-z0-9_-]+", { name });
  }
}

export class BotStore {
  /** Saved SOUL.md and MEMORY.md versions; every canonical write below appends one. */
  readonly versions: BotRuleVersionStore;

  constructor(private readonly db: GatewayDb) {
    this.versions = new BotRuleVersionStore(db);
  }

  create(input: CreateBotInput): BotDefinition {
    assertBotName(input.name);
    const wsExists = this.db
      .prepare("SELECT 1 FROM workspaces WHERE id = ? AND archived_at IS NULL")
      .get(input.workspaceId);
    if (!wsExists) {
      throw new DeskmatesError("not_found", `workspace ${input.workspaceId} not found`, {
        workspaceId: input.workspaceId,
      });
    }
    this.assertNameFree(input.workspaceId, input.name);
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

  /**
   * Names are unique per workspace, case-insensitively, archived bots included: a bot restored
   * from Trash must not find its name taken.
   */
  assertNameFree(workspaceId: WorkspaceId, name: string, except?: BotId): void {
    const dup = this.db
      .prepare(
        "SELECT 1 FROM bots WHERE workspace_id = ? AND lower(name) = lower(?) AND id IS NOT ?",
      )
      .get(workspaceId, name, except ?? null);
    if (dup) {
      throw new DeskmatesError("validation", `bot name ${name} already exists in workspace`, {
        name,
        workspaceId,
      });
    }
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
    return this.initialize(id, "soul", body) as { body: string; version: string };
  }

  initializeLegacyMemory(id: BotId, body: string): { body: string; version: string } {
    return this.initialize(id, "memory", body) as { body: string; version: string };
  }

  /** A non-empty imported file is version 1 of its history, attributed to `import`. */
  private initialize(id: BotId, file: BotRuleFile, body: string) {
    const bot = this.mustGet(id);
    const column = file === "soul" ? "soul_body" : "memory_body";
    this.db.transaction(() => {
      const changed = this.db
        .prepare(`UPDATE bots SET ${column} = ? WHERE id = ? AND ${column} IS NULL`)
        .run(body, id).changes;
      if (changed === 1 && body !== "")
        this.versions.append({
          workspaceId: bot.workspaceId,
          botId: id,
          file,
          body,
          createdBy: "import",
        });
    })();
    return file === "soul" ? this.canonicalSoul(id) : this.legacyMemory(id);
  }

  /**
   * Operator notes remain separate from learned experience and are version-checked. A changed
   * body appends a version and clears the bot's SDK sessions in the same transaction.
   */
  updateLegacyMemory(
    id: BotId,
    body: string,
    expectedVersion: string,
    write: RuleWrite,
  ): { body: string; version: string } {
    return this.writeRuleFile(id, "memory", body, expectedVersion, write);
  }

  /** Save an operator edit and clear that bot's SDK sessions in the same transaction. */
  updateCanonicalSoul(
    id: BotId,
    body: string,
    expectedVersion: string,
    write: RuleWrite,
  ): { body: string; version: string } {
    return this.writeRuleFile(id, "soul", body, expectedVersion, write);
  }

  private writeRuleFile(
    id: BotId,
    file: BotRuleFile,
    body: string,
    expectedVersion: string,
    write: RuleWrite,
  ): { body: string; version: string } {
    const label = file === "soul" ? "SOUL" : "MEMORY";
    return this.db.transaction(() => {
      const bot = this.mustGet(id);
      const before = file === "soul" ? this.canonicalSoul(id) : this.legacyMemory(id);
      if (!before || before.version !== expectedVersion)
        throw new DeskmatesError("invalid_transition", `${label} changed; reload before editing`);
      if (before.body !== body) {
        this.db
          .prepare(
            file === "soul"
              ? "UPDATE bots SET soul_body = ?, soul_version = soul_version + 1 WHERE id = ?"
              : "UPDATE bots SET memory_body = ? WHERE id = ?",
          )
          .run(body, id);
        this.db.prepare("DELETE FROM bot_sessions WHERE bot_id = ?").run(id);
        // A file saved before versions existed (or imported empty) gets its prior body as the
        // version a restore can go back to.
        if (this.versions.latestNumber(id, file) === undefined && before.body !== "")
          this.versions.append({
            workspaceId: bot.workspaceId,
            botId: id,
            file,
            body: before.body,
            createdBy: "import",
          });
        this.versions.append({
          workspaceId: bot.workspaceId,
          botId: id,
          file,
          body,
          createdBy: write.createdBy,
          ...(write.restoredFrom === undefined ? {} : { restoredFrom: write.restoredFrom }),
        });
      }
      return { body, version: bodyVersion(body) };
    })();
  }

  /**
   * Applies the editable fields in one statement. A key the patch omits is left alone; `null` on
   * a model clears the override, which is what `undefined` means on `BotDefinition`: the bot
   * inherits `DEFAULT_MODEL` / `CHEAP_MODEL` again. The caller validates every cron schedule and
   * moves the bot's directories before a rename; this rewrites the old name in the allowlists of
   * the bot's workspace peers in the same transaction, so `message_bot` keeps routing.
   */
  update(id: BotId, patch: BotPatch): BotDefinition {
    const before = this.mustGet(id);
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const renamed = patch.name !== undefined && patch.name !== before.name;
    if (patch.name !== undefined && renamed) {
      assertBotName(patch.name);
      this.assertNameFree(before.workspaceId, patch.name, id);
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      values.push(patch.role);
    }
    if (patch.connectors !== undefined) {
      sets.push("connectors_json = ?");
      values.push(JSON.stringify(patch.connectors));
    }
    if (patch.messageAllowlist !== undefined) {
      sets.push("message_allowlist_json = ?");
      values.push(JSON.stringify(patch.messageAllowlist));
    }
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
    this.db.transaction(() => {
      if (sets.length > 0) {
        this.db.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      }
      if (renamed && patch.name !== undefined) this.renameInPeerAllowlists(before, patch.name);
    })();
    return this.mustGet(id);
  }

  /** Every peer that could `message_bot` the old name can message the new one. */
  private renameInPeerAllowlists(bot: BotDefinition, name: string): void {
    const old = bot.name.toLowerCase();
    for (const peer of this.list(bot.workspaceId)) {
      if (peer.id === bot.id || !peer.messageAllowlist.some((n) => n.toLowerCase() === old))
        continue;
      const next = [
        ...new Set(peer.messageAllowlist.map((n) => (n.toLowerCase() === old ? name : n))),
      ];
      this.db
        .prepare("UPDATE bots SET message_allowlist_json = ? WHERE id = ?")
        .run(JSON.stringify(next), peer.id);
    }
  }

  /**
   * Pause or resume a bot (ADR-0026 amendment 1). Pausing touches nothing but this flag: live runs
   * finish, parked runs stay parked, queued runs wait. Returns the bot as it is afterwards.
   */
  setPaused(id: BotId, paused: boolean, actor: string): BotDefinition {
    const bot = this.mustGet(id);
    if (paused && bot.pausedAt === undefined) {
      this.db
        .prepare("UPDATE bots SET paused_at = ?, paused_by = ? WHERE id = ?")
        .run(nowIso(), actor, id);
    } else if (!paused && bot.pausedAt !== undefined) {
      this.db.prepare("UPDATE bots SET paused_at = NULL, paused_by = NULL WHERE id = ?").run(id);
    }
    return this.mustGet(id);
  }

  /** Whether the bot is paused; an unknown or archived bot is not. */
  isPaused(id: BotId): boolean {
    const row = this.db.prepare("SELECT paused_at FROM bots WHERE id = ?").get(id) as
      | { paused_at: string | null }
      | undefined;
    return row?.paused_at != null;
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
    ...(row.paused_at == null ? {} : { pausedAt: row.paused_at }),
    ...(row.paused_by == null ? {} : { pausedBy: row.paused_by }),
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
