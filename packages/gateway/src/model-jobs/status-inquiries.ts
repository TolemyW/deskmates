// Guest status inquiries (ADR-0022 amendment 7 S1 to S4). A Guest's post in their own private
// inquiry is stored and answered by a tool-free, one-turn model job of the inquiry's bot, never by
// an ordinary run: no router, round, session, memory or tool. The job reads a projection the
// Gateway builds from what the Guest may already read through the API, and its answer is appended
// to the inquiry as the bot's message. The inquiry's private audience (W7) covers the job's run.
// Owner-decided 2026-10-14: the job runs on the default model and the bot's background lane, and
// the projection carries the workspace's task status and progress.

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

export const STATUS_INQUIRY = "status_inquiry";

/** S2: how much of each source the projection holds. */
export const PROJECTION_LIMITS = {
  threads: 8,
  messagesPerThread: 3,
  messageChars: 400,
  boardPosts: 5,
  boardChars: 300,
  tasks: 10,
  taskTitleChars: 160,
  taskTextChars: 240,
  checkpointUnits: 5,
  checkpointChars: 200,
  inquiryMessages: 6,
  inquiryChars: 600,
  total: 14_000,
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
      const run = ctx.runs.create({
        botId,
        threadId: thread.id,
        // Never the interactive lane: a person's chat with the bot is not held by a Guest.
        lane: "background",
        triggerKind: "cron",
        triggerRef: `${STATUS_INQUIRY}:${message.id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...ctx.runConfig(),
          runType: STATUS_INQUIRY,
          inquiryMessageId: message.id,
          requestedBy: `user:${input.userId}`,
          // The default model, frozen now: not the cheap model, not the bot's own override.
          model: ctx.config.defaultModel,
          fallbackModel: null,
          maxTurns: 1,
          statusInquiryVersion: 2,
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
   * board's visible posts, its tasks' status and progress, and the inquiry's own recent messages.
   * Nothing about runs, approvals, files, memory, Knowledge, costs, desktops or SOUL.
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
    lines.push(...this.taskLines(workspace.id, botName));
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

  /**
   * S2 (owner-decided 2026-10-14): the ten most recently updated tasks that are not deleted, each
   * with title, state, owner bot, blocked reason, next action and the summary of its latest
   * checkpoint not recorded in someone's private chat. No description, output, evidence path,
   * delivery or run detail.
   */
  private taskLines(workspaceId: Thread["workspaceId"], botName: Map<string, string>): string[] {
    const L = PROJECTION_LIMITS;
    const { tasks } = this.ctx.tasks.page(workspaceId, {}, 0, L.tasks);
    const lines = ["Tasks (newest first):"];
    if (tasks.length === 0) lines.push("- none");
    const latest = this.ctx.db.prepare(
      `SELECT c.body_json, c.created_at FROM task_checkpoints c
         LEFT JOIN runs r ON r.id = c.run_id
         LEFT JOIN threads t ON t.id = r.thread_id
       WHERE c.task_id = ? AND t.private_to_user_id IS NULL
       ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
    );
    for (const task of tasks) {
      const owner = task.ownerBotId
        ? `owner ${botName.get(task.ownerBotId) ?? "a bot"}`
        : "no owner bot";
      lines.push(
        `- ${cut(task.title, L.taskTitleChars)} (${task.status}; ${owner}; last update ${task.updatedAt})`,
      );
      if (task.status === "blocked" && task.blockedReason.trim())
        lines.push(`  - blocked: ${cut(task.blockedReason, L.taskTextChars)}`);
      if (task.nextAction.trim())
        lines.push(`  - next action: ${cut(task.nextAction, L.taskTextChars)}`);
      const row = latest.get(task.id) as { body_json: string; created_at: string } | undefined;
      if (!row) continue;
      const body = JSON.parse(row.body_json) as {
        completed?: Array<{ unit: string; outcome: string }>;
        outstanding?: string[];
        note?: string;
      };
      lines.push(`  - progress as of ${row.created_at}:`);
      for (const unit of (body.completed ?? []).slice(0, L.checkpointUnits))
        lines.push(
          `    - ${cut(unit.unit, L.checkpointChars)}: ${cut(unit.outcome, L.checkpointChars)}`,
        );
      const outstanding = (body.outstanding ?? []).slice(0, L.checkpointUnits);
      if (outstanding.length > 0)
        lines.push(
          `    - outstanding: ${outstanding.map((o) => cut(o, L.checkpointChars)).join("; ")}`,
        );
      if (body.note?.trim()) lines.push(`    - note: ${cut(body.note, L.taskTextChars)}`);
    }
    return lines;
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
