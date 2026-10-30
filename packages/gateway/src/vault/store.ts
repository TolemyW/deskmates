// The Vault catalog (ADR-0045 decisions 1 to 3): metadata in `vault_entries`, each value one
// encrypted blob in the Secrets Store owned by the entry's workspace. Ordinary reads return
// metadata only; the one method that decrypts (`payload`) checks the catalog-to-secret binding
// against the workspace first. Every change is one transaction with its audit row, and needs the
// revision the edit started from. Without `GATEWAY_SECRETS_KEY` a create or replace fails closed.

import {
  DeskmatesError,
  type VaultEntry,
  type VaultEntryType,
  type VaultLastUse,
  type VaultRequestDefinition,
  type VaultToolEntry,
  type VaultUseStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import {
  type VaultPayload,
  expectedRevision,
  requestDefinitions,
  vaultName,
  vaultPayload,
  vaultPurpose,
  vaultTargetOrigin,
  vaultType,
} from "./validate.js";

interface EntryRow {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  type: VaultEntryType;
  target_origin: string;
  is_enabled: number;
  revision: number;
  secret_id: string;
  has_username: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

/** The entry fields a use needs, never the value. */
export interface VaultEntryRecord {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  purpose?: string;
  type: VaultEntryType;
  targetOrigin: string;
  enabled: boolean;
  revision: number;
  requests: VaultRequestDefinition[];
}

/** What an audit row may say about an entry: metadata, never a value. */
function metadata(row: EntryRow, requests?: VaultRequestDefinition[]) {
  return {
    name: row.name,
    purpose: row.purpose,
    type: row.type,
    targetOrigin: row.target_origin,
    enabled: row.is_enabled === 1,
    revision: row.revision,
    ...(requests ? { requests: requests.map((r) => `${r.method} ${r.path}`) } : {}),
  };
}

function unavailable(): never {
  throw new DeskmatesError(
    "validation",
    "the Vault needs GATEWAY_SECRETS_KEY before a credential can be stored",
    { reason: "vault_unavailable" },
  );
}

export class VaultStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly secrets: SecretsStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Decision 3: without a key nothing is stored or used. */
  get available(): boolean {
    return this.secrets.enabled;
  }

  private row(workspaceId: string, entryId: string): EntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM vault_entries WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, entryId) as EntryRow | undefined;
  }

  /** The entry in this workspace, or the uniform 404 for a missing one or another workspace's. */
  private mustRow(workspaceId: string, entryId: string): EntryRow {
    const row = this.row(workspaceId, entryId);
    if (!row) throw new DeskmatesError("not_found", "Vault entry not found");
    return row;
  }

  private requests(workspaceId: string, entryId: string): VaultRequestDefinition[] {
    return (
      this.db
        .prepare(
          `SELECT id, definition_json FROM vault_request_definitions
            WHERE workspace_id = ? AND entry_id = ? ORDER BY position`,
        )
        .all(workspaceId, entryId) as { id: string; definition_json: string }[]
    ).map(
      (r) => ({ ...(JSON.parse(r.definition_json) as object), id: r.id }) as VaultRequestDefinition,
    );
  }

  private lastUse(workspaceId: string, entryId: string): VaultLastUse | undefined {
    const row = this.db
      .prepare(
        `SELECT u.created_at, u.operation, u.status, u.run_id, r.bot_id FROM vault_uses u
           JOIN runs r ON r.id = u.run_id
          WHERE u.workspace_id = ? AND u.entry_id = ? ORDER BY u.created_at DESC LIMIT 1`,
      )
      .get(workspaceId, entryId) as
      | {
          created_at: string;
          operation: "fill" | "request";
          status: string | null;
          run_id: string;
          bot_id: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      at: row.created_at,
      operation: row.operation,
      status: (row.status ?? "unknown") as VaultUseStatus,
      botId: row.bot_id,
      runId: row.run_id,
    };
  }

  private entry(row: EntryRow): VaultEntry {
    const requests = this.requests(row.workspace_id, row.id);
    const enabled = row.is_enabled === 1;
    const unusableReason = !this.available
      ? "vault_unavailable"
      : !enabled
        ? "disabled"
        : row.type === "http_header_token" && requests.length === 0
          ? "no_request_definition"
          : undefined;
    const lastUse = this.lastUse(row.workspace_id, row.id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      ...(row.purpose ? { purpose: row.purpose } : {}),
      type: row.type,
      targetOrigin: row.target_origin,
      enabled,
      revision: row.revision,
      hasUsername: row.has_username === 1,
      usable: unusableReason === undefined,
      ...(unusableReason ? { unusableReason } : {}),
      requests,
      ...(lastUse ? { lastUse } : {}),
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /** Operator listing: metadata, never values (decision 2). */
  list(workspaceId: string): VaultEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM vault_entries WHERE workspace_id = ? ORDER BY name")
        .all(workspaceId) as EntryRow[]
    ).map((row) => this.entry(row));
  }

  get(workspaceId: string, entryId: string): VaultEntry {
    return this.entry(this.mustRow(workspaceId, entryId));
  }

  /** The record a use is checked against, or undefined (another workspace's is undefined too). */
  record(workspaceId: string, entryId: string): VaultEntryRecord | undefined {
    const row = this.row(workspaceId, entryId);
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id as WorkspaceId,
      name: row.name,
      ...(row.purpose ? { purpose: row.purpose } : {}),
      type: row.type,
      targetOrigin: row.target_origin,
      enabled: row.is_enabled === 1,
      revision: row.revision,
      requests: this.requests(row.workspace_id, row.id),
    };
  }

  /** Decision 1: what `vault_list` shows, the usable entries of the run's own workspace. */
  toolListing(workspaceId: string): VaultToolEntry[] {
    if (!this.available) return [];
    return this.list(workspaceId)
      .filter((e) => e.usable)
      .map((e) => ({
        id: e.id,
        name: e.name,
        ...(e.purpose ? { purpose: e.purpose } : {}),
        type: e.type,
        targetOrigin: e.targetOrigin,
        revision: e.revision,
        ...(e.type === "http_header_token"
          ? {
              requests: e.requests.map((r) => ({
                id: r.id,
                name: r.name,
                ...(r.description ? { description: r.description } : {}),
                method: r.method,
                path: r.path,
                params: r.params,
                effect: r.effect,
              })),
            }
          : {}),
      }));
  }

  /** Whether the workspace has at least one usable entry: the vault tools are offered then. */
  hasUsable(workspaceId: string): boolean {
    return this.toolListing(workspaceId).length > 0;
  }

  create(workspaceId: string, raw: Record<string, unknown>, actor: string): VaultEntry {
    if (!this.available) unavailable();
    const name = vaultName(raw.name);
    const purpose = vaultPurpose(raw.purpose);
    const type = vaultType(raw.type);
    const targetOrigin = vaultTargetOrigin(raw.targetOrigin);
    const payload = vaultPayload(type, raw);
    const id = newId("vlt");
    const at = this.now().toISOString();
    this.db.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM vault_entries WHERE workspace_id = ? AND name = ?")
          .get(workspaceId, name)
      )
        throw new DeskmatesError("validation", "an entry of that name exists", { field: "name" });
      const secretId = this.secrets.put("workspace", workspaceId, JSON.stringify(payload));
      this.db
        .prepare(
          `INSERT INTO vault_entries (id, workspace_id, name, purpose, type, target_origin, is_enabled,
             revision, secret_id, has_username, created_by, created_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          name,
          purpose ?? null,
          type,
          targetOrigin,
          secretId,
          "username" in payload && payload.username !== "" ? 1 : 0,
          actor,
          at,
          actor,
          at,
        );
      new AuditLog(this.db).record({
        action: "vault.entry_create",
        actor,
        workspaceId,
        targetKind: "vault_entry",
        targetId: id,
        after: metadata(this.mustRow(workspaceId, id)),
      });
    })();
    return this.get(workspaceId, id);
  }

  private checkRevision(row: EntryRow, raw: unknown): void {
    const expected = expectedRevision(raw);
    if (expected !== row.revision)
      throw new DeskmatesError("invalid_transition", "the entry changed since this edit started", {
        reason: "stale_revision",
        revision: row.revision,
      });
  }

  /** Decision 2: name, purpose, target and enabled state; the value is left as it is. */
  patch(
    workspaceId: string,
    entryId: string,
    raw: Record<string, unknown>,
    actor: string,
  ): VaultEntry {
    for (const key of Object.keys(raw))
      if (!["expectedRevision", "name", "purpose", "enabled", "targetOrigin"].includes(key))
        throw new DeskmatesError(
          "validation",
          "only metadata changes here; replace the value with its own route",
          {
            field: key,
          },
        );
    const name = raw.name === undefined ? undefined : vaultName(raw.name);
    const purpose = raw.purpose === undefined ? undefined : (vaultPurpose(raw.purpose) ?? null);
    const targetOrigin =
      raw.targetOrigin === undefined ? undefined : vaultTargetOrigin(raw.targetOrigin);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
      throw new DeskmatesError("validation", "enabled is a boolean", { field: "enabled" });
    this.db.transaction(() => {
      const before = this.mustRow(workspaceId, entryId);
      this.checkRevision(before, raw.expectedRevision);
      if (
        name !== undefined &&
        name !== before.name &&
        this.db
          .prepare("SELECT 1 FROM vault_entries WHERE workspace_id = ? AND name = ?")
          .get(workspaceId, name)
      )
        throw new DeskmatesError("validation", "an entry of that name exists", { field: "name" });
      this.db
        .prepare(
          `UPDATE vault_entries SET name = ?, purpose = ?, target_origin = ?, is_enabled = ?,
             revision = revision + 1, updated_by = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          name ?? before.name,
          purpose === undefined ? before.purpose : purpose,
          targetOrigin ?? before.target_origin,
          raw.enabled === undefined ? before.is_enabled : raw.enabled ? 1 : 0,
          actor,
          this.now().toISOString(),
          workspaceId,
          entryId,
        );
      new AuditLog(this.db).record({
        action: "vault.entry_update",
        actor,
        workspaceId,
        targetKind: "vault_entry",
        targetId: entryId,
        before: metadata(before),
        after: metadata(this.mustRow(workspaceId, entryId)),
      });
    })();
    return this.get(workspaceId, entryId);
  }

  /**
   * Decision 3: a replacement points the entry at a new secret and bumps the revision in one
   * transaction, and deletes the old blob. A use already handed to an executor is not recalled.
   */
  replaceValue(
    workspaceId: string,
    entryId: string,
    raw: Record<string, unknown>,
    actor: string,
  ): VaultEntry {
    if (!this.available) unavailable();
    for (const key of Object.keys(raw))
      if (!["expectedRevision", "username", "password", "token"].includes(key))
        throw new DeskmatesError("validation", "only the value changes here", { field: key });
    this.db.transaction(() => {
      const before = this.mustRow(workspaceId, entryId);
      this.checkRevision(before, raw.expectedRevision);
      const payload = vaultPayload(before.type, raw);
      const secretId = this.secrets.put("workspace", workspaceId, JSON.stringify(payload));
      this.db
        .prepare(
          `UPDATE vault_entries SET secret_id = ?, has_username = ?, revision = revision + 1,
             updated_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          secretId,
          "username" in payload && payload.username !== "" ? 1 : 0,
          actor,
          this.now().toISOString(),
          workspaceId,
          entryId,
        );
      this.secrets.delete(before.secret_id);
      new AuditLog(this.db).record({
        action: "vault.value_replace",
        actor,
        workspaceId,
        targetKind: "vault_entry",
        targetId: entryId,
        before: { revision: before.revision },
        after: { revision: before.revision + 1 },
      });
    })();
    return this.get(workspaceId, entryId);
  }

  /** Decision 6: the token entry's request definitions, replaced whole; an id keeps its row id. */
  setRequests(
    workspaceId: string,
    entryId: string,
    raw: Record<string, unknown>,
    actor: string,
  ): VaultEntry {
    const definitions = requestDefinitions(raw.requests);
    this.db.transaction(() => {
      const before = this.mustRow(workspaceId, entryId);
      this.checkRevision(before, raw.expectedRevision);
      if (before.type !== "http_header_token")
        throw new DeskmatesError(
          "validation",
          "only an HTTP header token has request definitions",
          {
            field: "requests",
          },
        );
      const previous = this.requests(workspaceId, entryId);
      const known = new Set(previous.map((r) => r.id));
      this.db
        .prepare("DELETE FROM vault_request_definitions WHERE workspace_id = ? AND entry_id = ?")
        .run(workspaceId, entryId);
      const insert = this.db.prepare(
        `INSERT INTO vault_request_definitions (id, workspace_id, entry_id, position, definition_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const saved: VaultRequestDefinition[] = [];
      definitions.forEach((d, position) => {
        const { id: given, ...rest } = d;
        const id = given !== undefined && known.has(given) ? given : newId("vrq");
        insert.run(id, workspaceId, entryId, position, JSON.stringify(rest));
        saved.push({ ...rest, id });
      });
      this.db
        .prepare(
          `UPDATE vault_entries SET revision = revision + 1, updated_by = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(actor, this.now().toISOString(), workspaceId, entryId);
      new AuditLog(this.db).record({
        action: "vault.requests_set",
        actor,
        workspaceId,
        targetKind: "vault_entry",
        targetId: entryId,
        before: metadata(before, previous),
        after: metadata(this.mustRow(workspaceId, entryId), saved),
      });
    })();
    return this.get(workspaceId, entryId);
  }

  /**
   * Decision 3: delete prevents new uses at once; the trigger deletes the encrypted blob. It is
   * not a claim of backup erasure, upstream revocation or a browser logout (decision 8).
   */
  delete(workspaceId: string, entryId: string, revision: unknown, actor: string): void {
    this.db.transaction(() => {
      const before = this.mustRow(workspaceId, entryId);
      this.checkRevision(before, revision);
      this.db
        .prepare("DELETE FROM vault_entries WHERE workspace_id = ? AND id = ?")
        .run(workspaceId, entryId);
      new AuditLog(this.db).record({
        action: "vault.entry_delete",
        actor,
        workspaceId,
        targetKind: "vault_entry",
        targetId: entryId,
        before: metadata(before),
      });
    })();
  }

  /**
   * The one decryption (decision 3): the entry must be this workspace's, enabled and at the
   * revision the use was approved for, and its secret must be owned by the same workspace. The
   * value lives in the caller's memory for one use only.
   */
  payload(workspaceId: string, entryId: string, revision: number): VaultPayload | undefined {
    if (!this.available) return undefined;
    const row = this.row(workspaceId, entryId);
    if (!row || row.is_enabled !== 1 || row.revision !== revision) return undefined;
    const bound = this.db
      .prepare("SELECT 1 FROM secrets WHERE id = ? AND owner_kind = 'workspace' AND owner_id = ?")
      .get(row.secret_id, workspaceId);
    if (!bound) return undefined;
    return JSON.parse(this.secrets.get(row.secret_id)) as VaultPayload;
  }
}

const stores = new WeakMap<GatewayDb, VaultStore>();

/**
 * The store for a Gateway context. Built on first use rather than held on the context, whose
 * field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function vaultStore(ctx: { db: GatewayDb; secrets: SecretsStore }): VaultStore {
  let store = stores.get(ctx.db);
  if (!store) {
    store = new VaultStore(ctx.db, ctx.secrets);
    stores.set(ctx.db, store);
  }
  return store;
}
