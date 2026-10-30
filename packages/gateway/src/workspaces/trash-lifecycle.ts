import {
  type BotDefinition,
  type BotId,
  DeskmatesError,
  type Workspace,
  type WorkspaceId,
  isTerminal,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayContext } from "../context.js";
import { nowIso } from "../db/ids.js";
import type { Scheduler } from "../scheduler/scheduler.js";

export interface TrashView {
  workspaces: Workspace[];
  bots: BotDefinition[];
}

export class TrashLifecycle {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly scheduler: Scheduler,
  ) {}

  list(tenantId: string): TrashView {
    return {
      workspaces: this.ctx.workspaces.listArchived(tenantId),
      bots: this.ctx.bots.listArchived(tenantId),
    };
  }

  /**
   * One page of the tenant's archived workspaces, most recently archived first with the id as
   * tie-breaker (`archived_at DESC, id`), and the honest total (#113). Indexed by
   * `workspaces_tenant (tenant_id, archived_at, created_at, id)`.
   */
  workspacePage(
    tenantId: string,
    offset: number,
    limit: number,
    readable?: ReadonlySet<string>,
  ): { workspaces: Workspace[]; total: number } {
    // `readable` narrows the page to the workspaces the caller manages (ADR-0022 amendment 6 W1).
    const scopedIds = readable === undefined ? [] : [...readable];
    const scoped =
      readable === undefined
        ? ""
        : scopedIds.length === 0
          ? " AND 0"
          : ` AND id IN (${scopedIds.map(() => "?").join(", ")})`;
    const where = `tenant_id = ? AND archived_at IS NOT NULL${scoped}`;
    const { total } = this.ctx.db
      .prepare(`SELECT COUNT(*) AS total FROM workspaces WHERE ${where}`)
      .get(tenantId, ...scopedIds) as { total: number };
    const ids = this.ctx.db
      .prepare(
        `SELECT id FROM workspaces WHERE ${where} ORDER BY archived_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(tenantId, ...scopedIds, limit, offset) as { id: WorkspaceId }[];
    return {
      workspaces: ids.map(({ id }) => this.ctx.workspaces.mustGetIncludingArchived(id)),
      total,
    };
  }

  async archiveWorkspace(id: WorkspaceId, actor: string): Promise<Workspace> {
    const current = this.ctx.workspaces.mustGetIncludingArchived(id);
    const tenantId = this.ctx.ownership.tenantOf("workspace", id);
    if (!tenantId)
      throw new DeskmatesError("not_found", `workspace ${id} not found`, { workspaceId: id });
    const workspace = this.ctx.db.transaction(() => {
      const archived = this.ctx.workspaces.archive(id, actor);
      if (!current.archivedAt) audit(this.ctx, tenantId, "workspace", id, "archive", actor);
      return archived;
    })();
    this.ctx.bus.publish({ type: "workspace", workspaceId: id, workspace });
    for (const run of this.ctx.runs.listOpenInWorkspace(id)) {
      if (!isTerminal(this.ctx.runs.mustGet(run.id).status)) this.scheduler.cancel(run.id, actor);
    }
    this.ctx.locks.humanRelease(id);
    this.ctx.bus.publish({ type: "workspace_lock", workspaceId: id, browserLock: null });
    // ADR-0017 amendment 1 P6: stopped, with their state and secrets kept for a restore.
    await this.ctx.channels.archiveWorkspace(id);
    await this.ctx.sandboxes.stop(id);
    return workspace;
  }

  async restoreWorkspace(id: WorkspaceId, actor: string): Promise<Workspace> {
    const current = this.ctx.workspaces.mustGetIncludingArchived(id);
    const tenantId = this.ctx.ownership.tenantOf("workspace", id);
    if (!tenantId)
      throw new DeskmatesError("not_found", `workspace ${id} not found`, { workspaceId: id });
    const workspace = this.ctx.db.transaction(() => {
      const restored = this.ctx.workspaces.restore(id);
      if (current.archivedAt) audit(this.ctx, tenantId, "workspace", id, "restore", actor);
      return restored;
    })();
    this.ctx.bus.publish({ type: "workspace", workspaceId: id, workspace });
    // Decision 3: the channel runtime starts again through its normal connection lifecycle.
    if (current.archivedAt) await this.ctx.channels.restoreWorkspace(id);
    return workspace;
  }

  archiveBot(id: BotId, actor: string): BotDefinition {
    const current = this.ctx.bots.mustGetIncludingArchived(id);
    const tenantId = this.ctx.ownership.tenantOf("bot", id);
    if (!tenantId) throw new DeskmatesError("not_found", `bot ${id} not found`, { botId: id });
    const bot = this.ctx.db.transaction(() => {
      const archived = this.ctx.bots.archive(id, actor);
      if (!current.archivedAt) audit(this.ctx, tenantId, "bot", id, "archive", actor);
      return archived;
    })();
    for (const run of this.ctx.runs.list({ botId: id })) {
      if (!isTerminal(run.status)) this.scheduler.cancel(run.id, actor);
    }
    return bot;
  }

  restoreBot(id: BotId, actor: string): BotDefinition {
    const bot = this.ctx.bots.mustGetIncludingArchived(id);
    this.ctx.workspaces.mustGet(bot.workspaceId);
    const tenantId = this.ctx.ownership.tenantOf("bot", id);
    if (!tenantId) throw new DeskmatesError("not_found", `bot ${id} not found`, { botId: id });
    return this.ctx.db.transaction(() => {
      const restored = this.ctx.bots.restore(id);
      if (bot.archivedAt) audit(this.ctx, tenantId, "bot", id, "restore", actor);
      return restored;
    })();
  }

  async deleteWorkspace(
    id: WorkspaceId,
    typedName: string,
    actor: string,
    tenantId: string,
  ): Promise<void> {
    const workspace = this.ctx.workspaces.mustGetIncludingArchived(id);
    requirePermanentDelete(workspace.archivedAt, workspace.name, typedName, "workspace", id);
    await this.ctx.integrations.permanentlyDeleteWorkspace(id);
    await this.ctx.channels.permanentlyDeleteWorkspace(id);
    await this.ctx.sandboxes.permanentlyDelete(id);
    this.ctx.db.transaction(() => {
      authorizePermanentDelete(this.ctx, "workspace", id);
      deleteWorkspaceRows(this.ctx, id, actor, tenantId);
    })();
  }

  deleteBot(id: BotId, typedName: string, actor: string, tenantId: string): void {
    const bot = this.ctx.bots.mustGetIncludingArchived(id);
    requirePermanentDelete(bot.archivedAt, bot.name, typedName, "bot", id);
    this.ctx.db.transaction(() => {
      authorizePermanentDelete(this.ctx, "bot", id);
      deleteBotRows(this.ctx, id, actor, tenantId);
    })();
  }
}

function authorizePermanentDelete(
  ctx: GatewayContext,
  kind: "workspace" | "bot",
  id: string,
): void {
  ctx.db
    .prepare("INSERT INTO permanent_delete_context (object_id, object_kind) VALUES (?, ?)")
    .run(id, kind);
}

/** Lifecycle changes are in the audit record (ADR-0031 decision 11), which outlives a purge. */
function audit(
  ctx: GatewayContext,
  tenantId: string,
  kind: "workspace" | "bot",
  id: string,
  action: "archive" | "restore" | "purge",
  actor: string,
): void {
  const workspaceId =
    kind === "workspace"
      ? id
      : (
          ctx.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(id) as
            | { workspace_id: string }
            | undefined
        )?.workspace_id;
  new AuditLog(ctx.db).record({
    action: `${kind}.${action}`,
    actor,
    tenantId,
    ...(workspaceId ? { workspaceId } : {}),
    targetKind: kind,
    targetId: id,
  });
}

function requirePermanentDelete(
  archivedAt: string | undefined,
  actualName: string,
  typedName: string,
  kind: string,
  id: string,
): void {
  if (!archivedAt) {
    throw new DeskmatesError("invalid_transition", `${kind} ${id} must be in Trash first`);
  }
  if (typedName !== actualName) {
    throw new DeskmatesError("validation", `typed name does not match ${kind} ${id}`);
  }
}

function ids(ctx: GatewayContext, sql: string, ...params: string[]): string[] {
  return (ctx.db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);
}

/** Secret ids are polymorphic references; collect them before the rows naming them go. */
function deleteSecrets(ctx: GatewayContext, secretIds: readonly string[]): void {
  const remove = ctx.db.prepare("DELETE FROM secrets WHERE id = ?");
  for (const id of new Set(secretIds)) remove.run(id);
}

/**
 * Every workspace-owned row cascades from the workspace (ADR-0031 decision 6); immutable history
 * lets the cascade through while the permanent-delete context row exists.
 */
function deleteWorkspaceRows(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  actor: string,
  tenantId: string,
): void {
  const secretIds = [
    ...ids(
      ctx,
      "SELECT secret_id AS id FROM integration_workspace_tokens WHERE workspace_id = ?",
      workspaceId,
    ),
    ...ids(
      ctx,
      "SELECT secret_id AS id FROM connectors WHERE workspace_id = ? AND secret_id IS NOT NULL",
      workspaceId,
    ),
    ...ids(
      ctx,
      "SELECT id FROM secrets WHERE owner_kind = 'workspace' AND owner_id = ?",
      workspaceId,
    ),
  ];
  audit(ctx, tenantId, "workspace", workspaceId, "purge", actor);
  ctx.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  deleteSecrets(ctx, secretIds);
  finishPermanentDelete(ctx, "workspace", workspaceId, actor, tenantId);
}

/**
 * A bot's rows cascade from the bot. Its canonical private chats and the messages it wrote in
 * other threads are its content too; the shared threads themselves stay.
 */
function deleteBotRows(ctx: GatewayContext, botId: BotId, actor: string, tenantId: string): void {
  ctx.db
    .prepare(
      "DELETE FROM threads WHERE id IN (SELECT thread_id FROM private_chats WHERE bot_id = ?)",
    )
    .run(botId);
  ctx.db
    .prepare("DELETE FROM thread_messages WHERE author_kind = 'bot' AND author_id = ?")
    .run(botId);
  audit(ctx, tenantId, "bot", botId, "purge", actor);
  ctx.db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
  finishPermanentDelete(ctx, "bot", botId, actor, tenantId);
}

function finishPermanentDelete(
  ctx: GatewayContext,
  kind: "workspace" | "bot",
  id: string,
  actor: string,
  tenantId: string,
): void {
  ctx.db
    .prepare("DELETE FROM permanent_delete_context WHERE object_kind = ? AND object_id = ?")
    .run(kind, id);
  ctx.db
    .prepare(
      "INSERT INTO deletion_tombstones (object_id, object_kind, tenant_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, kind, tenantId, actor, nowIso());
}
