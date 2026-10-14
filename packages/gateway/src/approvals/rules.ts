// Stored approval rules, per bot (ADR-0002 amendment 2, A3). A rule answers an L2 call without
// asking anyone; the tier check has already run, so a rule can never widen L0/L1 handling.
// Matching itself lives in contracts (`approvalRuleMatches`), which the sidecar shares.

import {
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRule,
  type ApprovalRuleMatcher,
  type BotId,
  DeskmatesError,
  type IsoTimestamp,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface RuleRow {
  id: string;
  bot_id: string;
  matcher_json: string;
  decision: Exclude<ApprovalDecision, "allow_once">;
  created_from_approval_id: string | null;
  created_by: string | null;
  created_at: string | null;
}

export interface CreateRuleInput {
  botId: BotId;
  matcher: ApprovalRuleMatcher;
  decision: Exclude<ApprovalDecision, "allow_once">;
  /** `human:<authorId>` or `bot:<botId>`, as for `Approval.decidedBy`. */
  createdBy: string;
  createdFromApprovalId?: ApprovalId;
}

export class ApprovalRuleStore {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateRuleInput): ApprovalRule {
    return this.db.transaction(() => {
      const rule = this.insert(input);
      this.audit("approval_rule.create", rule, input.createdBy, undefined, ruleFacts(rule));
      return rule;
    })();
  }

  private audit(
    action: "approval_rule.create" | "approval_rule.delete",
    rule: ApprovalRule,
    actor: string,
    before: unknown,
    after: unknown,
  ): void {
    const row = this.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(rule.botId) as
      | { workspace_id: string }
      | undefined;
    if (!row) return;
    new AuditLog(this.db).record({
      action,
      actor,
      workspaceId: row.workspace_id,
      targetKind: "approval_rule",
      targetId: rule.id,
      before,
      after,
    });
  }

  private insert(input: CreateRuleInput): ApprovalRule {
    const id = newId("rul");
    this.db
      .prepare(
        `INSERT INTO approval_rules (id, workspace_id, bot_id, matcher_json, decision, created_from_approval_id, created_by, created_at)
         VALUES (?, (SELECT workspace_id FROM bots WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.botId,
        JSON.stringify(input.matcher),
        input.decision,
        input.createdFromApprovalId ?? null,
        input.createdBy,
        nowIso(),
      );
    return this.mustGet(id);
  }

  /** Oldest first: `findMatchingRule` takes the first match, so the earliest rule wins. */
  list(botId: BotId): ApprovalRule[] {
    const rows = this.db
      .prepare("SELECT * FROM approval_rules WHERE bot_id = ? ORDER BY created_at, id")
      .all(botId) as RuleRow[];
    return rows.map(toRule);
  }

  /** One page of a bot's rules by `created_at, id`, with the honest total (#113 slice B). */
  page(
    botId: BotId,
    page: { offset: number; limit: number },
  ): { rules: ApprovalRule[]; total: number } {
    const total = (
      this.db.prepare("SELECT count(*) AS n FROM approval_rules WHERE bot_id = ?").get(botId) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        "SELECT * FROM approval_rules WHERE bot_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?",
      )
      .all(botId, page.limit, page.offset) as RuleRow[];
    return { rules: rows.map(toRule), total };
  }

  get(id: string): ApprovalRule | undefined {
    const row = this.db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id) as
      | RuleRow
      | undefined;
    return row ? toRule(row) : undefined;
  }

  mustGet(id: string): ApprovalRule {
    const r = this.get(id);
    if (!r) throw new DeskmatesError("not_found", `approval rule ${id} not found`, { ruleId: id });
    return r;
  }

  delete(id: string, actor: string): boolean {
    return this.db.transaction(() => {
      const rule = this.get(id);
      if (!rule) return false;
      this.audit("approval_rule.delete", rule, actor, ruleFacts(rule), undefined);
      return this.db.prepare("DELETE FROM approval_rules WHERE id = ?").run(id).changes > 0;
    })();
  }
}

/** What the audit record keeps of a rule: who it answers for, how, and on what. */
function ruleFacts(rule: ApprovalRule): Record<string, unknown> {
  return { botId: rule.botId, decision: rule.decision, matcher: rule.matcher };
}

function toRule(row: RuleRow): ApprovalRule {
  const rule: ApprovalRule = {
    id: row.id,
    botId: row.bot_id as BotId,
    matcher: parseJson<ApprovalRuleMatcher>(row.matcher_json, {}),
    decision: row.decision,
    createdBy: row.created_by ?? "",
    createdAt: (row.created_at ?? "") as IsoTimestamp,
  };
  if (row.created_from_approval_id !== null) {
    rule.createdFromApprovalId = row.created_from_approval_id as ApprovalId;
  }
  return rule;
}
