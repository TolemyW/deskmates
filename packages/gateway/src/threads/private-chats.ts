import {
  type BotId,
  DeskmatesError,
  type IncomingHandoff,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { ThreadStore } from "./threads.js";

/** Stable operator inboxes. These rows never enter thread delivery or routing. */
export class PrivateChatStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly threads: ThreadStore,
    private readonly bots: BotStore,
  ) {}

  /** The bot's canonical private chat if it is bound already; never creates or adopts one. */
  existing(botId: BotId) {
    const binding = this.db
      .prepare("SELECT thread_id FROM private_chats WHERE bot_id = ?")
      .get(botId) as { thread_id: ThreadId | null } | undefined;
    return binding?.thread_id ? this.threads.mustGet(binding.thread_id) : undefined;
  }

  /** Upgrade reconciliation: old Bots gain a stable inbox, but no retroactive welcome run. */
  ensureExisting(): void {
    for (const bot of this.bots.list()) this.resolve(bot.id);
  }

  resolve(botId: BotId) {
    return this.db.transaction(() => {
      const bot = this.bots.mustGet(botId);
      const binding = this.db
        .prepare("SELECT thread_id FROM private_chats WHERE bot_id = ?")
        .get(botId) as { thread_id: ThreadId | null } | undefined;
      if (binding?.thread_id) return this.threads.mustGet(binding.thread_id);
      // Adopt once only. A cleared binding means the human promoted the old inbox to a group.
      // A Member's side chat is never adopted: it stays theirs (ADR-0022 amendment 1).
      const existing = binding
        ? undefined
        : (this.db
            .prepare(`SELECT t.id FROM threads t
        JOIN thread_members m ON m.thread_id = t.id
        WHERE m.bot_id = ? AND t.workspace_id = ? AND t.kind = 'chat' AND t.channel = 'web'
          AND t.opened_by IS NULL
          AND (SELECT count(*) FROM thread_members WHERE thread_id = t.id) = 1
        ORDER BY t.updated_at DESC, t.id LIMIT 1`)
            .get(botId, bot.workspaceId) as { id: ThreadId } | undefined);
      const thread = existing
        ? this.threads.mustGet(existing.id)
        : this.threads.create({ workspaceId: bot.workspaceId, botIds: [botId] });
      this.db
        .prepare(`INSERT INTO private_chats(bot_id, thread_id) VALUES (?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET thread_id = excluded.thread_id`)
        .run(botId, thread.id);
      return thread;
    })();
  }

  /** The bot whose canonical inbox this thread currently is; a lookup that never binds. */
  boundBot(threadId: ThreadId): BotId | undefined {
    const row = this.db
      .prepare("SELECT bot_id FROM private_chats WHERE thread_id = ?")
      .get(threadId) as { bot_id: BotId } | undefined;
    return row?.bot_id;
  }

  record(
    messageId: MessageId,
    sourceMessageId: MessageId,
    recipient: BotId,
    runId: RunId,
  ): ThreadId {
    const thread = this.resolve(recipient);
    this.db
      .prepare(`INSERT INTO incoming_handoffs(message_id, source_message_id, recipient_bot_id, run_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
      .run(messageId, sourceMessageId, recipient, runId, nowIso());
    this.threads.touch(thread.id);
    return thread.id;
  }

  /**
   * Incoming handoffs of a private chat, newest first (`seq DESC`). With `page`, at most
   * `limit + 1` rows older than `beforeSeq` (#113 slice CH), so the caller can tell whether more
   * exist.
   */
  list(
    threadId: ThreadId,
    actor: string,
    page?: { limit: number; beforeSeq?: number },
  ): IncomingHandoff[] {
    const bounded = page
      ? ` AND h.seq < ${Math.trunc(page.beforeSeq ?? Number.MAX_SAFE_INTEGER)} ORDER BY h.seq DESC LIMIT ${Math.trunc(page.limit) + 1}`
      : " ORDER BY h.seq DESC";
    return this.db
      .prepare(`SELECT h.seq, b.name AS callerName, substr(m.body, 1, 600) AS excerpt,
        s.thread_id AS sourceThreadId, s.id AS sourceMessageId, m.thread_id AS handoffThreadId,
        h.run_id AS runId, r.status, h.created_at AS createdAt,
        h.seq > coalesce(rd.seen_seq, 0) AS unread
      FROM private_chats p JOIN incoming_handoffs h ON h.recipient_bot_id = p.bot_id
      JOIN thread_messages m ON m.id = h.message_id
      JOIN thread_messages s ON s.id = h.source_message_id
      JOIN bots b ON b.id = m.author_id JOIN runs r ON r.id = h.run_id
      LEFT JOIN incoming_handoff_reads rd ON rd.bot_id = p.bot_id AND rd.actor_id = ?
      WHERE p.thread_id = ?${bounded}`)
      .all(actor, threadId)
      .map((row) => {
        const item = row as IncomingHandoff;
        return { ...item, unread: Boolean(item.unread) };
      });
  }

  unread(threadId: ThreadId, actor: string): number {
    return (
      this.db
        .prepare(`SELECT count(*) AS n FROM private_chats p
      JOIN incoming_handoffs h ON h.recipient_bot_id = p.bot_id
      LEFT JOIN incoming_handoff_reads rd ON rd.bot_id = p.bot_id AND rd.actor_id = ?
      WHERE p.thread_id = ? AND h.seq > coalesce(rd.seen_seq, 0)`)
        .get(actor, threadId) as { n: number }
    ).n;
  }

  latest(
    threadId: ThreadId,
  ): Pick<IncomingHandoff, "callerName" | "excerpt" | "createdAt"> | undefined {
    return this.db
      .prepare(`SELECT b.name AS callerName, substr(m.body, 1, 160) AS excerpt, h.created_at AS createdAt
      FROM private_chats p JOIN incoming_handoffs h ON h.recipient_bot_id = p.bot_id
      JOIN thread_messages m ON m.id = h.message_id JOIN bots b ON b.id = m.author_id
      WHERE p.thread_id = ? ORDER BY h.seq DESC LIMIT 1`)
      .get(threadId) as Pick<IncomingHandoff, "callerName" | "excerpt" | "createdAt"> | undefined;
  }

  markRead(threadId: ThreadId, actor: string, through: number): void {
    // A bounded watermark cannot swallow a notification that arrived after the client fetched.
    this.db
      .prepare(`INSERT INTO incoming_handoff_reads(bot_id, actor_id, seen_seq)
      SELECT p.bot_id, ?, coalesce(max(h.seq), 0) FROM private_chats p
      LEFT JOIN incoming_handoffs h ON h.recipient_bot_id = p.bot_id AND h.seq <= ?
      WHERE p.thread_id = ? GROUP BY p.bot_id
      ON CONFLICT(bot_id, actor_id) DO UPDATE SET seen_seq = max(seen_seq, excluded.seen_seq)`)
      .run(actor, through, threadId);
  }

  forRun(runId: RunId): ThreadId[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT p.thread_id FROM incoming_handoffs h
      JOIN private_chats p ON p.bot_id = h.recipient_bot_id
      WHERE h.run_id = ? AND p.thread_id IS NOT NULL`)
        .all(runId) as { thread_id: ThreadId }[]
    ).map((r) => r.thread_id);
  }

  results(
    source: MessageId,
  ): { name: string; messageId: MessageId | null; reason: string | null }[] {
    return this.db
      .prepare(`SELECT recipient_name AS name, message_id AS messageId, reason
      FROM private_mention_results WHERE source_message_id = ? ORDER BY rowid`)
      .all(source) as { name: string; messageId: MessageId | null; reason: string | null }[];
  }

  recordResult(
    source: MessageId,
    name: string,
    messageId: MessageId | null,
    reason: string | null,
  ): void {
    this.db
      .prepare(`INSERT INTO private_mention_results(source_message_id, recipient_name, message_id, reason)
      VALUES (?, ?, ?, ?)`)
      .run(source, name.toLowerCase(), messageId, reason);
  }

  postOnce<T>(runId: RunId, key: unknown, request: string, post: () => T): T {
    return this.db.transaction(() => {
      if (key === undefined) return post(); // Older sidecars have no request ID.
      if (typeof key !== "string" || key.length < 1 || key.length > 200)
        throw new DeskmatesError("validation", "invalid message request ID");
      const previous = this.db
        .prepare(
          "SELECT request_body, response_json FROM message_requests WHERE run_id = ? AND request_id = ?",
        )
        .get(runId, key) as { request_body: string; response_json: string } | undefined;
      if (previous) {
        if (previous.request_body !== request)
          throw new DeskmatesError(
            "validation",
            "message request ID was reused for different content",
          );
        return JSON.parse(previous.response_json) as T;
      }
      const response = post();
      this.db
        .prepare("INSERT INTO message_requests VALUES (?, ?, ?, ?)")
        .run(runId, key, request, JSON.stringify(response));
      return response;
    })();
  }
}
