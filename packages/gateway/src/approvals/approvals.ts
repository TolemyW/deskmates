// The `approvals` table: one row per L2 request the broker saw, pending or settled
// (ADR-0002 amendment 2, A1/A2). The row is the truth about a decision; the thread message and
// the ledger events are its echoes.

import {
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type BotId,
  DeskmatesError,
  type MessageId,
  type RiskLevel,
  type RunId,
  type ThreadId,
  type ToolAction,
  type WaitMode,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

/** The action name of a turn-continuation ask (ADR-0002 amendment 2). */
const CONTINUATION_TOOL_NAME = "__run_continuation__";

interface ApprovalRow {
  display_summary_json: string | null;
  kind: NonNullable<Approval["kind"]>;
  id: string;
  run_id: string;
  bot_id: string;
  thread_id: string | null;
  message_id: string | null;
  action_json: string;
  risk_level: RiskLevel;
  tool_use_id: string | null;
  instruction: string | null;
  decision: ApprovalDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  rule_id: string | null;
  wait_mode: WaitMode;
  created_at: string;
}

export interface CreateApprovalInput {
  /** `egress` for an ADR-0020 first-visit ask; absent for a tool call or a continuation. */
  kind?: "egress";
  /** The sidecar's id for the call; the broker is idempotent on it. */
  id: ApprovalId;
  runId: RunId;
  botId: BotId;
  threadId?: ThreadId;
  action: ToolAction;
  riskLevel: RiskLevel;
  toolUseId?: string;
  /** The message that woke the run. Never page content. */
  instruction?: string;
  /** Set only when a stored rule answered the request at creation time. */
  decision?: ApprovalDecision;
  decidedBy?: string;
  ruleId?: string;
}

export interface ListApprovalsFilter {
  status?: "pending" | "decided";
  threadId?: ThreadId;
  botId?: BotId;
}

export class ApprovalStore {
  constructor(private readonly db: GatewayDb) {}

  /** Commit an approval decision together with its run transition and thread echo. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  setDisplaySummary(id: ApprovalId, text: string, runId: RunId): Approval {
    this.db
      .prepare("UPDATE approvals SET display_summary_json = ? WHERE id = ?")
      .run(JSON.stringify({ text, runId }), id);
    return this.mustGet(id);
  }

  create(input: CreateApprovalInput): Approval {
    return this.db.transaction(() => {
      const created = this.insert(input);
      // A stored rule answered at creation time: that is a decision too.
      if (created.decision) this.auditDecision(created);
      return created;
    })();
  }

  private insert(input: CreateApprovalInput): Approval {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO approvals (id, workspace_id, run_id, bot_id, thread_id, message_id, action_json, risk_level,
           tool_use_id, instruction, decision, decided_by, decided_at, reason, rule_id, wait_mode, created_at, kind)
         VALUES (?, (SELECT workspace_id FROM runs WHERE id = ?), ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'live', ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.runId,
        input.botId,
        input.threadId ?? null,
        JSON.stringify(input.action),
        input.riskLevel,
        input.toolUseId ?? null,
        input.instruction ?? null,
        input.decision ?? null,
        input.decidedBy ?? null,
        input.decision ? ts : null,
        input.ruleId ?? null,
        ts,
        input.kind ?? (input.action.toolName === CONTINUATION_TOOL_NAME ? "continuation" : "tool"),
      );
    return this.mustGet(input.id);
  }

  get(id: ApprovalId): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? toApproval(row) : undefined;
  }

  mustGet(id: ApprovalId): Approval {
    const a = this.get(id);
    if (!a) throw new DeskmatesError("not_found", `approval ${id} not found`, { approvalId: id });
    return a;
  }

  list(filter: ListApprovalsFilter & { tenantId?: string } = {}): Approval[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.tenantId !== undefined) {
      clauses.push(
        "run_id IN (SELECT r.id FROM runs r JOIN bots b ON b.id = r.bot_id JOIN workspaces w ON w.id = b.workspace_id WHERE w.tenant_id = ?)",
      );
      params.push(filter.tenantId);
    }
    if (filter.status === "pending") clauses.push("decision IS NULL");
    if (filter.status === "decided") clauses.push("decision IS NOT NULL");
    if (filter.threadId) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.botId) {
      clauses.push("bot_id = ?");
      params.push(filter.botId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at, id`)
      .all(...params) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** The run's approvals nobody has decided yet, oldest first. */
  pendingForRun(runId: RunId): Approval[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE run_id = ? AND decision IS NULL ORDER BY created_at, id",
      )
      .all(runId) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** Records the decision. A second decision for the same approval is 409, never a silent win. */
  decide(id: ApprovalId, decision: ApprovalDecision, decidedBy: string, reason?: string): Approval {
    return this.db.transaction(() => {
      const current = this.mustGet(id);
      if (current.decision) {
        throw new DeskmatesError(
          "invalid_transition",
          `approval ${id} was already ${current.decision}`,
          { approvalId: id, decision: current.decision, decidedBy: current.decidedBy },
        );
      }
      this.db
        .prepare(
          "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?",
        )
        .run(decision, decidedBy, nowIso(), reason ?? null, id);
      const decided = this.mustGet(id);
      this.auditDecision(decided);
      return decided;
    })();
  }

  /** Every decision, a person's, a bot's or a stored rule's, is in the audit record. */
  private auditDecision(approval: Approval): void {
    const row = this.db
      .prepare("SELECT workspace_id FROM approvals WHERE id = ?")
      .get(approval.id) as { workspace_id: string } | undefined;
    if (!row || !approval.decision) return;
    new AuditLog(this.db).record({
      action: "approval.decide",
      actor: approval.decidedBy ?? "unknown",
      workspaceId: row.workspace_id,
      targetKind: "approval",
      targetId: approval.id,
      before: { decision: null },
      after: {
        decision: approval.decision,
        kind: approval.kind,
        toolName: approval.action.toolName,
        botId: approval.botId,
        ...(approval.reason ? { reason: approval.reason } : {}),
      },
      runId: approval.runId,
    });
  }

  setWaitMode(id: ApprovalId, waitMode: WaitMode): void {
    this.db.prepare("UPDATE approvals SET wait_mode = ? WHERE id = ?").run(waitMode, id);
  }

  setMessage(id: ApprovalId, messageId: MessageId): void {
    this.db.prepare("UPDATE approvals SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  setRule(id: ApprovalId, ruleId: string): void {
    this.db.prepare("UPDATE approvals SET rule_id = ? WHERE id = ?").run(ruleId, id);
  }
}

function toApproval(row: ApprovalRow): Approval {
  const a: Approval = {
    ...(row.display_summary_json
      ? {
          displaySummary: parseJson<{ text: string; runId: RunId }>(row.display_summary_json, {
            text: "",
            runId: "" as RunId,
          }),
        }
      : {}),
    id: row.id as ApprovalId,
    runId: row.run_id as RunId,
    botId: row.bot_id as BotId,
    action: parseJson<ToolAction>(row.action_json, { toolName: "", input: {} }),
    riskLevel: row.risk_level,
    waitMode: row.wait_mode,
    createdAt: row.created_at,
    kind: row.kind,
  };
  if (row.thread_id !== null) a.threadId = row.thread_id as ThreadId;
  if (row.message_id !== null) a.messageId = row.message_id as MessageId;
  if (row.tool_use_id !== null) a.toolUseId = row.tool_use_id;
  if (row.instruction !== null) a.instruction = row.instruction;
  if (row.decision !== null) a.decision = row.decision;
  if (row.decided_by !== null) a.decidedBy = row.decided_by;
  if (row.decided_at !== null) a.decidedAt = row.decided_at;
  if (row.reason !== null) a.reason = row.reason;
  return a;
}
