// The per-workspace `web_search` switch (ADR-0049 decision 4) and what a run freezes from it
// (decision 12). Owner amendment 2026-10-22: no row inherits on when configured; an explicit
// off row stays off. This owner choice does not claim a paired quality improvement.
// The run row records `webSearch` at attempt 1 on an installation that configures
// `SEARCH_URL`, and every later attempt reads it back; an installation without it records nothing.

import {
  DeskmatesError,
  type WebSearchStamp,
  type WebSearchView,
  type WorkspaceId,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { SearchServiceConfig } from "../config/search.js";
import type { GatewayContext } from "../context.js";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

interface Row {
  is_enabled: number;
  updated_by: string;
  updated_at: string;
}

/** The `runs.config_json` keys of decision 12. */
export interface FrozenWebSearch {
  webSearch: WebSearchStamp;
  webSearchVersion: 1;
  webSearchEndpointSha256?: string;
}

export class WebSearchSettings {
  constructor(
    private readonly db: GatewayDb,
    private readonly service: () => SearchServiceConfig | undefined,
  ) {}

  private row(workspaceId: WorkspaceId): Row | undefined {
    return this.db
      .prepare(
        "SELECT is_enabled, updated_by, updated_at FROM workspace_web_search WHERE workspace_id = ?",
      )
      .get(workspaceId) as Row | undefined;
  }

  /** What a run of this workspace that starts now gets. */
  effective(workspaceId: WorkspaceId): boolean {
    return this.service() !== undefined && this.row(workspaceId)?.is_enabled !== 0;
  }

  view(workspaceId: WorkspaceId): WebSearchView {
    const row = this.row(workspaceId);
    return {
      workspaceId,
      configured: this.service() !== undefined,
      enabled: row === undefined ? null : row.is_enabled === 1,
      effective: this.effective(workspaceId),
      defaultEnabled: true,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  /** `{ enabled: true | false | null }`; turning it on needs `SEARCH_URL`. One audit row per change. */
  set(workspaceId: WorkspaceId, raw: Record<string, unknown>, actor: string): void {
    for (const key of Object.keys(raw))
      if (key !== "enabled")
        throw new DeskmatesError("validation", `unknown web search setting ${key}`, { key });
    if (!("enabled" in raw) || (raw.enabled !== null && typeof raw.enabled !== "boolean"))
      throw new DeskmatesError("validation", "enabled must be true, false or null");
    const next = raw.enabled as boolean | null;
    if (next === true && this.service() === undefined)
      throw new DeskmatesError(
        "validation",
        "web search is not configured on this installation (SEARCH_URL)",
        { reason: "search_not_configured" },
      );
    const row = this.row(workspaceId);
    const before = row === undefined ? null : row.is_enabled === 1;
    if (before === next) return;
    this.db.transaction(() => {
      if (next === null)
        this.db.prepare("DELETE FROM workspace_web_search WHERE workspace_id = ?").run(workspaceId);
      else
        this.db
          .prepare(
            `INSERT INTO workspace_web_search (workspace_id, is_enabled, updated_by, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (workspace_id) DO UPDATE SET
               is_enabled = excluded.is_enabled,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .run(workspaceId, next ? 1 : 0, actor, nowIso());
      new AuditLog(this.db).record({
        action: "workspace.web_search_set",
        actor,
        workspaceId,
        targetKind: "workspace_web_search",
        targetId: workspaceId,
        before: { enabled: before },
        after: { enabled: next },
      });
    })();
  }

  /**
   * Decision 12: frozen when attempt 1 starts and read back on every later start. A Gateway job
   * (a review, a summary, a probe) is `off`. On an installation without `SEARCH_URL` nothing is
   * recorded, so its run rows are unchanged; such a run is never offered the tool.
   */
  freeze(runs: Pick<RunStore, "setConfig">, run: RunRecord, workspaceId: WorkspaceId): boolean {
    if (run.config.webSearchVersion === 1) return run.config.webSearch === "on";
    const service = this.service();
    if (!service || run.attempt > 1 || run.status !== "queued") return false;
    const on = run.config.runType === undefined && this.effective(workspaceId);
    const frozen: FrozenWebSearch = {
      webSearch: on ? "on" : "off",
      webSearchVersion: 1,
      ...(on ? { webSearchEndpointSha256: service.endpointSha256 } : {}),
    };
    runs.setConfig(run.id, { ...frozen });
    return on;
  }
}

const stores = new WeakMap<GatewayDb, WebSearchSettings>();

/**
 * The switch for a Gateway context, built on first use rather than held on the context, whose
 * field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function webSearchSettings(ctx: Pick<GatewayContext, "db" | "config">): WebSearchSettings {
  let store = stores.get(ctx.db);
  if (!store) {
    const config = ctx.config;
    store = new WebSearchSettings(ctx.db, () => config.search);
    stores.set(ctx.db, store);
  }
  return store;
}

/** The run config with the frozen web-search stamp laid over it, for `sidecarToolsFor`. */
export function withWebSearch(
  ctx: Pick<GatewayContext, "db" | "config" | "runs">,
  run: RunRecord,
  workspaceId: WorkspaceId,
): Record<string, unknown> {
  const on = webSearchSettings(ctx).freeze(ctx.runs, run, workspaceId);
  return on ? { ...run.config, webSearch: "on" } : run.config;
}
