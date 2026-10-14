// Cost alert rules and firings (ADR-0018). A rule is a soft threshold: evaluation runs when a
// run's usage is recorded, reads the window through the same query the cost report uses, and
// fires at most once per (rule, window). Nothing here touches scheduling.

import {
  type BotId,
  type CostAlert,
  type CostAlertEventPayload,
  type CostAlertKind,
  type CostAlertRule,
  type CostAlertWindow,
  type CostTotals,
  type CreateCostAlertRuleInput,
  DeskmatesError,
  type RunId,
  type WorkspaceId,
  costAlertRuleSatisfied,
  costAlertWindowKey,
  costAlertWindowRange,
  isCostAlertKind,
  isCostAlertWindow,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { CostQueryStore } from "./costs.js";
import type { EventStore } from "./events.js";

interface RuleRow {
  id: string;
  workspace_id: string;
  kind: CostAlertKind;
  window_kind: CostAlertWindow;
  bot_id: string | null;
  threshold_usd: number | null;
  created_by: string;
  created_at: string;
}

interface AlertRow {
  id: string;
  rule_id: string;
  kind: CostAlertKind;
  window_kind: CostAlertWindow;
  window_key: string;
  bot_id: string | null;
  threshold_usd: number | null;
  run_id: string;
  run_count: number;
  usage_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  priced_usage_count: number;
  unpriced_usage_count: number;
  known_cost_usd: number | null;
  fired_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export type CostAlertStatus = "open" | "acknowledged" | "all";

const OF_TENANT = "SELECT id FROM workspaces WHERE tenant_id = ?";
/** The caller's readable workspaces, or every one when the first parameter is null. */
const READABLE = "(? IS NULL OR workspace_id IN (SELECT value FROM json_each(?)))";

function readableParams(readable: ReadonlySet<string> | undefined): (string | null)[] {
  const ids = readable === undefined ? null : JSON.stringify([...readable]);
  return [ids, ids];
}

function statusWhere(status: CostAlertStatus): string {
  return status === "open"
    ? "AND acknowledged_at IS NULL"
    : status === "acknowledged"
      ? "AND acknowledged_at IS NOT NULL"
      : "";
}

export class CostAlertStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly costs: CostQueryStore,
    private readonly events: EventStore,
  ) {}

  /**
   * Every method is scoped to one tenant (ADR-0022 P2) through the workspace a rule or alert
   * belongs to (ADR-0031 Q3); another tenant's row is not found.
   */
  listRules(tenantId: string): CostAlertRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cost_alert_rules WHERE workspace_id IN (${OF_TENANT}) ORDER BY created_at, id`,
      )
      .all(tenantId) as RuleRow[];
    return rows.map(toRule);
  }

  /**
   * One page of rules, oldest first (`created_at, id`), of the readable workspaces only (all when
   * `readable` is undefined), with the total under the same scope (#113). Indexed by
   * `cost_alert_rules_workspace (workspace_id, created_at, id)`.
   */
  rulePage(
    tenantId: string,
    readable: ReadonlySet<string> | undefined,
    offset: number,
    limit: number,
  ): { rules: CostAlertRule[]; total: number } {
    const where = `workspace_id IN (${OF_TENANT}) AND ${READABLE}`;
    const scope = [tenantId, ...readableParams(readable)];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM cost_alert_rules WHERE ${where}`)
      .get(...scope) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM cost_alert_rules WHERE ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(...scope, limit, offset) as RuleRow[];
    return { rules: rows.map(toRule), total };
  }

  getRule(tenantId: string, id: string): CostAlertRule | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cost_alert_rules WHERE id = ? AND workspace_id IN (${OF_TENANT})`)
      .get(id, tenantId) as RuleRow | undefined;
    return row ? toRule(row) : undefined;
  }

  /**
   * The workspace a new rule covers: its bot's, the one named, or the tenant's only active
   * workspace. Several workspaces and no choice is refused, never guessed (ADR-0031 Q3).
   */
  private ruleWorkspace(tenantId: string, input: CreateCostAlertRuleInput): string {
    if (input.botId) {
      const bot = this.db
        .prepare(`SELECT workspace_id FROM bots WHERE id = ? AND workspace_id IN (${OF_TENANT})`)
        .get(input.botId, tenantId) as { workspace_id: string } | undefined;
      if (!bot)
        throw new DeskmatesError("not_found", `bot ${input.botId} not found`, {
          botId: input.botId,
        });
      if (input.workspaceId && input.workspaceId !== bot.workspace_id)
        throw new DeskmatesError("validation", "the bot belongs to another workspace", {
          botId: input.botId,
          workspaceId: input.workspaceId,
        });
      return bot.workspace_id;
    }
    if (input.workspaceId) {
      const ws = this.db
        .prepare("SELECT id FROM workspaces WHERE id = ? AND tenant_id = ?")
        .get(input.workspaceId, tenantId) as { id: string } | undefined;
      if (!ws)
        throw new DeskmatesError("not_found", `workspace ${input.workspaceId} not found`, {
          workspaceId: input.workspaceId,
        });
      return ws.id;
    }
    const active = this.db
      .prepare("SELECT id FROM workspaces WHERE tenant_id = ? AND archived_at IS NULL")
      .all(tenantId) as Array<{ id: string }>;
    if (active.length !== 1 || !active[0])
      throw new DeskmatesError(
        "validation",
        "workspaceId is required for a rule that covers every bot of a workspace",
      );
    return active[0].id;
  }

  /**
   * Validates the rule shape (ADR-0018 decision 1): a `known_cost` rule needs a positive finite
   * threshold, an `unpriced_usage` rule must not carry one.
   */
  createRule(tenantId: string, input: CreateCostAlertRuleInput): CostAlertRule {
    return this.db.transaction(() => this.insertRule(tenantId, input))();
  }

  private insertRule(tenantId: string, input: CreateCostAlertRuleInput): CostAlertRule {
    if (!isCostAlertKind(input.kind)) {
      throw new DeskmatesError("validation", "kind must be known_cost or unpriced_usage", {
        kind: input.kind,
      });
    }
    if (!isCostAlertWindow(input.window)) {
      throw new DeskmatesError("validation", "window must be day or month", {
        window: input.window,
      });
    }
    if (input.kind === "known_cost") {
      const t = input.thresholdUsd;
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        throw new DeskmatesError("validation", "thresholdUsd must be a positive number", {
          thresholdUsd: t,
        });
      }
    } else if (input.thresholdUsd !== undefined) {
      throw new DeskmatesError("validation", "an unpriced_usage rule takes no thresholdUsd");
    }
    const workspaceId = this.ruleWorkspace(tenantId, input);
    const id = newId("car");
    this.db
      .prepare(
        `INSERT INTO cost_alert_rules (id, workspace_id, kind, window_kind, bot_id, threshold_usd, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.kind,
        input.window,
        input.botId ?? null,
        input.kind === "known_cost" ? input.thresholdUsd : null,
        input.createdBy,
        nowIso(),
      );
    const rule = toRule(
      this.db.prepare("SELECT * FROM cost_alert_rules WHERE id = ?").get(id) as RuleRow,
    );
    new AuditLog(this.db).record({
      action: "cost_rule.create",
      actor: input.createdBy,
      workspaceId,
      targetKind: "cost_alert_rule",
      targetId: id,
      after: ruleFacts(rule),
    });
    return rule;
  }

  /** Deleting a rule keeps the alerts it fired; they copy its facts (ADR-0018). */
  deleteRule(tenantId: string, id: string, actor: string): boolean {
    return this.db.transaction(() => {
      const rule = this.getRule(tenantId, id);
      if (!rule?.workspaceId) return false;
      new AuditLog(this.db).record({
        action: "cost_rule.delete",
        actor,
        workspaceId: rule.workspaceId,
        targetKind: "cost_alert_rule",
        targetId: id,
        before: ruleFacts(rule),
      });
      return this.db.prepare("DELETE FROM cost_alert_rules WHERE id = ?").run(id).changes > 0;
    })();
  }

  listAlerts(tenantId: string, status: CostAlertStatus = "open"): CostAlert[] {
    const where = statusWhere(status);
    const rows = this.db
      .prepare(
        `SELECT * FROM cost_alerts WHERE workspace_id IN (${OF_TENANT}) ${where} ORDER BY fired_at DESC, id`,
      )
      .all(tenantId) as AlertRow[];
    return rows.map(toAlert);
  }

  /**
   * Alerts after the keyset `after` (`[fired_at, id]`), newest first (`fired_at DESC, id DESC`),
   * of the readable workspaces only, at most `limit + 1` so the caller can tell whether more
   * follow, and the total under the same status and scope (#113). Indexed by
   * `cost_alerts_workspace (workspace_id, acknowledged_at, fired_at, id)`.
   */
  alertPage(
    tenantId: string,
    status: CostAlertStatus,
    readable: ReadonlySet<string> | undefined,
    limit: number,
    after?: readonly [string, string],
  ): { alerts: CostAlert[]; total: number } {
    const where = `workspace_id IN (${OF_TENANT}) AND ${READABLE} ${statusWhere(status)}`;
    const scope = [tenantId, ...readableParams(readable)];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM cost_alerts WHERE ${where}`)
      .get(...scope) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM cost_alerts WHERE ${where}
           ${after ? "AND (fired_at < ? OR (fired_at = ? AND id < ?))" : ""}
         ORDER BY fired_at DESC, id DESC LIMIT ?`,
      )
      .all(...scope, ...(after ? [after[0], after[0], after[1]] : []), limit + 1) as AlertRow[];
    return { alerts: rows.map(toAlert), total };
  }

  getAlert(tenantId: string, id: string): CostAlert | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cost_alerts WHERE id = ? AND workspace_id IN (${OF_TENANT})`)
      .get(id, tenantId) as AlertRow | undefined;
    return row ? toAlert(row) : undefined;
  }

  mustGetAlert(tenantId: string, id: string): CostAlert {
    const alert = this.getAlert(tenantId, id);
    if (!alert)
      throw new DeskmatesError("not_found", `cost alert ${id} not found`, { alertId: id });
    return alert;
  }

  /** Bookkeeping only (ADR-0018 decision 4): the window stays fired. Idempotent. */
  acknowledge(tenantId: string, id: string, by: string): CostAlert {
    const current = this.mustGetAlert(tenantId, id);
    if (current.acknowledgedAt) return current;
    this.db
      .prepare(
        `UPDATE cost_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND workspace_id IN (${OF_TENANT})`,
      )
      .run(nowIso(), by, id, tenantId);
    return this.mustGetAlert(tenantId, id);
  }

  /**
   * Evaluate every rule whose scope covers `botId` against the windows that contain `at`, the
   * run's creation time, which is the day the cost report files its usage under; a run that ends
   * after midnight UTC is still counted on the day it started (ADR-0018 decisions 2 and 3). Fires
   * the rules that are satisfied and have not fired in that window yet, each with a `cost_alert`
   * event on `runId`. Returns the alerts fired by this call.
   */
  evaluate(runId: RunId, botId: BotId, at: Date): CostAlert[] {
    const now = at;
    // An every-bot rule covers the bots of its own workspace only (ADR-0031 Q3).
    const scope = this.db
      .prepare(
        "SELECT w.tenant_id, w.id AS workspace_id FROM bots b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id = ?",
      )
      .get(botId) as { tenant_id: string; workspace_id: string } | undefined;
    if (!scope) return [];
    const tenantId = scope.tenant_id;
    const rules = this.db
      .prepare(
        "SELECT * FROM cost_alert_rules WHERE workspace_id = ? AND (bot_id IS NULL OR bot_id = ?) ORDER BY created_at, id",
      )
      .all(scope.workspace_id, botId)
      .map((row) => toRule(row as RuleRow));
    const fired: CostAlert[] = [];
    for (const rule of rules) {
      const windowKey = costAlertWindowKey(rule.window, now);
      const already = this.db
        .prepare("SELECT 1 FROM cost_alerts WHERE rule_id = ? AND window_key = ?")
        .get(rule.id, windowKey);
      if (already) continue;
      const range = costAlertWindowRange(rule.window, now);
      const totals = this.costs.report(tenantId, {
        from: range.from,
        to: range.to,
        workspaceId: scope.workspace_id as WorkspaceId,
        ...(rule.botId ? { botId: rule.botId } : {}),
      }).totals;
      if (!costAlertRuleSatisfied(rule, totals)) continue;
      fired.push(this.fire(tenantId, scope.workspace_id, rule, windowKey, runId, totals));
    }
    return fired;
  }

  private fire(
    tenantId: string,
    workspaceId: string,
    rule: CostAlertRule,
    windowKey: string,
    runId: RunId,
    totals: CostTotals,
  ): CostAlert {
    const id = newId("cal");
    this.db
      .prepare(
        `INSERT INTO cost_alerts (id, workspace_id, rule_id, kind, window_kind, window_key, bot_id, threshold_usd, run_id,
           run_count, usage_count, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
           priced_usage_count, unpriced_usage_count, known_cost_usd, fired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        rule.id,
        rule.kind,
        rule.window,
        windowKey,
        rule.botId ?? null,
        rule.thresholdUsd ?? null,
        runId,
        totals.runCount,
        totals.usageCount,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheReadTokens,
        totals.cacheCreateTokens,
        totals.pricedUsageCount,
        totals.unpricedUsageCount,
        totals.knownCostUsd,
        nowIso(),
      );
    const alert = this.mustGetAlert(tenantId, id);
    const payload: CostAlertEventPayload = {
      alertId: alert.id,
      ruleId: rule.id,
      kind: rule.kind,
      window: rule.window,
      windowKey,
      botId: rule.botId ?? null,
      thresholdUsd: rule.thresholdUsd ?? null,
      knownCostUsd: totals.knownCostUsd,
      unpricedUsageCount: totals.unpricedUsageCount,
      runCount: totals.runCount,
      usageCount: totals.usageCount,
    };
    this.events.append({ runId, kind: "cost_alert", payload: { ...payload } });
    return alert;
  }
}

function ruleFacts(rule: CostAlertRule): Record<string, unknown> {
  return {
    kind: rule.kind,
    window: rule.window,
    botId: rule.botId ?? null,
    thresholdUsd: rule.thresholdUsd ?? null,
  };
}

function toRule(row: RuleRow): CostAlertRule {
  return {
    id: row.id,
    kind: row.kind,
    window: row.window_kind,
    workspaceId: row.workspace_id as WorkspaceId,
    ...(row.bot_id !== null ? { botId: row.bot_id as BotId } : {}),
    ...(row.threshold_usd !== null ? { thresholdUsd: row.threshold_usd } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toAlert(row: AlertRow): CostAlert {
  const priced = row.priced_usage_count;
  const unpriced = row.unpriced_usage_count;
  const totals: CostTotals = {
    runCount: row.run_count,
    usageCount: row.usage_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreateTokens: row.cache_create_tokens,
    pricedUsageCount: priced,
    unpricedUsageCount: unpriced,
    knownCostUsd: row.known_cost_usd,
    costStatus: priced === 0 ? "unpriced" : unpriced === 0 ? "priced" : "partial",
  };
  return {
    id: row.id,
    ruleId: row.rule_id,
    kind: row.kind,
    window: row.window_kind,
    windowKey: row.window_key,
    ...(row.bot_id !== null ? { botId: row.bot_id as BotId } : {}),
    ...(row.threshold_usd !== null ? { thresholdUsd: row.threshold_usd } : {}),
    runId: row.run_id as RunId,
    totals,
    firedAt: row.fired_at,
    ...(row.acknowledged_at !== null ? { acknowledgedAt: row.acknowledged_at } : {}),
    ...(row.acknowledged_by !== null ? { acknowledgedBy: row.acknowledged_by } : {}),
  };
}
