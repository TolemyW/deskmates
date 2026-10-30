// Threads and their members (ADR-0005 item 1). A thread is scoped to one workspace; membership is
// routing, not access control. M0 creates one-member `chat` threads through the same code path
// M2 will use for groups.

import {
  type BotId,
  CHAT_THREAD_MAX_MEMBERS,
  DeskmatesError,
  TURN_BUDGET_DEFAULT,
  type Thread,
  type ThreadId,
  type ThreadKind,
  type ThreadMember,
  type ThreadPauseReason,
  type ThreadStatus,
  type WorkspaceId,
} from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ThreadRow {
  id: string;
  workspace_id: string;
  kind: ThreadKind;
  channel: string;
  external_key: string | null;
  /** ADR-0047 decision 10; absent on a database before that migration. */
  channel_connection_id?: string | null;
  binding_generation?: number | null;
  title: string;
  turn_budget: number;
  status: ThreadStatus;
  owner_bot_id: string | null;
  /** Absent on a database before migration 0040. */
  deadline?: string | null;
  /** Absent on a database before migration 0046 (ADR-0022 amendment 1). */
  opened_by?: string | null;
  private_to_user_id?: string | null;
  /** ADR-0005 amendment 3, decisions 20 and 22 (migration 202610171101). */
  pause_reason?: ThreadPauseReason | null;
  paused_seq?: number | null;
  paused_at?: string | null;
  resume_at?: string | null;
  budget_reset_seq?: number;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  thread_id: string;
  bot_id: string;
  last_seen_seq: number;
  joined_at: string;
}

/** What a pause records (ADR-0005 amendment 3, decision 20), written in one update. */
export interface ThreadPause {
  reason: ThreadPauseReason;
  /** The seq of the message that caused the pause. */
  seq: number;
  /** ISO time the pause began. */
  at: string;
  /** A `turn_budget` pause only: when its reset window ends (rewritten decision 22). */
  resumeAt?: string;
}

export interface CreateThreadInput {
  workspaceId: WorkspaceId;
  botIds: readonly BotId[];
  kind?: ThreadKind;
  channel?: string;
  /** Binding to an external conversation of `channel` (ADR-0017 decision 2); unique per channel. */
  externalKey?: string;
  /** An ABI-2 channel thread's connection and binding generation (ADR-0047 decision 10). */
  channelConnection?: { id: string; bindingGeneration: number };
  title?: string;
  turnBudget?: number;
  /** Canonical UTC ISO text (`normalizeDeadline`); issue #21. */
  deadline?: string;
  /** A Member's side chat: who opened it (ADR-0022 amendment 1). */
  sideChatActor?: string;
}

/** Filters for `ThreadStore.list`; `externalKey` needs `channel`. */
export interface ThreadFilter {
  channel?: string;
  externalKey?: string;
}

/** A member joined with its display name, the shape `parseMentions` takes. */
export interface NamedMember extends ThreadMember {
  name: string;
}

export class ThreadStore {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateThreadInput): Thread {
    const kind = input.kind ?? "chat";
    const botIds = [...new Set(input.botIds)];
    if (botIds.length === 0)
      throw new DeskmatesError("validation", "a thread needs at least one bot");
    if (kind === "chat" && botIds.length > CHAT_THREAD_MAX_MEMBERS) {
      throw new DeskmatesError(
        "validation",
        `a chat thread holds at most ${CHAT_THREAD_MAX_MEMBERS} bots`,
        {
          botIds,
        },
      );
    }
    if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(input.workspaceId)) {
      throw new DeskmatesError("not_found", `workspace ${input.workspaceId} not found`, {
        workspaceId: input.workspaceId,
      });
    }
    const names: string[] = [];
    for (const botId of botIds) {
      const bot = this.db.prepare("SELECT name, workspace_id FROM bots WHERE id = ?").get(botId) as
        | { name: string; workspace_id: string }
        | undefined;
      if (!bot) throw new DeskmatesError("not_found", `bot ${botId} not found`, { botId });
      if (bot.workspace_id !== input.workspaceId) {
        // ADR-0005 item 11: threads do not cross workspaces.
        throw new DeskmatesError("validation", `bot ${botId} belongs to another workspace`, {
          botId,
          workspaceId: input.workspaceId,
        });
      }
      names.push(bot.name);
    }
    const id = newId("thr") as ThreadId;
    const ts = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (id, workspace_id, kind, channel, external_key, title, turn_budget, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          kind,
          input.channel ?? "web",
          input.externalKey ?? null,
          input.title?.trim() || names.join(", "),
          input.turnBudget ?? TURN_BUDGET_DEFAULT,
          ts,
          ts,
        );
      if (input.deadline !== undefined) {
        this.db.prepare("UPDATE threads SET deadline = ? WHERE id = ?").run(input.deadline, id);
      }
      if (input.channelConnection !== undefined) {
        this.db
          .prepare(
            "UPDATE threads SET channel_connection_id = ?, binding_generation = ? WHERE id = ?",
          )
          .run(input.channelConnection.id, input.channelConnection.bindingGeneration, id);
      }
      if (input.sideChatActor !== undefined) {
        // A person's side chat has a private audience: that person only (ADR-0031 decision 9).
        // A service principal's stays visible to the workspace (owner answer Q5). Enforcement
        // on every read is the #116 audience lane; this records the audience.
        const person = /^user:(.+)$/.exec(input.sideChatActor)?.[1] ?? null;
        this.db
          .prepare("UPDATE threads SET opened_by = ?, private_to_user_id = ? WHERE id = ?")
          .run(input.sideChatActor, person, id);
      }
      const insertMember = this.db.prepare(
        "INSERT INTO thread_members (thread_id, bot_id, last_seen_seq, joined_at) VALUES (?, ?, 0, ?)",
      );
      for (const botId of botIds) insertMember.run(id, botId, ts);
    })();
    return this.mustGet(id);
  }

  get(id: ThreadId): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : undefined;
  }

  mustGet(id: ThreadId): Thread {
    const t = this.get(id);
    if (!t) throw new DeskmatesError("not_found", `thread ${id} not found`, { threadId: id });
    return t;
  }

  list(workspaceId?: WorkspaceId, filter: ThreadFilter & { tenantId?: string } = {}): Thread[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.tenantId !== undefined) {
      clauses.push("workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = ?)");
      params.push(filter.tenantId);
    }
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (filter.channel !== undefined) {
      clauses.push("channel = ?");
      params.push(filter.channel);
    }
    if (filter.externalKey !== undefined) {
      clauses.push("external_key = ?");
      params.push(filter.externalKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM threads ${where} ORDER BY created_at, id`)
      .all(...params) as ThreadRow[];
    return rows.map(toThread);
  }

  /**
   * One page of a workspace's chat rail (#113 slice CH, plan row 24). Without `after`, the page
   * also holds every pinned thread and every bot's canonical private chat (each bounded by the
   * workspace's pins and bots), so the rail's fixed rows never depend on paging. The rest follow
   * by `updated_at DESC, id DESC`, `limit + 1` rows so the caller can tell whether more exist;
   * `after` continues with those only. `q` matches the title or a member bot's name. Another
   * person's private chat is never listed, nor a bus thread when `includeBus` is false.
   */
  railPage(
    workspaceId: WorkspaceId,
    opts: {
      viewerUserId?: string;
      includeBus: boolean;
      q?: string;
      limit: number;
      after?: [string, string];
    },
  ): { fixed: Thread[]; rest: Thread[] } {
    const visible = `t.workspace_id = ?
      AND (t.private_to_user_id IS NULL OR t.private_to_user_id = ?)
      AND (? = 1 OR t.kind <> 'bus')
      AND (? IS NULL OR instr(lower(t.title), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM thread_members m JOIN bots b ON b.id = m.bot_id
        WHERE m.thread_id = t.id AND instr(lower(b.name), lower(?)) > 0))`;
    const q = opts.q?.trim() ? opts.q.trim() : null;
    const base = [workspaceId, opts.viewerUserId ?? null, opts.includeBus ? 1 : 0, q, q, q];
    const fixedIds = `(t.id IN (SELECT thread_id FROM thread_pins WHERE workspace_id = ?)
      OR t.id IN (SELECT p.thread_id FROM private_chats p JOIN bots b ON b.id = p.bot_id
        WHERE b.workspace_id = ? AND b.archived_at IS NULL AND p.thread_id IS NOT NULL))`;
    const fixed = opts.after
      ? []
      : (
          this.db
            .prepare(`SELECT t.* FROM threads t WHERE ${visible} AND ${fixedIds}
              ORDER BY t.updated_at DESC, t.id DESC`)
            .all(...base, workspaceId, workspaceId) as ThreadRow[]
        ).map(toThread);
    const after = opts.after ? "AND (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))" : "";
    const rest = (
      this.db
        .prepare(`SELECT t.* FROM threads t WHERE ${visible} AND NOT ${fixedIds} ${after}
          ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`)
        .all(
          ...base,
          workspaceId,
          workspaceId,
          ...(opts.after ? [opts.after[0], opts.after[0], opts.after[1]] : []),
          Math.trunc(opts.limit) + 1,
        ) as ThreadRow[]
    ).map(toThread);
    return { fixed, rest };
  }

  /** The thread bound to an external conversation (ADR-0017 decision 2), if any. */
  /** A binding is unique per workspace (migration 0031); a lookup never leaves it. */
  /** ABI-2 connection threads are reached only through their connection's host (ADR-0047). */
  findByExternalKey(
    workspaceId: WorkspaceId,
    channel: string,
    externalKey: string,
  ): Thread | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM threads WHERE workspace_id = ? AND channel = ? AND external_key = ?
           AND binding_generation IS NULL`,
      )
      .get(workspaceId, channel, externalKey) as ThreadRow | undefined;
    return row ? toThread(row) : undefined;
  }

  /** Members in join order (ADR-0005 item 1), each with the bot's display name. */
  members(threadId: ThreadId): NamedMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.thread_id, m.bot_id, m.last_seen_seq, m.joined_at, b.name
         FROM thread_members m JOIN bots b ON b.id = m.bot_id
         WHERE m.thread_id = ? ORDER BY m.joined_at, m.rowid`,
      )
      .all(threadId) as (MemberRow & { name: string })[];
    return rows.map((r) => ({
      threadId: r.thread_id as ThreadId,
      botId: r.bot_id as BotId,
      lastSeenSeq: r.last_seen_seq,
      joinedAt: r.joined_at,
      name: r.name,
    }));
  }

  member(threadId: ThreadId, botId: BotId): NamedMember | undefined {
    return this.members(threadId).find((m) => m.botId === botId);
  }

  botByNameOutsideWorkspace(threadId: ThreadId, name: string): BotId | undefined {
    const thread = this.mustGet(threadId);
    const row = this.db
      .prepare("SELECT id FROM bots WHERE workspace_id <> ? AND lower(name) = lower(?) LIMIT 1")
      .get(thread.workspaceId, name) as { id: string } | undefined;
    return row?.id as BotId | undefined;
  }

  /**
   * ADR-0043 decision 1: after a rename, a thread title the Gateway made from member names (the
   * private chat's is the bot's name) carries the new name. A title a person typed, any part of
   * which is not a member's name, is left alone. Returns the threads whose title changed. The
   * caller has already written the new name to the bot row.
   */
  renameBotInTitles(botId: BotId, oldName: string, newName: string): ThreadId[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title FROM threads t JOIN thread_members m ON m.thread_id = t.id
          WHERE m.bot_id = ?`,
      )
      .all(botId) as { id: ThreadId; title: string }[];
    const changed: ThreadId[] = [];
    for (const row of rows) {
      const names = new Set(
        this.members(row.id).map((member) => (member.botId === botId ? oldName : member.name)),
      );
      const parts = row.title.split(", ");
      if (!parts.includes(oldName) || !parts.every((part) => names.has(part))) continue;
      const title = parts.map((part) => (part === oldName ? newName : part)).join(", ");
      this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, row.id);
      changed.push(row.id);
    }
    return changed;
  }

  /** Human join-by-mention. Bot callers never call this path (ADR-0005 item 1). */
  addMember(threadId: ThreadId, botId: BotId): NamedMember {
    return this.db.transaction(() => {
      const thread = this.mustGet(threadId);
      const existing = this.member(threadId, botId);
      if (existing) return existing;
      const bot = this.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(botId) as
        | { workspace_id: string }
        | undefined;
      if (!bot) throw new DeskmatesError("not_found", `bot ${botId} not found`, { botId });
      if (bot.workspace_id !== thread.workspaceId) {
        throw new DeskmatesError("validation", `bot ${botId} belongs to another workspace`, {
          botId,
          workspaceId: thread.workspaceId,
        });
      }
      if (thread.kind === "chat" && this.members(threadId).length >= CHAT_THREAD_MAX_MEMBERS) {
        throw new DeskmatesError(
          "validation",
          `a chat thread holds at most ${CHAT_THREAD_MAX_MEMBERS} bots`,
        );
      }
      this.db
        .prepare(
          "INSERT INTO thread_members (thread_id, bot_id, last_seen_seq, joined_at) VALUES (?, ?, 0, ?)",
        )
        .run(threadId, botId, nowIso());
      return this.member(threadId, botId) as NamedMember;
    })();
  }

  /** Operator batch add. Validate the entire request before writing any membership rows. */
  addMembers(threadId: ThreadId, botIds: readonly BotId[]): boolean {
    return this.db.transaction(() => {
      const thread = this.mustGet(threadId);
      if (thread.kind !== "chat") {
        throw new DeskmatesError("validation", "members can only be managed on chat threads");
      }
      const existing = new Set(this.members(threadId).map((member) => member.botId));
      const additions = [...new Set(botIds)].filter((botId) => !existing.has(botId));
      if (existing.size + additions.length > CHAT_THREAD_MAX_MEMBERS) {
        throw new DeskmatesError(
          "validation",
          `a chat thread holds at most ${CHAT_THREAD_MAX_MEMBERS} bots`,
        );
      }
      for (const botId of additions) {
        const bot = this.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(botId) as
          | { workspace_id: string }
          | undefined;
        if (!bot) throw new DeskmatesError("not_found", `bot ${botId} not found`, { botId });
        if (bot.workspace_id !== thread.workspaceId) {
          throw new DeskmatesError("validation", `bot ${botId} belongs to another workspace`, {
            botId,
            workspaceId: thread.workspaceId,
          });
        }
      }
      if (additions.length === 0) return false;
      const insert = this.db.prepare(
        "INSERT INTO thread_members (thread_id, bot_id, last_seen_seq, joined_at) VALUES (?, ?, 0, ?)",
      );
      for (const botId of additions) insert.run(threadId, botId, nowIso());
      this.touch(threadId);
      return true;
    })();
  }

  /** Keep runs and transcript intact. Refuse removal while routing still references this member. */
  removeMember(threadId: ThreadId, botId: BotId): boolean {
    return this.db.transaction(() => {
      const thread = this.mustGet(threadId);
      if (thread.kind !== "chat") {
        throw new DeskmatesError("validation", "members can only be managed on chat threads");
      }
      const members = this.members(threadId);
      if (!members.some((member) => member.botId === botId)) return false;
      if (members.length === 1) {
        throw new DeskmatesError("validation", "a chat thread needs at least one bot");
      }
      const liveRun = this.db
        .prepare(
          `SELECT id FROM runs WHERE thread_id = ? AND bot_id = ?
         AND status IN ('queued', 'running', 'stalled', 'waiting_approval_live', 'waiting_approval', 'waiting_browser', 'waiting_continuation',
           'waiting_platform')
         LIMIT 1`,
        )
        .get(threadId, botId) as { id: string } | undefined;
      const pendingWalk = this.db
        .prepare(
          `SELECT w.message_id FROM thread_routing_walks w
         JOIN thread_routing_walk_members m ON m.message_id = w.message_id
         WHERE w.thread_id = ? AND w.status = 'pending' AND m.bot_id = ?
           AND m.ordinal >= w.next_member_index LIMIT 1`,
        )
        .get(threadId, botId) as { message_id: string } | undefined;
      if (liveRun || pendingWalk) {
        throw new DeskmatesError(
          "invalid_transition",
          "member has unfinished work in this thread",
          {
            threadId,
            botId,
            ...(liveRun ? { runId: liveRun.id } : {}),
            ...(pendingWalk ? { messageId: pendingWalk.message_id } : {}),
          },
        );
      }
      this.db
        .prepare("DELETE FROM thread_members WHERE thread_id = ? AND bot_id = ?")
        .run(threadId, botId);
      // An owner that left owns nothing: the next unaddressed request starts in join order.
      this.db
        .prepare("UPDATE threads SET owner_bot_id = NULL WHERE id = ? AND owner_bot_id = ?")
        .run(threadId, botId);
      // Rejoining starts a fresh SDK session with the complete Gateway transcript.
      this.db
        .prepare("DELETE FROM bot_sessions WHERE thread_id = ? AND bot_id = ?")
        .run(threadId, botId);
      this.touch(threadId);
      return true;
    })();
  }

  /** Names of every bot in the thread's workspace, members or not, by id. */
  workspaceBotNames(threadId: ThreadId): Map<BotId, string> {
    const thread = this.mustGet(threadId);
    const rows = this.db
      .prepare("SELECT id, name FROM bots WHERE workspace_id = ?")
      .all(thread.workspaceId) as { id: string; name: string }[];
    return new Map(rows.map((row) => [row.id as BotId, row.name]));
  }

  /** Resolve a case-insensitive bot name inside the thread's workspace. */
  botByNameInWorkspace(threadId: ThreadId, name: string): BotId | undefined {
    const thread = this.mustGet(threadId);
    const row = this.db
      .prepare("SELECT id FROM bots WHERE workspace_id = ? AND lower(name) = lower(?)")
      .get(thread.workspaceId, name) as { id: string } | undefined;
    return row?.id as BotId | undefined;
  }

  /**
   * Pause the thread (ADR-0005 amendment 3, decision 20): status, reason, causing seq, pause time
   * and, for a turn-budget pause, the resume time, in one update. A thread already paused keeps
   * its pause, except that an operator pause replaces a turn-budget one (which then no longer
   * ends by itself). Returns whether the row changed.
   */
  pause(threadId: ThreadId, pause: ThreadPause): boolean {
    if (pause.reason === "operator" && pause.resumeAt !== undefined)
      throw new DeskmatesError("validation", "an operator pause has no resume time");
    const changed = this.db
      .prepare(
        `UPDATE threads SET status = 'paused', pause_reason = ?, paused_seq = ?, paused_at = ?,
           resume_at = ?, updated_at = ?
         WHERE id = ? AND (status = 'active' OR (? = 'operator' AND pause_reason = 'turn_budget'))`,
      )
      .run(
        pause.reason,
        pause.seq,
        pause.at,
        pause.resumeAt ?? null,
        nowIso(),
        threadId,
        pause.reason,
      ).changes;
    return changed > 0;
  }

  /**
   * End a pause (decisions 22 to 24): clear the reason and resume time and set the thread
   * `active`, and, when `budgetResetSeq` is given, move the budget origin to it, in one update.
   * `only` restricts it to a pause of that reason. Returns whether a pause ended, so two callers
   * racing for the same pause cannot both announce it. The callers are a human message
   * (`ThreadRouter.postHuman`), Resume (`ThreadRouter.operatorResume`) and the reset window
   * (`ThreadRouter.resumeDuePauses`); `thread-unpause-callers.test.ts` keeps it that way.
   */
  resume(
    threadId: ThreadId,
    opts: { budgetResetSeq?: number; only?: ThreadPauseReason } = {},
  ): boolean {
    const only = opts.only ?? null;
    const changed = this.db
      .prepare(
        `UPDATE threads SET status = 'active', pause_reason = NULL, resume_at = NULL,
           budget_reset_seq = max(budget_reset_seq, coalesce(?, budget_reset_seq)), updated_at = ?
         WHERE id = ? AND status = 'paused' AND (? IS NULL OR pause_reason = ?)`,
      )
      .run(opts.budgetResetSeq ?? null, nowIso(), threadId, only, only).changes;
    return changed > 0;
  }

  /** Turn-budget pauses whose reset window ended at or before `now` (rewritten decision 22). */
  duePauses(now: Date): ThreadId[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM threads WHERE resume_at IS NOT NULL AND resume_at <= ?
           AND status = 'paused' AND pause_reason = 'turn_budget' ORDER BY resume_at, id`,
      )
      .all(now.toISOString()) as { id: string }[];
    return rows.map((row) => row.id as ThreadId);
  }

  /** Set or clear the thread's deadline (issue #21); canonical UTC ISO text or `undefined`. */
  setDeadline(threadId: ThreadId, deadline: string | undefined): Thread {
    this.mustGet(threadId);
    this.db
      .prepare("UPDATE threads SET deadline = ?, updated_at = ? WHERE id = ?")
      .run(deadline ?? null, nowIso(), threadId);
    return this.mustGet(threadId);
  }

  /**
   * Record who took the thread's latest unaddressed request (ADR-0005 amendment 2, decision
   * 15). Returns whether the owner changed. Only a member can own; `undefined` clears it.
   */
  setOwner(threadId: ThreadId, botId: BotId | undefined): boolean {
    const thread = this.mustGet(threadId);
    if (thread.ownerBotId === botId) return false;
    if (botId !== undefined && !this.member(threadId, botId)) return false;
    this.db
      .prepare("UPDATE threads SET owner_bot_id = ?, updated_at = ? WHERE id = ?")
      .run(botId ?? null, nowIso(), threadId);
    return true;
  }

  /** Advance the member's high-water mark; never moves backwards (at-least-once delivery). */
  advanceLastSeen(threadId: ThreadId, botId: BotId, seq: number): void {
    this.db
      .prepare(
        "UPDATE thread_members SET last_seen_seq = max(last_seen_seq, ?) WHERE thread_id = ? AND bot_id = ?",
      )
      .run(seq, threadId, botId);
  }

  touch(threadId: ThreadId): void {
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(nowIso(), threadId);
  }
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id as ThreadId,
    workspaceId: row.workspace_id as WorkspaceId,
    kind: row.kind,
    channel: row.channel,
    ...(row.external_key !== null ? { externalKey: row.external_key } : {}),
    ...(row.channel_connection_id ? { channelConnectionId: row.channel_connection_id } : {}),
    ...(row.binding_generation ? { bindingGeneration: row.binding_generation } : {}),
    title: row.title,
    turnBudget: row.turn_budget,
    status: row.status,
    ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}),
    ...(row.pause_reason && row.paused_seq != null ? { pausedSeq: row.paused_seq } : {}),
    ...(row.pause_reason && row.paused_at ? { pausedAt: row.paused_at } : {}),
    ...(row.resume_at ? { resumeAt: row.resume_at } : {}),
    ...(row.budget_reset_seq ? { budgetResetSeq: row.budget_reset_seq } : {}),
    ...(row.owner_bot_id ? { ownerBotId: row.owner_bot_id as BotId } : {}),
    ...(row.deadline ? { deadline: row.deadline } : {}),
    ...(row.opened_by ? { sideChatActor: row.opened_by } : {}),
    ...(row.private_to_user_id ? { privateToUserId: row.private_to_user_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
