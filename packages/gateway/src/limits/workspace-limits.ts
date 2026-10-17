// Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): stored settings and
// switches, validation, the audit row and the resolution of effective values with their sources.
// The thread router reads the message caps per stored message; the run lifecycle freezes the turn
// cap and the continuation limit when a run first starts. Owner rulings of 2026-10-14: the turn
// budget is off by default, and `off` needs a money budget only under `requireBudgetForOff`.

import {
  DeskmatesError,
  type EffectiveLimit,
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  LOOP_BREAKER_REPEATS,
  TURN_BUDGET_DEFAULT,
  WORKSPACE_LIMIT_KEYS,
  WORKSPACE_LIMIT_RANGES,
  WORKSPACE_LIMIT_SWITCH_KEYS,
  type WorkspaceId,
  type WorkspaceLimitKey,
  type WorkspaceLimitSettings,
  type WorkspaceLimitSwitchKey,
  type WorkspaceLimitSwitches,
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

interface SwitchRow {
  switch_key: WorkspaceLimitSwitchKey;
  updated_by: string;
  updated_at: string;
}

/** The message caps of one thread, resolved when a bot message is stored (decision 38). */
export interface ThreadCaps {
  turnBudget: EffectiveLimit;
  relayCountMax: EffectiveLimit;
  /** Decision 40: whether the 300-message volume rule is armed (the `volumeBreaker` switch). */
  volumeBreaker: boolean;
}

/** The frozen run limits of ADR-0016 amendment 2, decision 16. */
export interface RunLimits {
  maxTurns: number | null;
  continuationLimit: number | null;
  continuationWindowHours: number;
  limitSources: Record<"maxTurns" | "continuationLimit" | "continuationWindowHours", string>;
  limitsVersion: 1;
}

interface Resolved {
  settings: WorkspaceLimitSettings;
  switches: WorkspaceLimitSwitches;
  backstop: boolean;
  effective: Record<WorkspaceLimitKey, EffectiveLimit>;
}

const isKey = (key: string): key is WorkspaceLimitKey =>
  (WORKSPACE_LIMIT_KEYS as readonly string[]).includes(key);
const isSwitch = (key: string): key is WorkspaceLimitSwitchKey =>
  (WORKSPACE_LIMIT_SWITCH_KEYS as readonly string[]).includes(key);

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

/** The audit shape: stored settings plus the switches that are on, so a default state is `{}`. */
function auditShape(
  settings: WorkspaceLimitSettings,
  switches: WorkspaceLimitSwitches,
): Record<string, unknown> {
  const on = Object.fromEntries(
    WORKSPACE_LIMIT_SWITCH_KEYS.filter((key) => switches[key]).map((key) => [key, true]),
  );
  return { ...settings, ...on };
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

  private switchRows(workspaceId: WorkspaceId): SwitchRow[] {
    return this.db
      .prepare(
        "SELECT switch_key, updated_by, updated_at FROM workspace_limit_switches WHERE workspace_id = ? ORDER BY switch_key",
      )
      .all(workspaceId) as SwitchRow[];
  }

  settings(workspaceId: WorkspaceId): WorkspaceLimitSettings {
    const settings: WorkspaceLimitSettings = {};
    for (const row of this.rows(workspaceId))
      settings[row.limit_key] = row.value === null ? "off" : row.value;
    return settings;
  }

  switches(workspaceId: WorkspaceId): WorkspaceLimitSwitches {
    const on = new Set(this.switchRows(workspaceId).map((row) => row.switch_key));
    return Object.fromEntries(
      WORKSPACE_LIMIT_SWITCH_KEYS.map((key) => [key, on.has(key)]),
    ) as WorkspaceLimitSwitches;
  }

  /** Whether a weekly or cumulative monetary limit is set (ADR-0032). */
  backstop(workspaceId: WorkspaceId): boolean {
    const limits = this.budget.limits(workspaceId);
    return limits.weeklyLimitUsd !== null || limits.cumulativeLimitUsd !== null;
  }

  /**
   * Set or clear settings and switches; keys left out keep their value, null clears a limit
   * (inherit) and false clears a switch. `off` is refused without a monetary backstop only while
   * `requireBudgetForOff` is on after this change (decision 39). One audit row per call that
   * changed something, in the same transaction.
   */
  set(workspaceId: WorkspaceId, input: Record<string, unknown>, actor: string): void {
    const changes = new Map<WorkspaceLimitKey, WorkspaceLimitValue | null>();
    const switchChanges = new Map<WorkspaceLimitSwitchKey, boolean>();
    for (const [key, value] of Object.entries(input)) {
      if (isSwitch(key)) {
        if (typeof value !== "boolean")
          throw new DeskmatesError("validation", `${key} must be true or false`, { [key]: value });
        switchChanges.set(key, value);
        continue;
      }
      if (!isKey(key)) throw new DeskmatesError("validation", `unknown limit ${key}`, { key });
      changes.set(key, validValue(key, value));
    }
    const before = this.settings(workspaceId);
    const beforeSwitches = this.switches(workspaceId);
    const afterSwitches: WorkspaceLimitSwitches = { ...beforeSwitches };
    for (const [key, value] of switchChanges) afterSwitches[key] = value;
    if (
      afterSwitches.requireBudgetForOff &&
      [...changes.values()].includes("off") &&
      !this.backstop(workspaceId)
    ) {
      throw new DeskmatesError(
        "validation",
        "this workspace requires a weekly or cumulative budget before a limit can be off",
      );
    }
    const after: WorkspaceLimitSettings = { ...before };
    for (const [key, value] of changes) {
      if (value === null) delete after[key];
      else after[key] = value;
    }
    const beforeAudit = auditShape(before, beforeSwitches);
    const afterAudit = auditShape(after, afterSwitches);
    if (JSON.stringify(beforeAudit) === JSON.stringify(afterAudit)) return;
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
      for (const [key, on] of switchChanges) {
        if (on === beforeSwitches[key]) continue;
        if (on)
          this.db
            .prepare(
              `INSERT INTO workspace_limit_switches (workspace_id, switch_key, updated_by, updated_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(workspaceId, key, actor, at);
        else
          this.db
            .prepare(
              "DELETE FROM workspace_limit_switches WHERE workspace_id = ? AND switch_key = ?",
            )
            .run(workspaceId, key);
      }
      new AuditLog(this.db).record({
        action: "workspace.limits_set",
        actor,
        workspaceId,
        targetKind: "workspace_limits",
        targetId: workspaceId,
        before: beforeAudit,
        after: afterAudit,
      });
    })();
  }

  private resolve(workspaceId: WorkspaceId): Resolved {
    const settings = this.settings(workspaceId);
    const switches = this.switches(workspaceId);
    const defaults = workspaceLimitDefaults(this.gatewayMaxTurns());
    const backstop = this.backstop(workspaceId);
    // Decision 39: an unlimited value stands unless the workspace requires a budget for it and
    // has none; then it resolves to a number (the turn budget's to the thread row's, below).
    const gated = switches.requireBudgetForOff && !backstop;
    const fallback = (key: WorkspaceLimitKey): EffectiveLimit => ({
      value: defaults[key] ?? TURN_BUDGET_DEFAULT,
      source: "default_no_backstop",
    });
    const one = (key: WorkspaceLimitKey): EffectiveLimit => {
      const stored = settings[key];
      if (stored === undefined) {
        if (defaults[key] === null && gated) return fallback(key);
        return { value: defaults[key], source: key === "maxTurns" ? "gateway" : "default" };
      }
      if (stored === "off") return gated ? fallback(key) : { value: null, source: "workspace" };
      return { value: stored, source: "workspace" };
    };
    const effective = Object.fromEntries(
      WORKSPACE_LIMIT_KEYS.map((key) => [key, one(key)]),
    ) as Record<WorkspaceLimitKey, EffectiveLimit>;
    return { settings, switches, backstop, effective };
  }

  /** Every effective workspace-level value with its source. */
  effective(workspaceId: WorkspaceId): Record<WorkspaceLimitKey, EffectiveLimit> {
    return this.resolve(workspaceId).effective;
  }

  /**
   * Decision 38: the workspace setting, else off. Under decision 39's gate the turn budget falls
   * back to the thread row's own value.
   */
  threadCaps(workspaceId: WorkspaceId, threadTurnBudget: number): ThreadCaps {
    const { effective, switches } = this.resolve(workspaceId);
    const turnBudget: EffectiveLimit =
      effective.turnBudget.source === "default_no_backstop"
        ? { value: threadTurnBudget, source: "default_no_backstop" }
        : effective.turnBudget;
    return {
      turnBudget,
      relayCountMax: effective.relayCountMax,
      volumeBreaker: switches.volumeBreaker,
    };
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
        workspaceLimitDefaults(this.gatewayMaxTurns()).continuationWindowHours ??
        24,
      limitSources: {
        maxTurns: effective.maxTurns.source,
        continuationLimit: effective.continuationLimit.source,
        continuationWindowHours: effective.continuationWindowHours.source,
      },
      limitsVersion: 1,
    };
  }

  view(workspaceId: WorkspaceId): WorkspaceLimitsView {
    const { settings, switches, backstop, effective } = this.resolve(workspaceId);
    const stamps = [...this.rows(workspaceId), ...this.switchRows(workspaceId)];
    const latest = stamps.reduce<(typeof stamps)[number] | undefined>(
      (last, row) => (!last || row.updated_at > last.updated_at ? row : last),
      undefined,
    );
    return {
      workspaceId,
      settings,
      switches,
      effective,
      defaults: { ...workspaceLimitDefaults(this.gatewayMaxTurns()) },
      ranges: { ...WORKSPACE_LIMIT_RANGES },
      loopBreaker: {
        relayMax: LOOP_BREAKER_RELAY_MAX,
        botMessages: LOOP_BREAKER_BOT_MESSAGES,
        repeats: LOOP_BREAKER_REPEATS,
      },
      budgetBackstop: backstop,
      ...(latest ? { updatedAt: latest.updated_at, updatedBy: latest.updated_by } : {}),
    };
  }
}
