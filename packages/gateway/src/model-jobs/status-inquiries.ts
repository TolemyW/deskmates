// Guest status inquiries (ADR-0022 amendment 7 S1 to S4). A Guest's post in their own private
// inquiry is stored and answered by a tool-free, one-turn model job of the inquiry's bot, never by
// an ordinary run: no router, round, session, memory or tool. The job reads a projection the
// Gateway builds from what the Guest may already read through the API, and its answer is appended
// to the inquiry as the bot's message. The inquiry's private audience (W7) covers the job's run.

import {
  type BotDefinition,
  DeskmatesError,
  type MessageId,
  type RunEnded,
  type Thread,
  type ThreadId,
  type ThreadMessage,
} from "@deskmates/contracts";
import { BoardStore } from "../board/board-store.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { modelsForJob } from "../scheduler/job-models.js";

export const STATUS_INQUIRY = "status_inquiry";

/** S2: how much of each source the projection holds. */
export const PROJECTION_LIMITS = {
  threads: 8,
  messagesPerThread: 3,
  messageChars: 400,
  boardPosts: 5,
  boardChars: 300,
  inquiryMessages: 6,
  inquiryChars: 600,
  total: 12_000,
} as const;

/** S1: what the inquiry shows when the job returns nothing. */
export const NO_STATUS_ANSWER =
  "No status answer came back this time. You can ask again; nothing else was done.";

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Whether `thread` is this person's own private inquiry with one bot. */
export function isOwnInquiry(thread: Thread, userId: string | undefined): boolean {
  return (
    userId !== undefined &&
    thread.kind === "chat" &&
    thread.privateToUserId !== undefined &&
    thread.privateToUserId === userId
  );
}

export class StatusInquiries {
  constructor(private readonly ctx: GatewayContext) {}

  /** The open status job of an inquiry, if any (S3). */
  private open(threadId: ThreadId): RunRecord | undefined {
    const row = this.ctx.db
      .prepare(
        `SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued', 'running')
           AND json_extract(config_json, '$.runType') = ? LIMIT 1`,
      )
      .get(threadId, STATUS_INQUIRY) as { id: string } | undefined;
    return row ? this.ctx.runs.get(row.id as RunRecord["id"]) : undefined;
  }

  /**
   * S1, S3: store the Guest's question and queue its job, in one transaction. A repeated
   * `externalId` returns the stored message and queues nothing; a second question while a job is
   * open is refused and stores nothing.
   */
  ask(input: {
    thread: Thread;
    userId: string;
    authorId: string;
    body: string;
    externalId?: string;
  }): { message: ThreadMessage; runs: RunRecord[]; duplicate?: true } {
    const { ctx } = this;
    const { thread } = input;
    const members = ctx.threads.members(thread.id);
    const botId = members[0]?.botId;
    if (members.length !== 1 || botId === undefined)
      throw new DeskmatesError("invalid_transition", "an inquiry has exactly one bot", {
        threadId: thread.id,
      });
    return ctx.db.transaction(() => {
      if (input.externalId !== undefined) {
        const existing = ctx.messages.findByExternalId(thread.id, input.externalId);
        if (existing) return { message: existing, runs: [], duplicate: true as const };
      }
      if (this.open(thread.id))
        throw new DeskmatesError(
          "invalid_transition",
          "the previous status question is still being answered",
          { reason: "status_inquiry_busy", threadId: thread.id },
        );
      const message = ctx.messages.append({
        threadId: thread.id,
        authorKind: "human",
        authorId: input.authorId,
        body: input.body,
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      });
      const bot = ctx.bots.mustGet(botId);
      const run = ctx.runs.create({
        botId,
        threadId: thread.id,
        lane: "interactive",
        triggerKind: "cron",
        triggerRef: `${STATUS_INQUIRY}:${message.id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...ctx.runConfig(),
          runType: STATUS_INQUIRY,
          inquiryMessageId: message.id,
          requestedBy: `user:${input.userId}`,
          ...modelsForJob(STATUS_INQUIRY, bot.cheapModel ?? ctx.config.cheapModel),
          fallbackModel: null,
          maxTurns: 1,
          statusInquiryVersion: 1,
        },
      });
      return { message, runs: [run] };
    })();
  }

  /** The job the sidecar runs, built when it starts from what the Guest may read now (S2). */
  job(run: RunRecord, bot: BotDefinition) {
    const messageId = run.config.inquiryMessageId;
    const question =
      typeof messageId === "string" ? this.ctx.messages.get(messageId as MessageId) : undefined;
    if (!question || !run.threadId || question.threadId !== run.threadId) return undefined;
    return {
      kind: "status_inquiry" as const,
      botName: bot.name,
      role: bot.role,
      projection: this.projection(bot.workspaceId, run.threadId, question.seq),
      question: question.body,
    };
  }

  /**
   * S2: the workspace's name, its bots, its shared chats (no private chat, no bus thread), the
   * board's visible posts and the inquiry's own recent messages. Nothing about runs, approvals,
   * tasks, files, memory, Knowledge, costs, desktops or SOUL.
   */
  projection(workspaceId: string, inquiryId: ThreadId, questionSeq: number): string {
    const { ctx } = this;
    const L = PROJECTION_LIMITS;
    const workspace = ctx.workspaces.mustGet(workspaceId as Thread["workspaceId"]);
    const bots = ctx.bots.list(workspace.id);
    const botName = new Map(bots.map((b) => [b.id as string, b.name]));
    const author = (m: ThreadMessage) =>
      m.authorKind === "bot"
        ? (botName.get(m.authorId) ?? "a bot")
        : m.authorKind === "human"
          ? "a person"
          : "system";
    const lines: string[] = [
      `As of ${new Date().toISOString()}.`,
      `Workspace: ${workspace.name}`,
      "Bots:",
      ...bots.map((b) => `- ${b.name}: ${b.role.trim() || "(no role given)"}`),
    ];
    const shared = ctx.threads
      .list(workspace.id)
      .filter((t) => t.kind === "chat" && t.privateToUserId === undefined && t.id !== inquiryId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, L.threads);
    lines.push("Shared chats (newest first):");
    if (shared.length === 0) lines.push("- none");
    for (const thread of shared) {
      const members = ctx.threads.members(thread.id).map((m) => botName.get(m.botId) ?? "a bot");
      const title = thread.title ?? members.join(", ");
      lines.push(`- ${title} (bots: ${members.join(", ")}; last update ${thread.updatedAt})`);
      const latest = ctx.messages.maxSeq(thread.id);
      for (const m of ctx.messages.list(thread.id, Math.max(0, latest - L.messagesPerThread)))
        lines.push(`  - ${m.ts} ${author(m)}: ${cut(m.body, L.messageChars)}`);
    }
    const board = new BoardStore(ctx.db).page(workspace.id, {
      limit: L.boardPosts,
      includeHidden: false,
    });
    lines.push("Board (newest first):");
    if (board.posts.length === 0) lines.push("- none");
    for (const post of board.posts)
      lines.push(`- ${post.createdAt}: ${cut(post.body, L.boardChars)}`);
    const earlier = ctx.messages
      .list(inquiryId, Math.max(0, questionSeq - 1 - L.inquiryMessages))
      .filter((m) => m.seq < questionSeq);
    if (earlier.length > 0) {
      lines.push("This inquiry so far:");
      for (const m of earlier)
        lines.push(
          `- ${m.authorKind === "human" ? "guest" : author(m)}: ${cut(m.body, L.inquiryChars)}`,
        );
    }
    return cut(lines.join("\n"), L.total);
  }

  /** S1: append the answer, or the no-answer notice, to the inquiry. Returns the run's status. */
  complete(
    run: RunRecord,
    ended: RunEnded,
    publish: (message: ThreadMessage) => void,
  ): "succeeded" | "failed" {
    const reply = ended.outcome === "completed" ? (ended.summary?.reply ?? "").trim() : "";
    if (run.threadId) {
      const message = this.ctx.messages.append(
        reply
          ? {
              threadId: run.threadId,
              authorKind: "bot",
              authorId: run.botId,
              body: reply,
              runId: run.id,
            }
          : {
              threadId: run.threadId,
              authorKind: "system",
              authorId: "status_inquiry",
              body: NO_STATUS_ANSWER,
              runId: run.id,
            },
      );
      publish(message);
    }
    return reply ? "succeeded" : "failed";
  }
}
