// Service principals (ADR-0022 amendment 2): a machine identity that belongs to one tenant and
// acts there with its tenant role, `admin` or `member` (amendment 1 A10), for external agent
// clients of the operator API. The token is opaque,
// 256 random bits behind a recognisable prefix, and only its SHA-256 is stored; it is shown once
// at creation or rotation. Every method that names a principal takes the tenant it must belong
// to, so another tenant's id is the same "not found" as a missing one.

import {
  DeskmatesError,
  SERVICE_PRINCIPAL_TOKEN_PREFIX,
  type ServicePrincipalRole,
  type ServicePrincipalStatus,
  type ServicePrincipalView,
  isServicePrincipalRole,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { hashToken, newOpaqueToken } from "./tokens.js";

/** Default for a principal created without a budget; a guess, calibrated against trial use. */
export const SERVICE_PRINCIPAL_DAILY_USD_CAP_DEFAULT = 5;
/** Upper bound on what an Admin may set, so a typo cannot remove the budget altogether. */
export const SERVICE_PRINCIPAL_DAILY_USD_CAP_LIMIT = 10_000;

interface Row {
  id: string;
  tenant_id: string;
  name: string;
  role: ServicePrincipalRole;
  status: ServicePrincipalStatus;
  token_hash: string | null;
  token_issued_at: string | null;
  daily_usd_cap: number;
  created_by: string;
  created_at: string;
  disabled_at: string | null;
}

export interface ServicePrincipalRecord extends ServicePrincipalView {
  tokenHash: string | null;
}

export interface ServicePrincipalBudget {
  dailyUsdCap?: number;
}

function toRecord(row: Row): ServicePrincipalRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    role: row.role,
    status: row.status,
    dailyUsdCap: row.daily_usd_cap,
    createdBy: row.created_by,
    createdAt: row.created_at,
    tokenIssuedAt: row.token_issued_at,
    disabledAt: row.disabled_at,
    tokenHash: row.token_hash,
  };
}

/** The public view: never the token hash. */
export function servicePrincipalView(record: ServicePrincipalRecord): ServicePrincipalView {
  const { tokenHash: _hash, ...view } = record;
  return view;
}

/** Whether a presented bearer value is shaped like a service principal token. */
export function isServicePrincipalToken(token: string): boolean {
  return token.startsWith(SERVICE_PRINCIPAL_TOKEN_PREFIX) && token.length <= 128;
}

function newServiceToken(): string {
  return `${SERVICE_PRINCIPAL_TOKEN_PREFIX}${newOpaqueToken()}`;
}

/** Validate a name and budget; throws `validation` with the field that is wrong. */
export function checkedPrincipalInput(input: {
  name: unknown;
  dailyUsdCap?: unknown;
}): { name: string; dailyUsdCap: number } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 100)
    throw new DeskmatesError("validation", "name must be 1 to 100 characters");
  const cap = input.dailyUsdCap ?? SERVICE_PRINCIPAL_DAILY_USD_CAP_DEFAULT;
  if (
    typeof cap !== "number" ||
    !Number.isFinite(cap) ||
    cap <= 0 ||
    cap > SERVICE_PRINCIPAL_DAILY_USD_CAP_LIMIT
  )
    throw new DeskmatesError(
      "validation",
      `dailyUsdCap must be a number above 0 and at most ${SERVICE_PRINCIPAL_DAILY_USD_CAP_LIMIT}`,
    );
  return { name, dailyUsdCap: cap };
}

export class ServicePrincipalStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  /**
   * Create an active principal in `tenantId`; returns it with its one-time token. Its role is
   * `input.role`, or `ceiling` when absent: the creating Admin's own role (an Owner's is
   * `admin`), which a request may lower to `member` but never raise (ADR-0022 amendment 1 A10).
   */
  create(
    tenantId: string,
    input: { name: unknown; role?: unknown } & {
      [K in keyof ServicePrincipalBudget]?: unknown;
    },
    createdBy: string,
    ceiling: ServicePrincipalRole,
  ): { record: ServicePrincipalRecord; token: string } {
    const checked = checkedPrincipalInput(input);
    const role = input.role ?? ceiling;
    if (!isServicePrincipalRole(role))
      throw new DeskmatesError("validation", "role must be admin or member", { field: "role" });
    if (role === "admin" && ceiling !== "admin")
      throw new DeskmatesError("forbidden", "a principal's role cannot exceed its creator's", {
        reason: "role_above_creator",
      });
    const tenant = this.db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenantId);
    if (!tenant) throw new DeskmatesError("not_found", "tenant not found");
    const id = newId("svc");
    const token = newServiceToken();
    const at = this.now();
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO service_principals (id, tenant_id, name, role, token_hash, token_issued_at,
             daily_usd_cap, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          tenantId,
          checked.name,
          role,
          hashToken(token),
          at,
          checked.dailyUsdCap,
          createdBy,
          at,
        );
      new AuditLog(this.db).record({
        action: "service_principal.create",
        actor: createdBy,
        tenantId,
        targetKind: "service_principal",
        targetId: id,
        after: { name: checked.name, role, dailyUsdCap: checked.dailyUsdCap },
      });
      return { record: this.mustGet(tenantId, id), token };
    })();
  }

  get(tenantId: string, id: string): ServicePrincipalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM service_principals WHERE id = ? AND tenant_id = ?")
      .get(id, tenantId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  mustGet(tenantId: string, id: string): ServicePrincipalRecord {
    const record = this.get(tenantId, id);
    if (!record) throw new DeskmatesError("not_found", "Not found");
    return record;
  }

  /** Any tenant; for the maintenance CLI, which is platform maintenance. */
  getAnyTenant(id: string): ServicePrincipalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM service_principals WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(tenantId?: string): ServicePrincipalRecord[] {
    const rows = (
      tenantId === undefined
        ? this.db.prepare("SELECT * FROM service_principals ORDER BY created_at, id").all()
        : this.db
            .prepare("SELECT * FROM service_principals WHERE tenant_id = ? ORDER BY created_at, id")
            .all(tenantId)
    ) as Row[];
    return rows.map(toRecord);
  }

  /** The active principal a presented token stands for, read fresh on every call. */
  findActiveByToken(token: string): ServicePrincipalRecord | undefined {
    if (!isServicePrincipalToken(token)) return undefined;
    const row = this.db
      .prepare("SELECT * FROM service_principals WHERE token_hash = ? AND status = 'active'")
      .get(hashToken(token)) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Disable for good. Returns the record and the token hash that stopped working. */
  disable(
    tenantId: string,
    id: string,
    by: string,
  ): { record: ServicePrincipalRecord; previousHash: string | null } {
    return this.db.transaction(() => {
      const current = this.mustGet(tenantId, id);
      if (current.status === "disabled") return { record: current, previousHash: null };
      this.db
        .prepare(
          "UPDATE service_principals SET status = 'disabled', disabled_at = ?, disabled_by = ? WHERE id = ? AND tenant_id = ? AND status = 'active'",
        )
        .run(this.now(), by, id, tenantId);
      new AuditLog(this.db).record({
        action: "service_principal.disable",
        actor: by,
        tenantId,
        targetKind: "service_principal",
        targetId: id,
        before: { status: "active" },
        after: { status: "disabled" },
      });
      return { record: this.mustGet(tenantId, id), previousHash: current.tokenHash };
    })();
  }

  /** Replace the token of an active principal; the old one stops working with this write. */
  rotate(
    tenantId: string,
    id: string,
    by = "operator",
  ): { record: ServicePrincipalRecord; token: string; previousHash: string | null } {
    const token = newServiceToken();
    return this.db
      .transaction(() => {
        const current = this.mustGet(tenantId, id);
        if (current.status !== "active")
          throw new DeskmatesError(
            "invalid_transition",
            "a disabled service principal stays disabled",
          );
        this.db
          .prepare(
            "UPDATE service_principals SET token_hash = ?, token_issued_at = ? WHERE id = ? AND tenant_id = ?",
          )
          .run(hashToken(token), this.now(), id, tenantId);
        // The token itself never reaches the record; the row says that it was replaced.
        new AuditLog(this.db).record({
          action: "service_principal.rotate",
          actor: by,
          tenantId,
          targetKind: "service_principal",
          targetId: id,
        });
        return { record: this.mustGet(tenantId, id), token, previousHash: current.tokenHash };
      })
      .immediate();
  }
}
