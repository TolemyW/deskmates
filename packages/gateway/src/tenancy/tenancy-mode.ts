// The second-tenant gate (ADR-0022 decision 6). `single` is today's deployment: one tenant.
// `multi` exposes more than one tenant and only starts when the database and configuration pass
// the preflight below. In both modes the operator credential acts in the Default Tenant only and
// cannot select another, so it never crosses a tenant boundary.

import { DeskmatesError } from "@deskmates/contracts";
import type { AuthConfig } from "../auth/auth-service.js";
import type { GatewayDb } from "../db/open.js";

export type TenancyMode = "single" | "multi";
export const TENANCY_MODE_DEFAULT: TenancyMode = "single";

export function parseTenancyMode(raw: string | undefined): TenancyMode {
  const value = (raw ?? "").trim();
  if (value === "") return TENANCY_MODE_DEFAULT;
  if (value === "single" || value === "multi") return value;
  throw new DeskmatesError("validation", "DESKMATES_TENANCY must be single or multi", {
    key: "DESKMATES_TENANCY",
  });
}

/** Rows that would make a tenant boundary unprovable; each is a reason not to start `multi`. */
export function tenancyPreflight(db: GatewayDb, auth: Pick<AuthConfig, "cookieMode">): string[] {
  const problems: string[] = [];
  if (auth.cookieMode !== "secure")
    problems.push("GATEWAY_SESSION_COOKIE must be secure (HTTPS, __Host- cookies)");
  const fk = db.pragma("foreign_key_check") as unknown[];
  if (fk.length > 0) problems.push(`${fk.length} foreign key violation(s)`);
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  // Tenant and workspace columns are NOT NULL in the schema baseline (ADR-0031 decision 6); these
  // relations are checked by triggers and composite keys and are verified again here.
  const orphans: Array<[string, string]> = [
    [
      "workspaces of a missing tenant",
      "SELECT COUNT(*) AS n FROM workspaces w LEFT JOIN tenants t ON t.id = w.tenant_id WHERE t.id IS NULL",
    ],
    [
      "threads whose bots are in another workspace",
      `SELECT COUNT(*) AS n FROM thread_members m JOIN threads t ON t.id = m.thread_id
       JOIN bots b ON b.id = m.bot_id WHERE b.workspace_id <> t.workspace_id`,
    ],
    [
      "runs whose thread is in another workspace",
      `SELECT COUNT(*) AS n FROM runs r JOIN threads t ON t.id = r.thread_id
       WHERE t.workspace_id <> r.workspace_id`,
    ],
  ];
  for (const [label, sql] of orphans) {
    const n = count(sql);
    if (n > 0) problems.push(`${n} ${label}`);
  }
  return problems;
}

/**
 * Called before the Gateway serves anything. `single` refuses a database that already holds
 * more than one tenant (it would serve mixed data without the multi-tenant guards); `multi`
 * refuses to start until the preflight is clean.
 */
export function assertTenancyReady(
  db: GatewayDb,
  mode: TenancyMode,
  auth: Pick<AuthConfig, "cookieMode">,
): void {
  const tenants = (db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n;
  if (mode === "single" && tenants > 1)
    throw new DeskmatesError(
      "invalid_transition",
      `the database holds ${tenants} tenants; start with DESKMATES_TENANCY=multi (never downgrade a multi-tenant database)`,
    );
  if (mode === "multi") {
    const problems = tenancyPreflight(db, auth);
    if (problems.length > 0)
      throw new DeskmatesError(
        "invalid_transition",
        `DESKMATES_TENANCY=multi refused: ${problems.join("; ")}`,
        { problems },
      );
  }
}
