// Durable request rounds (ADR-0005 amendment 4): one per accepted originating message, its member
// snapshot and the runs related to each member. Written by the router in the transaction that
// stores the message; read by the current-round strip and Activity. Routing never reads it.

import {
  type BotId,
  type MessageId,
  type RoundMember,
  type RoundMemberState,
  type RoundMode,
  type RoundRunRelation,
  type RunId,
  type RunStatus,
  type ThreadId,
  type ThreadRound,
  type WorkspaceId,
  isRoundMemberDone,
  isTerminal,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { RoundPlanStore } from "./round-plans.js";

interface RoundRow {
  message_id: string;
  workspace_id: string;
  thread_id: string;
  mode: RoundMode;
  parent_message_id: string | null;
  created_at: string;
  cancelled_at: string | null;
  seq: number;
  author_kind: "human" | "bot";
  author_id: string;
  body: string;
}

interface RelationRow {
  bot_id: string;
  run_id: string;
  relation: RoundRunRelation;
  status: RunStatus;
}

export interface OpenRoundInput {
  messageId: MessageId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  mode: RoundMode;
  botIds: readonly BotId[];
  parentMessageId?: MessageId | undefined;
}

const EXCERPT = 140;

const SELECT_ROUND = `SELECT r.*, m.seq, m.author_kind, m.author_id, m.body
  FROM thread_rounds r JOIN thread_messages m ON m.id = r.message_id`;

export class RoundStore {
  constructor(private readonly db: GatewayDb) {}

  /** Decision 30. Idempotent per message: a second call for the same message changes nothing. */
  open(input: OpenRoundInput): void {
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_rounds
           (message_id, workspace_id, thread_id, mode, parent_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.messageId,
        input.workspaceId,
        input.threadId,
        input.mode,
        input.parentMessageId ?? null,
        nowIso(),
      );
    if (inserted.changes === 0) return;
    const member = this.db.prepare(
      "INSERT OR IGNORE INTO thread_round_members (message_id, bot_id, ordinal) VALUES (?, ?, ?)",
    );
    input.botIds.forEach((botId, ordinal) => member.run(input.messageId, botId, ordinal));
  }

  /** Decision 34: whether the round was cancelled; a cancelled round takes no new work. */
  isCancelled(messageId: MessageId): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM thread_rounds WHERE message_id = ? AND cancelled_at IS NOT NULL")
        .get(messageId) !== undefined
    );
  }

  exists(messageId: MessageId): boolean {
    return (
      this.db.prepare("SELECT 1 FROM thread_rounds WHERE message_id = ?").get(messageId) !==
      undefined
    );
  }

  /**
   * Decision 31: relate a run to a round member. A cancelled round, an unknown round and a bot
   * outside the snapshot take no relation, so nothing late can revive a cancelled round.
   */
  relate(messageId: MessageId, botId: BotId, runId: RunId, relation: RoundRunRelation): boolean {
    const open = this.db
      .prepare(
        `SELECT 1 FROM thread_rounds r JOIN thread_round_members m ON m.message_id = r.message_id
         WHERE r.message_id = ? AND m.bot_id = ? AND r.cancelled_at IS NULL`,
      )
      .get(messageId, botId);
    if (!open) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_round_runs (message_id, bot_id, run_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, botId, runId, relation, nowIso());
    return result.changes > 0;
  }

  /** The round a run was made for (its first relation): the parent of a round it posts. */
  roundOfRun(runId: RunId): MessageId | undefined {
    const row = this.db
      .prepare(
        "SELECT message_id FROM thread_round_runs WHERE run_id = ? ORDER BY created_at, rowid LIMIT 1",
      )
      .get(runId) as { message_id: string } | undefined;
    return row?.message_id as MessageId | undefined;
  }

  /** The round and every round whose parent chain reaches it (decision 34). */
  withDescendants(messageId: MessageId): MessageId[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT message_id FROM thread_rounds WHERE message_id = ?
           UNION SELECT r.message_id FROM thread_rounds r JOIN tree ON r.parent_message_id = tree.id
         ) SELECT id FROM tree`,
      )
      .all(messageId) as { id: string }[];
    return rows.map((row) => row.id as MessageId);
  }

  /** Runs related to these rounds, each with whether it also serves a round outside them. */
  runsOf(messageIds: readonly MessageId[]): { runId: RunId; shared: boolean }[] {
    if (messageIds.length === 0) return [];
    const marks = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT rr.run_id,
           EXISTS (SELECT 1 FROM thread_round_runs other
                   JOIN thread_rounds o ON o.message_id = other.message_id
                   WHERE other.run_id = rr.run_id AND other.message_id NOT IN (${marks})
                     AND o.cancelled_at IS NULL) AS shared
         FROM thread_round_runs rr WHERE rr.message_id IN (${marks})`,
      )
      .all(...messageIds, ...messageIds) as { run_id: string; shared: number }[];
    return rows.map((row) => ({ runId: row.run_id as RunId, shared: row.shared === 1 }));
  }

  markCancelled(messageIds: readonly MessageId[], by: string): void {
    const update = this.db.prepare(
      "UPDATE thread_rounds SET cancelled_at = ?, cancelled_by = ? WHERE message_id = ? AND cancelled_at IS NULL",
    );
    const at = nowIso();
    for (const id of messageIds) update.run(at, by, id);
  }

  /** The newest rounds of a thread, newest first, as presented (decision 33). */
  list(threadId: ThreadId, limit = 20): ThreadRound[] {
    const rows = this.db
      .prepare(`${SELECT_ROUND} WHERE r.thread_id = ? ORDER BY m.seq DESC LIMIT ?`)
      .all(threadId, limit) as RoundRow[];
    return rows.map((row) => this.view(row));
  }

  get(messageId: MessageId): ThreadRound | undefined {
    const row = this.db.prepare(`${SELECT_ROUND} WHERE r.message_id = ?`).get(messageId) as
      | RoundRow
      | undefined;
    return row ? this.view(row) : undefined;
  }

  /** Every round a run serves, for Activity grouping (ADR-0033 decision 1). */
  roundsOfRuns(runIds: readonly RunId[]): Map<RunId, MessageId[]> {
    const out = new Map<RunId, MessageId[]>();
    if (runIds.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT run_id, message_id FROM thread_round_runs
         WHERE run_id IN (${runIds.map(() => "?").join(", ")}) ORDER BY created_at, rowid`,
      )
      .all(...runIds) as { run_id: string; message_id: string }[];
    for (const row of rows) {
      const list = out.get(row.run_id as RunId) ?? [];
      list.push(row.message_id as MessageId);
      out.set(row.run_id as RunId, list);
    }
    return out;
  }

  private view(row: RoundRow): ThreadRound {
    const messageId = row.message_id as MessageId;
    const members = this.db
      .prepare(
        "SELECT bot_id, ordinal FROM thread_round_members WHERE message_id = ? ORDER BY ordinal",
      )
      .all(messageId) as { bot_id: string; ordinal: number }[];
    const relations = this.db
      .prepare(
        `SELECT rr.bot_id, rr.run_id, rr.relation, runs.status
         FROM thread_round_runs rr JOIN runs ON runs.id = rr.run_id
         WHERE rr.message_id = ? ORDER BY rr.created_at, rr.rowid`,
      )
      .all(messageId) as RelationRow[];
    const current = new Set(
      (
        this.db
          .prepare("SELECT bot_id FROM thread_members WHERE thread_id = ?")
          .all(row.thread_id) as {
          bot_id: string;
        }[]
      ).map((m) => m.bot_id),
    );
    const walk = this.db
      .prepare("SELECT status, taker_bot_id FROM thread_routing_walks WHERE message_id = ?")
      .get(messageId) as
      | { status: "pending" | "complete"; taker_bot_id: string | null }
      | undefined;
    const outputs = this.db.prepare(
      `SELECT id FROM thread_messages WHERE thread_id = ? AND author_kind = 'bot' AND author_id = ?
         AND seq > ? AND run_id IN (SELECT run_id FROM thread_round_runs WHERE message_id = ? AND bot_id = ?)
       ORDER BY seq`,
    );
    // Amendment 6: a triaged round's plan; a member triage did not assign is skipped.
    const plan = new RoundPlanStore(this.db).view(messageId, row.thread_id as ThreadId);
    const dispatched =
      plan !== undefined &&
      (plan.phase === "working" || plan.phase === "closing" || plan.phase === "closed");
    const viewMembers: RoundMember[] = members.map((member) => {
      const mine = relations.filter((r) => r.bot_id === member.bot_id);
      const latest = mine.at(-1);
      const outputMessageIds = (
        outputs.all(row.thread_id, member.bot_id, row.seq, messageId, member.bot_id) as {
          id: string;
        }[]
      ).map((m) => m.id as MessageId);
      const state = memberState({
        latest,
        outputs: outputMessageIds.length,
        isMember: current.has(member.bot_id),
        cancelled: row.cancelled_at !== null,
        walk,
        botId: member.bot_id,
        unassigned:
          dispatched && !plan.assignments.some((a) => (a.botId as string) === member.bot_id),
      });
      return {
        botId: member.bot_id as BotId,
        ordinal: member.ordinal,
        state,
        ...(latest ? { runId: latest.run_id as RunId } : {}),
        runs: mine.map((r) => ({ runId: r.run_id as RunId, relation: r.relation })),
        outputMessageIds,
      };
    });
    return {
      workspaceId: row.workspace_id as WorkspaceId,
      threadId: row.thread_id as ThreadId,
      messageId,
      messageSeq: row.seq,
      authorKind: row.author_kind,
      authorId: row.author_id,
      excerpt: row.body.length > EXCERPT ? `${row.body.slice(0, EXCERPT - 1)}…` : row.body,
      mode: row.mode,
      ...(row.parent_message_id ? { parentMessageId: row.parent_message_id as MessageId } : {}),
      createdAt: row.created_at,
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
      members: viewMembers,
      completed: viewMembers.filter((m) => isRoundMemberDone(m.state)).length,
      total: viewMembers.length,
      ...(plan ? { plan } : {}),
    };
  }
}

/** Decision 33: a member's state, from its latest related run and nothing older. */
function memberState(input: {
  latest: RelationRow | undefined;
  outputs: number;
  isMember: boolean;
  cancelled: boolean;
  walk: { status: "pending" | "complete"; taker_bot_id: string | null } | undefined;
  botId: string;
  unassigned?: boolean;
}): RoundMemberState {
  const { latest } = input;
  if (!latest) {
    if (!input.isMember) return "removed";
    if (input.cancelled) return "cancelled";
    if (input.unassigned) return "skipped";
    if (input.walk?.status === "complete")
      return input.walk.taker_bot_id && input.walk.taker_bot_id !== input.botId
        ? "skipped"
        : "seen";
    return "pending";
  }
  if (!input.isMember && !isTerminal(latest.status)) return runState(latest.status, input.outputs);
  if (!input.isMember && input.outputs === 0 && latest.status !== "failed") return "removed";
  return runState(latest.status, input.outputs);
}

function runState(status: RunStatus, outputs: number): RoundMemberState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "stalled":
    case "waiting_browser":
    // ADR-0029: the platform parked it and the Gateway continues it without anyone's decision.
    case "waiting_platform":
      return "running";
    case "waiting_approval":
    case "waiting_approval_live":
      return "awaiting_approval";
    case "waiting_continuation":
      return "paused";
    case "succeeded":
    case "silent":
      return outputs > 0 ? "replied" : "silent";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stopped":
      return "stopped";
  }
}
