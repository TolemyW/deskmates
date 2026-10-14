import type { BotId, MessageId, RunId, ThreadId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface WalkRow {
  message_id: string;
  thread_id: string;
  next_member_index: number;
  active_run_id: string | null;
  status: "pending" | "complete";
  mode: WalkMode;
  taker_bot_id: string | null;
  created_at: string;
}

/**
 * `all` is decision 4's walk: every member is woken in turn. `first_taker` is the offer of
 * ADR-0005 amendment 2, decision 14: it ends with the first member that posts.
 */
export type WalkMode = "all" | "first_taker";

export interface RoutingWalk {
  messageId: MessageId;
  threadId: ThreadId;
  nextMemberIndex: number;
  activeRunId?: RunId;
  status: "pending" | "complete";
  mode: WalkMode;
  /** The member that took a `first_taker` walk; absent while it is offered or when nobody did. */
  takerBotId?: BotId;
  createdAt: string;
}

/** Durable state for ADR-0005's one-message-at-a-time, join-order walk. */
export class RoutingWalkStore {
  constructor(private readonly db: GatewayDb) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  enqueue(
    messageId: MessageId,
    threadId: ThreadId,
    botIds: readonly BotId[],
    mode: WalkMode = "all",
  ): RoutingWalk {
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO thread_routing_walks
           (message_id, thread_id, next_member_index, active_run_id, status, mode, created_at)
         VALUES (?, ?, 0, NULL, 'pending', ?, ?)`,
      )
      .run(messageId, threadId, mode, createdAt);
    const insert = this.db.prepare(
      "INSERT INTO thread_routing_walk_members (message_id, ordinal, bot_id) VALUES (?, ?, ?)",
    );
    botIds.forEach((botId, ordinal) => insert.run(messageId, ordinal, botId));
    return this.mustGet(messageId);
  }

  get(messageId: MessageId): RoutingWalk | undefined {
    const row = this.db
      .prepare("SELECT * FROM thread_routing_walks WHERE message_id = ?")
      .get(messageId) as WalkRow | undefined;
    return row ? toWalk(row) : undefined;
  }

  mustGet(messageId: MessageId): RoutingWalk {
    const walk = this.get(messageId);
    if (!walk) throw new Error(`routing walk ${messageId} not found`);
    return walk;
  }

  oldestPending(threadId: ThreadId): RoutingWalk | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_routing_walks
         WHERE thread_id = ? AND status = 'pending'
         ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(threadId) as WalkRow | undefined;
    return row ? toWalk(row) : undefined;
  }

  pendingThreadIds(): ThreadId[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id FROM thread_routing_walks WHERE status = 'pending'
         GROUP BY thread_id ORDER BY min(created_at), min(rowid)`,
      )
      .all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id as ThreadId);
  }

  member(messageId: MessageId, ordinal: number): BotId | undefined {
    const row = this.db
      .prepare(
        "SELECT bot_id FROM thread_routing_walk_members WHERE message_id = ? AND ordinal = ?",
      )
      .get(messageId, ordinal) as { bot_id: string } | undefined;
    return row?.bot_id as BotId | undefined;
  }

  /** Every member of the walk in the order it is offered. */
  members(messageId: MessageId): BotId[] {
    const rows = this.db
      .prepare(
        "SELECT bot_id FROM thread_routing_walk_members WHERE message_id = ? ORDER BY ordinal",
      )
      .all(messageId) as { bot_id: string }[];
    return rows.map((row) => row.bot_id as BotId);
  }

  /** Replace the offer order of a walk nobody has been offered yet (owner first, decision 16). */
  reorder(messageId: MessageId, botIds: readonly BotId[]): void {
    this.db.prepare("DELETE FROM thread_routing_walk_members WHERE message_id = ?").run(messageId);
    const insert = this.db.prepare(
      "INSERT INTO thread_routing_walk_members (message_id, ordinal, bot_id) VALUES (?, ?, ?)",
    );
    botIds.forEach((botId, ordinal) => insert.run(messageId, ordinal, botId));
  }

  /** The pending walk whose current member is this run, if any. */
  activeForRun(runId: RunId): RoutingWalk | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM thread_routing_walks WHERE active_run_id = ? AND status = 'pending' LIMIT 1",
      )
      .get(runId) as WalkRow | undefined;
    return row ? toWalk(row) : undefined;
  }

  /** A member took the offer: the walk is over and nobody after it is woken. */
  take(messageId: MessageId, botId: BotId): void {
    this.db
      .prepare(
        `UPDATE thread_routing_walks
         SET status = 'complete', active_run_id = NULL, taker_bot_id = ?
         WHERE message_id = ?`,
      )
      .run(botId, messageId);
  }

  setActive(messageId: MessageId, runId: RunId): RoutingWalk {
    this.db
      .prepare("UPDATE thread_routing_walks SET active_run_id = ? WHERE message_id = ?")
      .run(runId, messageId);
    return this.mustGet(messageId);
  }

  finishMember(messageId: MessageId): RoutingWalk {
    this.db
      .prepare(
        `UPDATE thread_routing_walks
         SET next_member_index = next_member_index + 1, active_run_id = NULL
         WHERE message_id = ?`,
      )
      .run(messageId);
    return this.mustGet(messageId);
  }

  complete(messageId: MessageId): void {
    this.db
      .prepare(
        "UPDATE thread_routing_walks SET status = 'complete', active_run_id = NULL WHERE message_id = ?",
      )
      .run(messageId);
  }

  /** A turn-budget pause abandons unfinished routing; the next human turn starts fresh. */
  completePendingInThread(threadId: ThreadId): void {
    this.db
      .prepare(
        `UPDATE thread_routing_walks SET status = 'complete', active_run_id = NULL
         WHERE thread_id = ? AND status = 'pending'`,
      )
      .run(threadId);
  }

  /** A reserved run stays queued until every earlier walk in its thread is complete. */
  blockedByEarlierWalk(runId: RunId): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM thread_routing_walks current
         WHERE current.active_run_id = ? AND EXISTS (
           SELECT 1 FROM thread_routing_walks earlier
           WHERE earlier.thread_id = current.thread_id AND earlier.status = 'pending'
             AND (earlier.created_at < current.created_at OR
               (earlier.created_at = current.created_at AND earlier.rowid < current.rowid))
         )`,
      )
      .get(runId);
    return row !== undefined;
  }
}

function toWalk(row: WalkRow): RoutingWalk {
  return {
    messageId: row.message_id as MessageId,
    threadId: row.thread_id as ThreadId,
    nextMemberIndex: row.next_member_index,
    ...(row.active_run_id ? { activeRunId: row.active_run_id as RunId } : {}),
    status: row.status,
    mode: row.mode,
    ...(row.taker_bot_id ? { takerBotId: row.taker_bot_id as BotId } : {}),
    createdAt: row.created_at,
  };
}
