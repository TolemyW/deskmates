// The thread transcript (ADR-0005 item 2). `thread_messages` is append-only with a dense `seq`
// per thread; a woken bot receives exactly the rows with `seq > last_seen_seq`.

import {
  type Attachment,
  type BotId,
  CHAT_PREVIEW_MAX,
  DeskmatesError,
  type IsoTimestamp,
  type Mention,
  type MessageAuthorKind,
  type MessageId,
  type RunId,
  type ThreadId,
  type ThreadLastMessage,
  type ThreadMessage,
  messageExcerpt,
  messageExcerptSourceChars,
} from "@deskmates/contracts";
import { newId, nowIso, parseJson } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { normalizeBody } from "./caps.js";

/**
 * The seq the thread's message caps count from (ADR-0005 amendment 3, decision 22): the later of
 * the latest human message and the thread's `budget_reset_seq`. Binds the thread id twice.
 */
export const BUDGET_ORIGIN_SQL = `max(
  coalesce((SELECT max(seq) FROM thread_messages WHERE thread_id = ? AND author_kind = 'human'), 0),
  coalesce((SELECT budget_reset_seq FROM threads WHERE id = ?), 0))`;

interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  author_kind: MessageAuthorKind;
  author_id: string;
  body: string;
  attachments_json: string;
  mentions_json: string;
  relay_count: number;
  run_id: string | null;
  external_id: string | null;
  must_reply: number;
  ts: string;
}

export interface AppendMessageInput {
  threadId: ThreadId;
  authorKind: MessageAuthorKind;
  authorId: string;
  body: string;
  attachments?: readonly Attachment[];
  mentions?: readonly Mention[];
  relayCount?: number;
  runId?: RunId;
  /** The channel adapter's id for the external message (ADR-0017 decision 2); unique per thread. */
  externalId?: string;
  /** The poster asked for a definite answer (issue #21); routing ignores it. */
  mustReply?: boolean;
}

export class MessageStore {
  constructor(private readonly db: GatewayDb) {}

  /** Appends a message, assigning the next `seq` for the thread atomically. */
  append(input: AppendMessageInput): ThreadMessage {
    if (!input.body.trim() && (input.attachments?.length ?? 0) === 0) {
      throw new DeskmatesError("validation", "message body is required");
    }
    const id = newId("msg") as MessageId;
    return this.db.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(input.threadId);
      if (!exists) {
        throw new DeskmatesError("not_found", `thread ${input.threadId} not found`, {
          threadId: input.threadId,
        });
      }
      const { next } = this.db
        .prepare(
          "SELECT coalesce(max(seq), 0) + 1 AS next FROM thread_messages WHERE thread_id = ?",
        )
        .get(input.threadId) as { next: number };
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO thread_messages (id, thread_id, seq, author_kind, author_id, body,
             attachments_json, mentions_json, relay_count, run_id, external_id, must_reply, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.threadId,
          next,
          input.authorKind,
          input.authorId,
          input.body,
          JSON.stringify(input.attachments ?? []),
          JSON.stringify(input.mentions ?? []),
          input.relayCount ?? 0,
          input.runId ?? null,
          input.externalId ?? null,
          input.mustReply === true ? 1 : 0,
          ts,
        );
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(ts, input.threadId);
      return this.mustGet(id);
    })();
  }

  get(id: MessageId): ThreadMessage | undefined {
    const row = this.db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(id) as
      | MessageRow
      | undefined;
    return row ? toMessage(row) : undefined;
  }

  mustGet(id: MessageId): ThreadMessage {
    const m = this.get(id);
    if (!m) throw new DeskmatesError("not_found", `message ${id} not found`, { messageId: id });
    return m;
  }

  /** The message a channel adapter already posted under this external id, if any (ADR-0017). */
  findByExternalId(threadId: ThreadId, externalId: string): ThreadMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND external_id = ?")
      .get(threadId, externalId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  list(threadId: ThreadId, afterSeq = 0): ThreadMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND seq > ? ORDER BY seq")
      .all(threadId, afterSeq) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * A bounded slice of a transcript in `seq` order (#113 slice CH). With `afterSeq` it is the
   * tail after that seq; otherwise the newest messages before `beforeSeq` (or of all). `more`
   * says the slice stopped short: more after it for a tail, older before it for a window.
   */
  listSlice(
    threadId: ThreadId,
    slice: { afterSeq?: number; beforeSeq?: number; limit: number },
  ): { messages: ThreadMessage[]; more: boolean } {
    const limit = Math.trunc(slice.limit);
    if (slice.afterSeq !== undefined) {
      const rows = this.db
        .prepare(
          "SELECT * FROM thread_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        )
        .all(threadId, slice.afterSeq, limit + 1) as MessageRow[];
      return { messages: rows.slice(0, limit).map(toMessage), more: rows.length > limit };
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM thread_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(threadId, slice.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1) as MessageRow[];
    return {
      messages: rows.slice(0, limit).reverse().map(toMessage),
      more: rows.length > limit,
    };
  }

  /** Final replies may repeat a successful tool post. Scope equality to this run and thread. */
  findRunReply(
    threadId: ThreadId,
    runId: RunId,
    botId: BotId,
    body: string,
  ): ThreadMessage | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_messages
         WHERE thread_id = ? AND run_id = ? AND author_kind = 'bot' AND author_id = ?
         ORDER BY seq DESC`,
      )
      .all(threadId, runId, botId) as MessageRow[];
    const match = rows.find((row) => row.body.trim() === body.trim());
    return match ? toMessage(match) : undefined;
  }

  /** The oldest message of a thread: a submission's instruction (issue #21). */
  first(threadId: ThreadId): ThreadMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq LIMIT 1")
      .get(threadId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  /** The newest message of a thread, for the chat list; undefined for an empty thread. */
  latest(threadId: ThreadId): ThreadMessage | undefined {
    const row = this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1")
      .get(threadId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  /**
   * The newest message as the chat list shows it (issue #16): the excerpt is derived from a
   * bounded prefix of the stored body, never from a rewritten one.
   */
  lastMessage(threadId: ThreadId): ThreadLastMessage | undefined {
    const row = this.db
      .prepare(`SELECT seq, author_kind, author_id, substr(body, 1, ?) AS body, ts
        FROM thread_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(messageExcerptSourceChars(CHAT_PREVIEW_MAX), threadId) as
      | Pick<MessageRow, "seq" | "author_kind" | "author_id" | "body" | "ts">
      | undefined;
    if (!row) return undefined;
    return {
      seq: row.seq,
      authorKind: row.author_kind,
      authorId: row.author_id,
      excerpt: messageExcerpt(row.body, CHAT_PREVIEW_MAX),
      ts: row.ts as IsoTimestamp,
    };
  }

  maxSeq(threadId: ThreadId): number {
    const { seq } = this.db
      .prepare("SELECT coalesce(max(seq), 0) AS seq FROM thread_messages WHERE thread_id = ?")
      .get(threadId) as { seq: number };
    return seq;
  }

  /**
   * Whether this bot answered after it saw message `seq`: a message of its own, later than
   * `seq`, from a run that was delivered `seq`. A post from a run that started before the
   * message existed says nothing about it.
   */
  botAnsweredAfterSeeing(threadId: ThreadId, botId: BotId, seq: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM thread_messages m JOIN runs r ON r.id = m.run_id
         WHERE m.thread_id = ? AND m.author_kind = 'bot' AND m.author_id = ? AND m.seq > ?
           AND r.delivered_seq >= ? LIMIT 1`,
      )
      .get(threadId, botId, seq, seq);
    return row !== undefined;
  }

  /**
   * Whether a message in `(afterSeq, throughSeq]` of the thread asked for a definite answer: the
   * slice a run was delivered (issue #21).
   */
  mustReplyInRange(threadId: ThreadId, afterSeq: number, throughSeq: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM thread_messages
         WHERE thread_id = ? AND seq > ? AND seq <= ? AND must_reply = 1 LIMIT 1`,
      )
      .get(threadId, afterSeq, throughSeq);
    return row !== undefined;
  }

  /** Everything one run posted, in any thread, oldest first. */
  postedByRun(runId: RunId): ThreadMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM thread_messages WHERE run_id = ? ORDER BY ts, seq")
      .all(runId) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Bot-authored volume since the budget origin, for ADR-0005's thread budget: messages after
   * both the latest human message and the thread's `budget_reset_seq`, which every unpause moves
   * (amendment 3, decision 22).
   */
  botCountSinceOrigin(threadId: ThreadId): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS count FROM thread_messages
         WHERE thread_id = ? AND author_kind = 'bot' AND seq > ${BUDGET_ORIGIN_SQL}`,
      )
      .get(threadId, threadId, threadId) as { count: number };
    return row.count;
  }

  /**
   * ADR-0005 amendment 5, decision 40 (repetition): how many messages the author of `message`
   * posted in its thread since the budget origin (amendment 3, decision 22) whose normalized
   * body equals its own, itself included.
   */
  botRepeatsSinceOrigin(message: ThreadMessage): number {
    const rows = this.db
      .prepare(
        `SELECT body FROM thread_messages
         WHERE thread_id = ? AND author_kind = 'bot' AND author_id = ? AND seq <= ?
           AND seq > ${BUDGET_ORIGIN_SQL}`,
      )
      .all(message.threadId, message.authorId, message.seq, message.threadId, message.threadId) as {
      body: string;
    }[];
    const body = normalizeBody(message.body);
    return rows.filter((row) => normalizeBody(row.body) === body).length;
  }

  /** Highest relay depth actually delivered in a coalesced run, excluding the bot's own posts. */
  maxRelayInRange(threadId: ThreadId, afterSeq: number, throughSeq: number, botId: BotId): number {
    const row = this.db
      .prepare(
        `SELECT coalesce(max(relay_count), 0) AS relay FROM thread_messages
         WHERE thread_id = ?
           AND seq > max(?, coalesce(
             (SELECT max(seq) FROM thread_messages
              WHERE thread_id = ? AND author_kind = 'human' AND seq <= ?),
             ?
           ))
           AND seq <= ?
           AND NOT (author_kind = 'bot' AND author_id = ?)`,
      )
      .get(threadId, afterSeq, threadId, throughSeq, afterSeq, throughSeq, botId) as {
      relay: number;
    };
    return row.relay;
  }
}

function toMessage(row: MessageRow): ThreadMessage {
  const m: ThreadMessage = {
    id: row.id as MessageId,
    threadId: row.thread_id as ThreadId,
    seq: row.seq,
    authorKind: row.author_kind,
    authorId: row.author_id,
    body: row.body,
    attachments: parseJson<Attachment[]>(row.attachments_json, []),
    mentions: parseJson<Mention[]>(row.mentions_json, []),
    relayCount: row.relay_count,
    ts: row.ts,
  };
  if (row.run_id !== null) m.runId = row.run_id as RunId;
  if (row.external_id !== null) m.externalId = row.external_id;
  if (row.must_reply === 1) m.mustReply = true;
  return m;
}
