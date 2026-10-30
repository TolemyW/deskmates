// The connector registry (ADR-0012 items 2 and 8). A connector belongs to one workspace; its URL
// and credential go to the Secrets Store and the row keeps only a reference. Registering one does
// not touch the workspace's egress allowlist: the workspace never reaches the connector, the
// Gateway does.

import {
  type ConnectorId,
  type ConnectorRegistration,
  DeskmatesError,
  type RegisterConnectorRequest,
  type WorkspaceId,
  isPublicHostname,
} from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { SecretsStore } from "../secrets/secrets-store.js";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** What only the proxy reads: where the connector is and how to authenticate to it. */
export interface ConnectorEndpoint {
  url: string;
  credential?: string;
}

interface ConnectorRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  public_url: number;
  secret_id: string;
  created_at: string;
}

function toRegistration(row: ConnectorRow): ConnectorRegistration {
  return {
    id: row.id as ConnectorId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name,
    kind: row.kind,
    publicUrl: row.public_url === 1,
    createdAt: row.created_at,
  };
}

/**
 * An http(s) URL with no user info (a credential goes in `credential`, where it is sent as a
 * Bearer header). A URL the operator marks public is held to the name-level rule of the managed
 * egress proxy (`isPublicHostname`): no IP literal, no loopback or host alias. An unmarked URL may
 * point at a private network, which is reachable only because the Gateway, not the workspace,
 * calls it (ADR-0012 item 8).
 */
function checkUrl(raw: unknown, publicUrl: boolean): string {
  if (typeof raw !== "string" || raw.trim() === "")
    throw new DeskmatesError("validation", "connector url is required");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DeskmatesError("validation", "connector url is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new DeskmatesError("validation", "connector url must be http or https");
  if (url.username || url.password)
    throw new DeskmatesError(
      "validation",
      "put the connector credential in `credential`, not the URL",
    );
  if (publicUrl && !isPublicHostname(url.hostname))
    throw new DeskmatesError("validation", "a public connector url must name a public host");
  return url.href.replace(/\/+$/, "");
}

export class ConnectorRegistry {
  constructor(
    private readonly db: GatewayDb,
    private readonly secrets: SecretsStore,
  ) {}

  register(req: RegisterConnectorRequest): ConnectorRegistration {
    if (typeof req.name !== "string" || !NAME_PATTERN.test(req.name))
      throw new DeskmatesError("validation", "connector name must match [A-Za-z0-9_-]+");
    const ws = this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(req.workspaceId);
    if (!ws)
      throw new DeskmatesError("not_found", `workspace ${req.workspaceId} not found`, {
        workspaceId: req.workspaceId,
      });
    const publicUrl = req.publicUrl === true;
    const url = checkUrl(req.url, publicUrl);
    if (req.credential !== undefined && typeof req.credential !== "string")
      throw new DeskmatesError("validation", "connector credential must be a string");
    const taken = this.db
      .prepare("SELECT 1 FROM connectors WHERE workspace_id = ? AND name = ?")
      .get(req.workspaceId, req.name);
    if (taken)
      throw new DeskmatesError("validation", `connector ${req.name} already exists in workspace`, {
        name: req.name,
        workspaceId: req.workspaceId,
      });
    const id = newId("con") as ConnectorId;
    const endpoint: ConnectorEndpoint = {
      url,
      ...(req.credential ? { credential: req.credential } : {}),
    };
    const createdAt = nowIso();
    this.db.transaction(() => {
      // The row first: `secrets.owner_id` names it, and the row then points back at the secret.
      this.db
        .prepare(
          "INSERT INTO connectors (id, kind, name, config_json, workspace_id, public_url, created_at) VALUES (?, ?, ?, '{}', ?, ?, ?)",
        )
        .run(
          id,
          req.kind?.trim() || "http",
          req.name,
          req.workspaceId,
          publicUrl ? 1 : 0,
          createdAt,
        );
      const secretId = this.secrets.put("connector", id, JSON.stringify(endpoint));
      this.db.prepare("UPDATE connectors SET secret_id = ? WHERE id = ?").run(secretId, id);
    })();
    return this.mustGet(id);
  }

  /** With a tenant, that tenant's connectors only (ADR-0022 P2). */
  list(workspaceId?: WorkspaceId, tenantId?: string): ConnectorRegistration[] {
    const tenant = "(? IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?))";
    const rows = (
      workspaceId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM connectors WHERE workspace_id IS NOT NULL AND ${tenant} ORDER BY created_at, id`,
            )
            .all(tenantId ?? null, tenantId ?? null)
        : this.db
            .prepare(
              `SELECT * FROM connectors WHERE workspace_id = ? AND ${tenant} ORDER BY created_at, id`,
            )
            .all(workspaceId, tenantId ?? null, tenantId ?? null)
    ) as ConnectorRow[];
    return rows.map(toRegistration);
  }

  /**
   * One page of connectors, oldest first with the id as tie-breaker (`created_at, id`), and the
   * honest total (#113). With a tenant, that tenant's only. Indexed per workspace by
   * `connectors_workspace_created (workspace_id, created_at, id)`.
   */
  page(
    workspaceId: WorkspaceId | undefined,
    tenantId: string | undefined,
    offset: number,
    limit: number,
    readable?: ReadonlySet<string>,
  ): { connectors: ConnectorRegistration[]; total: number } {
    // `readable` narrows the list to the workspaces the caller may read (ADR-0022 amendment 6 W1).
    const ids = readable === undefined ? undefined : [...readable];
    const scoped =
      ids === undefined
        ? ""
        : ids.length === 0
          ? " AND 0"
          : ` AND workspace_id IN (${ids.map(() => "?").join(", ")})`;
    const where = `${workspaceId === undefined ? "workspace_id IS NOT NULL" : "workspace_id = ?"}
      AND (? IS NULL OR workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?))${scoped}`;
    const params = [
      ...(workspaceId === undefined ? [] : [workspaceId]),
      tenantId ?? null,
      tenantId ?? null,
      ...(ids ?? []),
    ];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM connectors WHERE ${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM connectors WHERE ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ConnectorRow[];
    return { connectors: rows.map(toRegistration), total };
  }

  get(id: string): ConnectorRegistration | undefined {
    const row = this.db
      .prepare("SELECT * FROM connectors WHERE id = ? AND workspace_id IS NOT NULL")
      .get(id) as ConnectorRow | undefined;
    return row ? toRegistration(row) : undefined;
  }

  mustGet(id: string): ConnectorRegistration {
    const c = this.get(id);
    if (!c) throw new DeskmatesError("not_found", `connector ${id} not found`, { connectorId: id });
    return c;
  }

  /**
   * The connector a run of `workspaceId` names by id or by name. An id of another workspace's
   * connector is 403: the run token is valid, it just does not cover that connector. This is the
   * workspace boundary, not a check between bots; any bot of the workspace may use any of its
   * connectors (ADR-0012 item 3, ADR-0004).
   */
  resolve(workspaceId: WorkspaceId, ref: string): ConnectorRegistration {
    const byId = this.get(ref);
    if (byId) {
      if (byId.workspaceId !== workspaceId)
        throw new DeskmatesError("forbidden", "connector belongs to another workspace", {
          connector: ref,
        });
      return byId;
    }
    const row = this.db
      .prepare("SELECT * FROM connectors WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, ref) as ConnectorRow | undefined;
    if (!row)
      throw new DeskmatesError("not_found", `connector ${ref} not found in this workspace`, {
        connector: ref,
      });
    return toRegistration(row);
  }

  /** Decrypts the endpoint; only the proxy calls this. */
  endpoint(id: ConnectorId): ConnectorEndpoint {
    const row = this.db.prepare("SELECT secret_id FROM connectors WHERE id = ?").get(id) as
      | { secret_id: string | null }
      | undefined;
    if (!row?.secret_id)
      throw new DeskmatesError("not_found", `connector ${id} has no endpoint`, { connectorId: id });
    return JSON.parse(this.secrets.get(row.secret_id)) as ConnectorEndpoint;
  }
}
