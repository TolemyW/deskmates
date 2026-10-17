// Publications of workspace services (ADR-0035 decisions 1 and 8), by a bot or a Member
// (owner-decided 2026-10-14). Publishing and revoking write their audit row in the same
// transaction. The row's id is `app_<32 hex>`; the hex part is the app's host label.

import {
  APP_SHARES_PER_WORKSPACE_MAX,
  APP_SHARE_LABEL_MAX,
  DeskmatesError,
  appSharePortAllowed,
} from "@deskmates/contracts";
import type { AuditLog } from "../audit/audit-log.js";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export interface AppShareRow {
  id: string;
  workspaceId: string;
  port: number;
  label: string;
  botId: string | null;
  runId: string | null;
  /** A person's actor label when they published from the UI; null for a bot. */
  publishedBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** Who publishes: a bot from a run, or a person (owner-decided 2026-10-14). */
export type AppPublisher =
  | { kind: "bot"; botId: string; runId: string }
  | { kind: "person"; actor: string };

interface DbRow {
  id: string;
  workspace_id: string;
  port: number;
  label: string;
  bot_id: string | null;
  run_id: string | null;
  published_by: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

const fromDb = (row: DbRow): AppShareRow => ({
  id: row.id,
  workspaceId: row.workspace_id,
  port: row.port,
  label: row.label,
  botId: row.bot_id,
  runId: row.run_id,
  publishedBy: row.published_by,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by,
});

/** The DNS label of a publication: the 32 hex characters after `app_`. */
export const hostLabelOf = (id: string): string => id.slice("app_".length);

/** Whether `text` holds a C0 control character or DEL. */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validPublishInput(port: unknown, label: unknown): { port: number; label: string } {
  if (typeof port !== "number" || !appSharePortAllowed(port))
    throw new DeskmatesError(
      "validation",
      "port must be a TCP port from 1024 to 65535 and not 6080 to 6086 (the screen relays)",
      { field: "port" },
    );
  const text = typeof label === "string" ? label.trim() : "";
  if (text === "" || text.length > APP_SHARE_LABEL_MAX || hasControlCharacter(text))
    throw new DeskmatesError(
      "validation",
      `label must be 1 to ${APP_SHARE_LABEL_MAX} characters on one line`,
      { field: "label" },
    );
  return { port, label: text };
}

export class AppShareStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly audit: AuditLog,
  ) {}

  get(id: string): AppShareRow | undefined {
    const row = this.db.prepare("SELECT * FROM app_shares WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row && fromDb(row);
  }

  /** The publication a host label names, active or not. */
  byLabel(label: string): AppShareRow | undefined {
    return /^[0-9a-f]{32}$/.test(label) ? this.get(`app_${label}`) : undefined;
  }

  list(workspaceId: string): AppShareRow[] {
    return (
      this.db
        .prepare("SELECT * FROM app_shares WHERE workspace_id = ? ORDER BY created_at DESC, id")
        .all(workspaceId) as DbRow[]
    ).map(fromDb);
  }

  activeIds(workspaceId: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM app_shares WHERE workspace_id = ? AND revoked_at IS NULL")
        .all(workspaceId) as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * Publish `port`, or relabel the active publication it already has. Audited as the bot, with
   * the run, or as the person, in the same transaction.
   */
  publish(input: {
    workspaceId: string;
    port: unknown;
    label: unknown;
    by: AppPublisher;
  }): { share: AppShareRow; existing: boolean } {
    const { port, label } = validPublishInput(input.port, input.label);
    const by = input.by;
    const actor = by.kind === "bot" ? `bot:${by.botId}` : by.actor;
    const runId = by.kind === "bot" ? { runId: by.runId } : {};
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT * FROM app_shares WHERE workspace_id = ? AND port = ? AND revoked_at IS NULL",
        )
        .get(input.workspaceId, port) as DbRow | undefined;
      if (current) {
        if (current.label !== label) {
          this.db.prepare("UPDATE app_shares SET label = ? WHERE id = ?").run(label, current.id);
          this.audit.record({
            action: "app_share.publish",
            actor,
            workspaceId: input.workspaceId,
            targetKind: "app_share",
            targetId: current.id,
            before: { port, label: current.label },
            after: { port, label },
            ...runId,
          });
        }
        return { share: fromDb({ ...current, label }), existing: true };
      }
      const active = this.activeIds(input.workspaceId).length;
      if (active >= APP_SHARES_PER_WORKSPACE_MAX)
        throw new DeskmatesError(
          "queue_full",
          `this workspace already has ${APP_SHARES_PER_WORKSPACE_MAX} published apps; stop sharing one first`,
          { limit: APP_SHARES_PER_WORKSPACE_MAX },
        );
      const row: DbRow = {
        id: newId("app"),
        workspace_id: input.workspaceId,
        port,
        label,
        bot_id: by.kind === "bot" ? by.botId : null,
        run_id: by.kind === "bot" ? by.runId : null,
        published_by: by.kind === "person" ? by.actor : null,
        created_at: nowIso(),
        revoked_at: null,
        revoked_by: null,
      };
      this.db
        .prepare(
          `INSERT INTO app_shares
             (id, workspace_id, port, label, bot_id, run_id, published_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.workspace_id,
          port,
          label,
          row.bot_id,
          row.run_id,
          row.published_by,
          row.created_at,
        );
      this.audit.record({
        action: "app_share.publish",
        actor,
        workspaceId: input.workspaceId,
        targetKind: "app_share",
        targetId: row.id,
        after: { port, label },
        ...runId,
      });
      return { share: fromDb(row), existing: false };
    })();
  }

  /** Revoke an active publication; revoking a revoked one changes nothing. */
  revoke(id: string, actor: string): AppShareRow {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new DeskmatesError("not_found", "app share not found");
      if (current.revokedAt !== null) return current;
      const revokedAt = nowIso();
      this.db
        .prepare("UPDATE app_shares SET revoked_at = ?, revoked_by = ? WHERE id = ?")
        .run(revokedAt, actor, id);
      this.audit.record({
        action: "app_share.revoke",
        actor,
        workspaceId: current.workspaceId,
        targetKind: "app_share",
        targetId: id,
        before: { port: current.port, label: current.label },
      });
      return { ...current, revokedAt, revokedBy: actor };
    })();
  }
}
