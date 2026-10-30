// A workspace operator's tool tier overrides (ADR-0002 amendment 3, A5): one row per tool whose
// tier the operator set, none by default. Every change is one `workspace.tool_tier_set` audit row
// in the same transaction, and a run freezes the overrides of its workspace at its first start.
// An override changes only the table's tier in the sidecar; the hard denies run before the tier.

import {
  DeskmatesError,
  type RiskLevel,
  type StartRunRequest,
  TOOL_TIER_OVERRIDE_EXCLUDED,
  TOOL_TIER_OVERRIDE_NAME,
  type ToolTierOverride,
  type WorkspaceId,
  decidedByHuman,
  isRiskLevel,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

interface Row {
  tool_name: string;
  risk_level: string;
  created_by: string;
  created_at: string;
}

export class ToolTierOverrides {
  constructor(private readonly db: GatewayDb) {}

  /** The workspace's overrides, by tool name; empty is the default. */
  list(workspaceId: WorkspaceId): ToolTierOverride[] {
    const rows = this.db
      .prepare(
        `SELECT tool_name, risk_level, created_by, created_at FROM workspace_tool_tiers
          WHERE workspace_id = ? ORDER BY tool_name`,
      )
      .all(workspaceId) as Row[];
    return rows.flatMap((row) =>
      isRiskLevel(row.risk_level)
        ? [
            {
              toolName: row.tool_name,
              riskLevel: row.risk_level,
              createdBy: row.created_by,
              createdAt: row.created_at,
            },
          ]
        : [],
    );
  }

  /** Tool name to tier, as a run's start request carries it. */
  tiers(workspaceId: WorkspaceId): Record<string, RiskLevel> {
    return Object.fromEntries(this.list(workspaceId).map((o) => [o.toolName, o.riskLevel]));
  }

  /**
   * Set one tool's tier. `actor` is the request's actor label (`user:<id>`, `web`), as the audit
   * row records it; the override records it as `human:<actor>`. Setting the current tier again
   * changes and records nothing.
   */
  set(
    workspaceId: WorkspaceId,
    toolName: string,
    riskLevel: unknown,
    actor: string,
  ): ToolTierOverride {
    checkToolName(toolName);
    if (!isRiskLevel(riskLevel))
      throw new DeskmatesError("validation", "riskLevel must be L0, L1 or L2", {
        field: "riskLevel",
      });
    return this.db.transaction(() => {
      const before = this.get(workspaceId, toolName);
      if (before?.riskLevel === riskLevel) return before;
      const createdAt = nowIso();
      const createdBy = decidedByHuman(actor);
      this.db
        .prepare(
          `INSERT INTO workspace_tool_tiers (workspace_id, tool_name, risk_level, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, tool_name) DO UPDATE SET
             risk_level = excluded.risk_level,
             created_by = excluded.created_by,
             created_at = excluded.created_at`,
        )
        .run(workspaceId, toolName, riskLevel, createdBy, createdAt);
      this.audit(workspaceId, toolName, actor, before?.riskLevel ?? null, riskLevel);
      return { toolName, riskLevel, createdBy, createdAt };
    })();
  }

  /** Remove one override, so the tool goes back to the table's tier. False when there was none. */
  remove(workspaceId: WorkspaceId, toolName: string, actor: string): boolean {
    return this.db.transaction(() => {
      const before = this.get(workspaceId, toolName);
      if (before === undefined) return false;
      this.db
        .prepare("DELETE FROM workspace_tool_tiers WHERE workspace_id = ? AND tool_name = ?")
        .run(workspaceId, toolName);
      this.audit(workspaceId, toolName, actor, before.riskLevel, null);
      return true;
    })();
  }

  private get(workspaceId: WorkspaceId, toolName: string): ToolTierOverride | undefined {
    return this.list(workspaceId).find((o) => o.toolName === toolName);
  }

  private audit(
    workspaceId: WorkspaceId,
    toolName: string,
    actor: string,
    before: RiskLevel | null,
    after: RiskLevel | null,
  ): void {
    new AuditLog(this.db).record({
      action: "workspace.tool_tier_set",
      actor,
      workspaceId,
      targetKind: "workspace",
      targetId: workspaceId,
      before: { toolName, riskLevel: before },
      after: { toolName, riskLevel: after },
    });
  }
}

function checkToolName(toolName: string): void {
  if (!TOOL_TIER_OVERRIDE_NAME.test(toolName))
    throw new DeskmatesError(
      "validation",
      "toolName must be the full tool name the SDK reports (letters, digits, _ . -; at most 200)",
      { field: "toolName" },
    );
  if (TOOL_TIER_OVERRIDE_EXCLUDED.includes(toolName))
    throw new DeskmatesError(
      "validation",
      `${toolName} is tiered by its own policy (ADR-0012, ADR-0013), not by the tier table`,
      { field: "toolName", reason: "tool_tier_not_overridable" },
    );
}

/** The overrides a run row recorded at its first start, or undefined when it recorded none. */
function recordedTiers(run: RunRecord): Record<string, RiskLevel> | undefined {
  const value = run.config.toolTierOverrides;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, RiskLevel] =>
      TOOL_TIER_OVERRIDE_NAME.test(entry[0]) && isRiskLevel(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The start request's tier overrides (A5), frozen like every knob of a run: the first start reads
 * the workspace's overrides and records them on the row only when there are some, so a run in a
 * workspace without overrides gets exactly the request and row it got before; every later process
 * of the run, a resume included, sends what the row recorded and nothing else.
 */
export function toolTierStart(
  db: GatewayDb,
  runs: Pick<RunStore, "setConfig">,
  run: RunRecord,
  workspaceId: WorkspaceId,
  options: { resume: boolean },
): Pick<StartRunRequest, "toolTierOverrides"> {
  const recorded = recordedTiers(run);
  if (recorded !== undefined) return { toolTierOverrides: recorded };
  if (options.resume) return {};
  const tiers = new ToolTierOverrides(db).tiers(workspaceId);
  if (Object.keys(tiers).length === 0) return {};
  runs.setConfig(run.id, { toolTierOverrides: tiers });
  return { toolTierOverrides: tiers };
}
