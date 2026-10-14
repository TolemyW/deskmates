// Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): stored settings,
// validation, the audit row and the resolution of effective values with their sources. The
// thread router reads the message caps per stored message; the run lifecycle freezes the turn
// cap and the continuation limit when a run first starts.

import {
  DeskmatesError,
  type EffectiveLimit,
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  LOOP_BREAKER_REPEATS,
  RELAY_COUNT_MAX,
  TURN_BUDGET_DEFAULT,
  WORKSPACE_LIMIT_KEYS,
  WORKSPACE_LIMIT_RANGES,
  type WorkspaceId,
  type WorkspaceLimitKey,
  type WorkspaceLimitSettings,
  type WorkspaceLimitValue,
  type WorkspaceLimitsView,
  workspaceLimitDefaults,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { BudgetStore } from "../budget/budget-store.js";
import type { GatewayDb } from "../db/open.js";

interface LimitRow {
  limit_key: WorkspaceLimitKey;
  value: number | null;
  updated_by: string;
  updated_at: string;
}

/** The message caps of one thread, resolved when a bot message is stored (decision 38). */
export interface ThreadCaps {
  turnBudget: EffectiveLimit;
  relayCountMax: EffectiveLimit;
  /** Decision 40: repetition is armed only when a cap is off or above its default. */
  relaxed: boolean;
}

/** The frozen run limits of ADR-0016 amendment 2, decision 16. */
export interface RunLimits {
  maxTurns: number | null;
  continuationLimit: number | null;
  continuationWindowHours: number;
  limitSources: Record<"maxTurns" | "continuationLimit" | "continuationWindowHours", string>;
  limitsVersion: 1;
}

const isKey = (key: string): key is WorkspaceLimitKey =>
  (WORKSPACE_LIMIT_KEYS as readonly string[]).includes(key);

function validValue(key: WorkspaceLimitKey, value: unknown): WorkspaceLimitValue | null {
  if (value === null) return null;
  const range = WORKSPACE_LIMIT_RANGES[key];
  if (value === "off") {
    if (!range.off)
      throw new DeskmatesError("validation", `${key} cannot be off`, { [key]: value });
    return "off";
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new DeskmatesError(
      "validation",
      `${key} must be an integer from ${range.min} to ${range.max}${range.off ? ", off" : ""} or null`,
      { [key]: value },
    );
  }
  return value;
}

export class WorkspaceLimitStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly budget: Pick<BudgetStore, "limits">,
    /** Read on every call: the Gateway config may change after the store is built. */
    private readonly gatewayMaxTurns: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private rows(workspaceId: WorkspaceId): LimitRow[] {
    return this.db
      .prepare("SELECT * FROM workspace_limits WHERE workspace_id = ? ORDER BY limit_key")
      .all(workspaceId) as LimitRow[];
  }

  settings(workspaceId: WorkspaceId): WorkspaceLimitSettings {
    const settings: WorkspaceLimitSettings = {};
    for (const row of this.rows(workspaceId))
      settings[row.limit_key] = row.value === null ? "off" : row.value;
    return settings;
  }

  /** Whether a weekly or cumulative monetary limit is set (ADR-0032), which `off` needs. */
  backstop(workspaceId: WorkspaceId): boolean {
    const limits = this.budget.limits(workspaceId);
    return limits.weeklyLimitUsd !== null || limits.cumulativeLimitUsd !== null;
  }

  /**
   * Set or clear settings; keys left out keep their value, null clears (inherit). `off` is
   * refused without a monetary backstop (decision 39). One audit row per call that changed
   * something, in the same transaction.
   */
  set(workspaceId: WorkspaceId, input: Record<string, unknown>, actor: string): void {
    const changes = new Map<WorkspaceLimitKey, WorkspaceLimitValue | null>();
    for (const [key, value] of Object.entries(input)) {
      if (!isKey(key)) throw new DeskmatesError("validation", `unknown limit ${key}`, { key });
      changes.set(key, validValue(key, value));
    }
    if ([...changes.values()].includes("off") && !this.backstop(workspaceId)) {
      throw new DeskmatesError(
        "validation",
        "a limit can be off only while the workspace has a weekly or cumulative budget",
      );
    }
    const before = this.settings(workspaceId);
    const after: WorkspaceLimitSettings = { ...before };
    for (const [key, value] of changes) {
      if (value === null) delete after[key];
      else after[key] = value;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const at = this.now().toISOString();
    this.db.transaction(() => {
      for (const [key, value] of changes) {
        if (value === null) {
          this.db
            .prepare("DELETE FROM workspace_limits WHERE workspace_id = ? AND limit_key = ?")
            .run(workspaceId, key);
        } else {
          this.db
            .prepare(
              `INSERT INTO workspace_limits (workspace_id, limit_key, value, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (workspace_id, limit_key) DO UPDATE SET value = excluded.value,
                 updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            )
            .run(workspaceId, key, value === "off" ? null : value, actor, at);
        }
      }
      new AuditLog(this.db).record({
        action: "workspace.limits_set",
        actor,
        workspaceId,
        targetKind: "workspace_limits",
        targetId: workspaceId,
        before,
        after,
      });
    })();
  }

  /** Every effective workspace-level value with its source. */
  effective(workspaceId: WorkspaceId): Record<WorkspaceLimitKey, EffectiveLimit> {
    const settings = this.settings(workspaceId);
    const defaults = workspaceLimitDefaults(this.gatewayMaxTurns());
    const backstop = this.backstop(workspaceId);
    const resolve = (key: WorkspaceLimitKey): EffectiveLimit => {
      const stored = settings[key];
      if (stored === undefined)
        return { value: defaults[key], source: key === "maxTurns" ? "gateway" : "default" };
      if (stored === "off")
        return backstop
          ? { value: null, source: "workspace" }
          : { value: defaults[key], source: "default_no_backstop" };
      return { value: stored, source: "workspace" };
    };
    return Object.fromEntries(WORKSPACE_LIMIT_KEYS.map((key) => [key, resolve(key)])) as Record<
      WorkspaceLimitKey,
      EffectiveLimit
    >;
  }

  /** Decision 38: the workspace setting wins; without one the thread row's budget applies. */
  threadCaps(workspaceId: WorkspaceId, threadTurnBudget: number): ThreadCaps {
    const effective = this.effective(workspaceId);
    const turnBudget: EffectiveLimit =
      effective.turnBudget.source === "default"
        ? { value: threadTurnBudget, source: "thread" }
        : effective.turnBudget;
    const relayCountMax = effective.relayCountMax;
    const relaxed =
      turnBudget.value === null ||
      turnBudget.value > TURN_BUDGET_DEFAULT ||
      relayCountMax.value === null ||
      relayCountMax.value > RELAY_COUNT_MAX;
    return { turnBudget, relayCountMax, relaxed };
  }

  /** The chain-depth cap a message is checked against, `off` falling back to the breaker. */
  relayLimit(workspaceId: WorkspaceId): number {
    return this.effective(workspaceId).relayCountMax.value ?? LOOP_BREAKER_RELAY_MAX;
  }

  /** ADR-0016 amendment 2, decision 16: what a run freezes at its first start. */
  runLimits(workspaceId: WorkspaceId): RunLimits {
    const effective = this.effective(workspaceId);
    return {
      maxTurns: effective.maxTurns.value,
      continuationLimit: effective.continuationLimit.value,
      continuationWindowHours:
        effective.continuationWindowHours.value ??
        workspaceLimitDefaults(this.gatewayMaxTurns()).continuationWindowHours,
      limitSources: {
        maxTurns: effective.maxTurns.source,
        continuationLimit: effective.continuationLimit.source,
        continuationWindowHours: effective.continuationWindowHours.source,
      },
      limitsVersion: 1,
    };
  }

  view(workspaceId: WorkspaceId): WorkspaceLimitsView {
    const rows = this.rows(workspaceId);
    const latest = rows.reduce<LimitRow | undefined>(
      (last, row) => (!last || row.updated_at > last.updated_at ? row : last),
      undefined,
    );
    return {
      workspaceId,
      settings: this.settings(workspaceId),
      effective: this.effective(workspaceId),
      defaults: { ...workspaceLimitDefaults(this.gatewayMaxTurns()) },
      ranges: { ...WORKSPACE_LIMIT_RANGES },
      loopBreaker: {
        relayMax: LOOP_BREAKER_RELAY_MAX,
        botMessages: LOOP_BREAKER_BOT_MESSAGES,
        repeats: LOOP_BREAKER_REPEATS,
      },
      budgetBackstop: this.backstop(workspaceId),
      ...(latest ? { updatedAt: latest.updated_at, updatedBy: latest.updated_by } : {}),
    };
  }
}
