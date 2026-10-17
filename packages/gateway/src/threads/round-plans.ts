// The plan of a triaged round (ADR-0005 amendment 6, proposed): its phase, the triage job, the
// assigned members with their tasks, the closer and the closer's one wake. Written and read by the
// router under `round-v1` only; the round rows of amendment 4 stay presentation records.

import {
  type BotId,
  type MessageId,
  type RoundPlan,
  type RoundPlanPhase,
  type RunId,
  type RunStatus,
  type ThreadId,
  isTerminal,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface PlanRow {
  message_id: string;
  phase: RoundPlanPhase;
  triage_run_id: string | null;
  closer_bot_id: string | null;
  closer_run_id: string | null;
  reason: string | null;
}

export interface StoredPlan {
  messageId: MessageId;
  phase: RoundPlanPhase;
  triageRunId?: RunId;
  closerBotId?: BotId;
  closerRunId?: RunId;
  reason?: string;
  assignments: { botId: BotId; task: string }[];
}

/** An assigned member's latest run related to the round, if it has one. */
export interface AssignedRun {
  botId: BotId;
  runId?: RunId;
  status?: RunStatus;
}

/** Phases whose plan assigned work: their messages count once toward the turn budget. */
const DISPATCHED = "('working', 'closing', 'closed')";

export class RoundPlanStore {
  constructor(private readonly db: GatewayDb) {}

  /** Decision 44: the plan is opened with its round, in the transaction that stores the message. */
  open(messageId: MessageId): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_round_plans (message_id, phase, created_at, updated_at)
         VALUES (?, 'triage', ?, ?)`,
      )
      .run(messageId, now, now);
  }

  get(messageId: MessageId): StoredPlan | undefined {
    const row = this.db
      .prepare("SELECT * FROM thread_round_plans WHERE message_id = ?")
      .get(messageId) as PlanRow | undefined;
    return row ? this.stored(row) : undefined;
  }

  /** The plan whose triage job, or whose closer wake, this run is. */
  byRun(runId: RunId): { plan: StoredPlan; as: "triage" | "closer" } | undefined {
    const triage = this.db
      .prepare("SELECT * FROM thread_round_plans WHERE triage_run_id = ?")
      .get(runId) as PlanRow | undefined;
    if (triage) return { plan: this.stored(triage), as: "triage" };
    const closer = this.db
      .prepare("SELECT * FROM thread_round_plans WHERE closer_run_id = ?")
      .get(runId) as PlanRow | undefined;
    return closer ? { plan: this.stored(closer), as: "closer" } : undefined;
  }

  /** Plans in the working phase that this run serves as an assigned member's run. */
  workingForRun(runId: RunId): StoredPlan[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM thread_round_plans p
         WHERE p.phase = 'working' AND p.message_id IN
           (SELECT message_id FROM thread_round_runs WHERE run_id = ?)`,
      )
      .all(runId) as PlanRow[];
    return rows.map((row) => this.stored(row));
  }

  /**
   * The plan a wake is told about (decisions 47, 48): the round it closes, else the newest
   * dispatched round it works on.
   */
  forDelivery(runId: RunId): { plan: StoredPlan; phase: "work" | "close" } | undefined {
    const closing = this.db
      .prepare("SELECT * FROM thread_round_plans WHERE closer_run_id = ? AND phase = 'closing'")
      .get(runId) as PlanRow | undefined;
    if (closing) return { plan: this.stored(closing), phase: "close" };
    const working = this.db
      .prepare(
        `SELECT p.* FROM thread_round_plans p
           JOIN thread_messages m ON m.id = p.message_id
         WHERE p.phase IN ('working', 'closing') AND p.message_id IN
           (SELECT message_id FROM thread_round_runs WHERE run_id = ?)
         ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(runId) as PlanRow | undefined;
    return working ? { plan: this.stored(working), phase: "work" } : undefined;
  }

  setTriageRun(messageId: MessageId, runId: RunId): void {
    this.db
      .prepare(
        "UPDATE thread_round_plans SET triage_run_id = ?, updated_at = ? WHERE message_id = ?",
      )
      .run(runId, nowIso(), messageId);
  }

  /** Decision 45: the validated answer of the triage job, replacing any earlier one. */
  storeAssignments(
    messageId: MessageId,
    assignments: readonly { botId: BotId; task: string }[],
    closerBotId: BotId,
  ): void {
    this.db.prepare("DELETE FROM thread_round_assignments WHERE message_id = ?").run(messageId);
    const insert = this.db.prepare(
      "INSERT INTO thread_round_assignments (message_id, bot_id, ordinal, task) VALUES (?, ?, ?, ?)",
    );
    assignments.forEach((a, ordinal) => insert.run(messageId, a.botId, ordinal, a.task));
    this.db
      .prepare(
        "UPDATE thread_round_plans SET closer_bot_id = ?, updated_at = ? WHERE message_id = ?",
      )
      .run(closerBotId, nowIso(), messageId);
  }

  setPhase(
    messageId: MessageId,
    phase: RoundPlanPhase,
    patch: { reason?: string; closerRunId?: RunId } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE thread_round_plans SET phase = ?, updated_at = ?,
           reason = coalesce(?, reason), closer_run_id = coalesce(?, closer_run_id)
         WHERE message_id = ?`,
      )
      .run(phase, nowIso(), patch.reason ?? null, patch.closerRunId ?? null, messageId);
  }

  /** Decision 48: each assigned member's latest related run, the closer check's input. */
  assignedRuns(plan: StoredPlan): AssignedRun[] {
    const latest = this.db.prepare(
      `SELECT rr.run_id, runs.status FROM thread_round_runs rr JOIN runs ON runs.id = rr.run_id
       WHERE rr.message_id = ? AND rr.bot_id = ? ORDER BY rr.created_at DESC, rr.rowid DESC
       LIMIT 1`,
    );
    return plan.assignments.map(({ botId }) => {
      const row = latest.get(plan.messageId, botId) as
        | { run_id: string; status: RunStatus }
        | undefined;
      return row ? { botId, runId: row.run_id as RunId, status: row.status } : { botId };
    });
  }

  /** Whether every assigned member has a related run and each one's latest is terminal. */
  allAssignedEnded(plan: StoredPlan): boolean {
    return this.assignedRuns(plan).every((a) => a.status !== undefined && isTerminal(a.status));
  }

  /**
   * Decision 49: bot messages since the latest human message, where every message posted by the
   * runs of one dispatched round (its related runs and its closer run) counts once together.
   */
  botCountByRound(threadId: ThreadId): number {
    const row = this.db
      .prepare(
        `WITH since AS (
           SELECT m.seq, m.run_id FROM thread_messages m
           WHERE m.thread_id = ? AND m.author_kind = 'bot'
             AND m.seq > coalesce(
               (SELECT max(seq) FROM thread_messages WHERE thread_id = ? AND author_kind = 'human'),
               0)
         )
         SELECT count(DISTINCT coalesce(
           (SELECT p.message_id FROM thread_round_plans p
             WHERE p.closer_run_id = since.run_id AND p.phase IN ${DISPATCHED}),
           (SELECT rr.message_id FROM thread_round_runs rr
              JOIN thread_round_plans p ON p.message_id = rr.message_id
             WHERE rr.run_id = since.run_id AND p.phase IN ${DISPATCHED}
             ORDER BY rr.created_at, rr.rowid LIMIT 1),
           'seq:' || since.seq)) AS count
         FROM since`,
      )
      .get(threadId, threadId) as { count: number };
    return row.count;
  }

  /** The plan as a round view carries it (amendment 6, decision 51). */
  view(messageId: MessageId, threadId: ThreadId): RoundPlan | undefined {
    const plan = this.get(messageId);
    if (!plan) return undefined;
    const closer = plan.closerRunId
      ? (this.db.prepare("SELECT status FROM runs WHERE id = ?").get(plan.closerRunId) as
          | { status: RunStatus }
          | undefined)
      : undefined;
    const synthesis = plan.closerRunId
      ? (
          this.db
            .prepare(
              `SELECT id FROM thread_messages WHERE thread_id = ? AND run_id = ?
                 AND author_kind = 'bot' ORDER BY seq`,
            )
            .all(threadId, plan.closerRunId) as { id: string }[]
        ).map((row) => row.id as MessageId)
      : [];
    return {
      phase: plan.phase,
      ...(plan.triageRunId ? { triageRunId: plan.triageRunId } : {}),
      assignments: plan.assignments,
      ...(plan.closerBotId ? { closerBotId: plan.closerBotId } : {}),
      ...(plan.closerRunId ? { closerRunId: plan.closerRunId } : {}),
      ...(closer ? { closerRunStatus: closer.status } : {}),
      synthesisMessageIds: synthesis,
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
  }

  private stored(row: PlanRow): StoredPlan {
    const assignments = (
      this.db
        .prepare(
          "SELECT bot_id, task FROM thread_round_assignments WHERE message_id = ? ORDER BY ordinal",
        )
        .all(row.message_id) as { bot_id: string; task: string }[]
    ).map((a) => ({ botId: a.bot_id as BotId, task: a.task }));
    return {
      messageId: row.message_id as MessageId,
      phase: row.phase,
      ...(row.triage_run_id ? { triageRunId: row.triage_run_id as RunId } : {}),
      ...(row.closer_bot_id ? { closerBotId: row.closer_bot_id as BotId } : {}),
      ...(row.closer_run_id ? { closerRunId: row.closer_run_id as RunId } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      assignments,
    };
  }
}
