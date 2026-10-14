// Chat threads, their members and messages, private chats and their handoff activity (ADR-0005,
// ADR-0024).

import type {
  BotId,
  IncomingHandoff,
  RequestedRoundMode,
  Thread,
  ThreadId,
  ThreadMember,
  ThreadMessage,
  ThreadRound,
  ThreadSummary,
  WorkspaceId,
} from "@deskmates/contracts";
import type { RunView, ThreadDetailView } from "../../api/types.js";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface CreateThreadInput {
  workspaceId: WorkspaceId;
  botIds: BotId[];
  title?: string;
}

export interface ChatsApi {
  addThreadMembers(id: ThreadId, botIds: BotId[]): Promise<ThreadDetailView>;
  /** Cancel one request round and its descendants (ADR-0005 amendment 4, decision 34). */
  cancelRound(id: ThreadId, messageId: string): Promise<{ round?: ThreadRound }>;
  createThread(input: CreateThreadInput): Promise<{ thread: Thread; members: ThreadMember[] }>;
  getThread(id: ThreadId): Promise<ThreadDetailView>;
  /** Incoming handoffs newest first, 20 per page; `nextCursor` loads older (#113 slice CH). */
  listHandoffs(
    threadId: ThreadId,
    cursor?: string,
  ): Promise<{ handoffs: IncomingHandoff[]; nextCursor?: string }>;
  listMessages(id: ThreadId, afterSeq?: number): Promise<ThreadMessage[]>;
  /**
   * A bounded slice of a transcript (#113 slice CH): the newest window (or the one before
   * `beforeSeq`) with `hasOlder`, or the tail after `afterSeq` with `hasMore`.
   */
  listMessageSlice(
    id: ThreadId,
    slice?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<{ messages: ThreadMessage[]; hasOlder?: boolean; hasMore?: boolean }>;
  /** The newest request rounds of a thread, newest first (ADR-0005 amendment 4). */
  listRounds(id: ThreadId, limit?: number): Promise<ThreadRound[]>;
  listThreads(workspaceId?: WorkspaceId): Promise<ThreadSummary[]>;
  /**
   * One page of a workspace's chat rail (#113 slice CH): the first page holds its pins and
   * inboxes plus the most recently updated conversations; `nextCursor` continues with older ones.
   */
  listThreadPage(
    workspaceId: WorkspaceId,
    page?: { cursor?: string; limit?: number; q?: string },
  ): Promise<{ threads: ThreadSummary[]; nextCursor?: string }>;
  pinThread(
    id: ThreadId,
  ): Promise<{ workspaceId: WorkspaceId; threadId: ThreadId; position: number }>;
  postMessage(
    id: ThreadId,
    body: string,
    authorId?: string,
    roundMode?: RequestedRoundMode,
  ): Promise<{ message: ThreadMessage; runs: RunView[] }>;
  readHandoffs(threadId: ThreadId, through: number): Promise<void>;
  removeThreadMember(id: ThreadId, botId: BotId): Promise<ThreadDetailView>;
  resolvePrivateChat(botId: BotId): Promise<ThreadDetailView>;
  retryBotWelcome(botId: BotId): Promise<{ run: RunView; thread: Thread }>;
  /** Retry a failed member of a round (decision 35); a live retry is returned as it is. */
  retryRoundMember(
    id: ThreadId,
    messageId: string,
    botId: BotId,
  ): Promise<{ run: RunView; round?: ThreadRound }>;
  unpinThread(id: ThreadId): Promise<void>;
}

/** Conversations per chat rail page besides pins and inboxes (#113 slice CH, plan row 24). */
export const THREAD_RAIL_PAGE = 50;

export function createChatsApi(t: HttpTransport): ChatsApi {
  return {
    addThreadMembers(id, botIds) {
      return t.json("POST", `/api/threads/${encodeURIComponent(id)}/members`, { botIds });
    },
    cancelRound(id, messageId) {
      return t.json(
        "POST",
        `/api/threads/${encodeURIComponent(id)}/rounds/${encodeURIComponent(messageId)}/cancel`,
        {},
      );
    },
    createThread(input) {
      return t.json("POST", "/api/threads", stripUndefined(input));
    },
    getThread(id) {
      return t.json("GET", `/api/threads/${encodeURIComponent(id)}`);
    },
    listHandoffs(threadId, cursor) {
      return t.json(
        "GET",
        `/api/threads/${encodeURIComponent(threadId)}/activity${query({ cursor })}`,
      );
    },
    async listMessages(id, afterSeq) {
      const r = await t.json<{ messages: ThreadMessage[] }>(
        "GET",
        `/api/threads/${encodeURIComponent(id)}/messages${query({ afterSeq })}`,
      );
      return r.messages;
    },
    listMessageSlice(id, slice = {}) {
      return t.json(
        "GET",
        `/api/threads/${encodeURIComponent(id)}/messages${query({
          afterSeq: slice.afterSeq,
          beforeSeq: slice.beforeSeq,
          limit: slice.limit,
        })}`,
      );
    },
    async listRounds(id, limit) {
      const r = await t.json<{ rounds: ThreadRound[] }>(
        "GET",
        `/api/threads/${encodeURIComponent(id)}/rounds${query({ limit })}`,
      );
      return r.rounds;
    },
    async listThreads(workspaceId) {
      const r = await t.json<{ threads: ThreadSummary[] }>(
        "GET",
        `/api/threads${query({ workspaceId })}`,
      );
      return r.threads;
    },
    listThreadPage(workspaceId, page = {}) {
      return t.json(
        "GET",
        `/api/threads${query({
          workspaceId,
          limit: page.limit ?? THREAD_RAIL_PAGE,
          cursor: page.cursor,
          q: page.q,
        })}`,
      );
    },
    async pinThread(id) {
      const result = await t.json<{
        pin: { workspaceId: WorkspaceId; threadId: ThreadId; position: number };
      }>("POST", `/api/threads/${encodeURIComponent(id)}/pin`, {});
      return result.pin;
    },
    postMessage(id, body, authorId, roundMode) {
      return t.json(
        "POST",
        `/api/threads/${encodeURIComponent(id)}/messages`,
        stripUndefined({ body, authorId, roundMode }),
      );
    },
    async readHandoffs(threadId, through) {
      await t.json("POST", `/api/threads/${encodeURIComponent(threadId)}/activity/read`, {
        through,
      });
    },
    removeThreadMember(id, botId) {
      return t.json(
        "DELETE",
        `/api/threads/${encodeURIComponent(id)}/members/${encodeURIComponent(botId)}`,
      );
    },
    resolvePrivateChat(botId) {
      return t.json("POST", `/api/bots/${encodeURIComponent(botId)}/private-chat`, {});
    },
    retryBotWelcome(botId) {
      return t.json("POST", `/api/bots/${encodeURIComponent(botId)}/welcome`, {});
    },
    retryRoundMember(id, messageId, botId) {
      return t.json(
        "POST",
        `/api/threads/${encodeURIComponent(id)}/rounds/${encodeURIComponent(messageId)}/members/${encodeURIComponent(botId)}/retry`,
        {},
      );
    },
    async unpinThread(id) {
      await t.json("DELETE", `/api/threads/${encodeURIComponent(id)}/pin`);
    },
  };
}
