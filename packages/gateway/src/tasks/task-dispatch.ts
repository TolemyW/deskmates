// The three explicit dispatch acts of ADR-0021 amendment 3 (A3a to A3d): an immediate create, the
// Run action and a due scheduled occurrence. Each writes one keyed `task_submissions` row and
// posts one must-reply human message that mentions the owner bot into the task's execution
// thread; the thread router creates the runs and normal admission decides when they start. No
// other task write reaches this module.

import {
  type BotId,
  DeskmatesError,
  type MessageId,
  TERMINAL_RUN_STATUSES,
  type Task,
  type TaskSubmission,
  type TaskSubmissionDispatch,
  type TaskSubmissionKind,
  type ThreadId,
  type WorkspaceId,
  taskExecutionState,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { PostResult } from "../threads/router.js";
import { executionRuns } from "./task-execution.js";
import {
  MISSED_AFTER_MS,
  type ScheduleRow,
  TASK_SCHEDULE_TICK_MS,
  latestDueOccurrence,
} from "./task-schedule.js";

interface SubmissionRow {
  id: string;
  task_id: string;
  kind: TaskSubmissionKind;
  submission_key: string;
  scope_version: number;
  actor: string;
  dispatch: TaskSubmissionDispatch;
  occurrence_at: string | null;
  thread_id: string | null;
  message_id: string | null;
  created_at: string;
}

export interface SubmitInput {
  workspaceId: WorkspaceId;
  taskId: string;
  kind: TaskSubmissionKind;
  key: string;
  /** `user:<id>`, `human:web`, `service:<id>` or `schedule`. */
  actor: string;
  /** The message author id (`user:<id>`, `web`, `schedule`). */
  authorId: string;
  dispatch?: TaskSubmissionDispatch;
  occurrenceAt?: string;
}

/** What a dispatch did; `publish` sends its events after the caller's transaction commits. */
export interface DispatchResult {
  submission: TaskSubmission;
  task: Task;
  /** True when the key already existed: nothing was written. */
  duplicate: boolean;
  createdThreadId?: ThreadId;
  posted?: PostResult;
}

export class TaskDispatcher {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly kick: () => void,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Read a submission by its key, or undefined. */
  findByKey(taskId: string, key: string): TaskSubmission | undefined {
    const row = this.ctx.db
      .prepare("SELECT * FROM task_submissions WHERE task_id = ? AND submission_key = ?")
      .get(taskId, key) as SubmissionRow | undefined;
    return row ? this.toSubmission(row) : undefined;
  }

  /** Submissions of a task, newest first. */
  list(taskId: string, limit = 20): TaskSubmission[] {
    return (
      this.ctx.db
        .prepare(`SELECT * FROM task_submissions WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(taskId, limit) as SubmissionRow[]
    ).map((row) => this.toSubmission(row));
  }

  /**
   * Write one submission and, when it is `posted`, the message that asks the owner bot to work.
   * Must run inside the caller's transaction; a repeated key returns what exists and writes
   * nothing (A3b).
   */
  submit(input: SubmitInput): DispatchResult {
    const found = this.findByKey(input.taskId, input.key);
    let task = this.ctx.tasks.mustGet(input.workspaceId, input.taskId);
    if (found) return { submission: found, task, duplicate: true };
    if (task.status === "accepted" || task.status === "cancelled")
      throw new DeskmatesError(
        "invalid_transition",
        "A closed task must be reopened before it is run",
        { taskId: task.id, status: task.status },
      );
    const owner = task.ownerBotId;
    if (owner === null)
      throw new DeskmatesError("validation", "Running a task needs a responsible (owner) bot", {
        key: "ownerBotId",
      });
    const dispatch = input.dispatch ?? "posted";
    const id = newId("tsub");
    const at = this.clock().toISOString();
    let threadId: ThreadId | null = null;
    let createdThreadId: ThreadId | undefined;
    if (dispatch === "posted") {
      const existing = this.executionThread(task, owner);
      if (existing) threadId = existing;
      else {
        const thread = this.ctx.threads.create({
          workspaceId: input.workspaceId,
          botIds: [owner],
          title: task.title,
        });
        threadId = thread.id;
        createdThreadId = thread.id;
        task = this.ctx.tasks.appendLinks(task, { threadIds: [thread.id] });
      }
    }
    this.ctx.db
      .prepare(`INSERT INTO task_submissions (id, workspace_id, task_id, kind, submission_key,
        scope_version, actor, dispatch, occurrence_at, thread_id, message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(
        id,
        input.workspaceId,
        task.id,
        input.kind,
        input.key,
        task.scopeVersion,
        input.actor,
        dispatch,
        input.occurrenceAt ?? null,
        threadId,
        at,
      );
    let posted: PostResult | undefined;
    if (threadId !== null) {
      const botName = this.ctx.bots.mustGet(owner).name;
      posted = this.ctx.router.postHuman({
        threadId,
        body: instruction(task, botName, id),
        authorId: input.authorId,
        mustReply: true,
        externalId: `task-submission:${id}`,
      });
      this.ctx.db
        .prepare("UPDATE task_submissions SET message_id = ? WHERE id = ?")
        .run(posted.message.id, id);
      task = this.ctx.tasks.appendLinks(task, { runIds: posted.runs.map((r) => r.id) });
    }
    return {
      submission: this.findByKey(task.id, input.key) as TaskSubmission,
      task,
      duplicate: false,
      ...(createdThreadId ? { createdThreadId } : {}),
      ...(posted ? { posted } : {}),
    };
  }

  /** Events for a committed dispatch, then a scheduling pass. */
  publish(result: DispatchResult): void {
    if (result.duplicate || !result.posted) return;
    const { posted } = result;
    const threadId = posted.message.threadId;
    this.ctx.bus.batch(() => {
      if (result.createdThreadId) this.ctx.bus.publish({ type: "thread_members", threadId });
      if (!posted.duplicate)
        this.ctx.bus.publish({ type: "thread_message", threadId, message: posted.message });
      for (const run of posted.runs) this.ctx.bus.publish({ type: "run_status", threadId, run });
    });
    this.kick();
  }

  /**
   * One pass of the task schedule runner (A3d) for the minute `now` falls in. Each due schedule is
   * handled in its own transaction so one broken task never stops the others.
   */
  tick(now: Date, log: (msg: string, data?: Record<string, unknown>) => void = () => {}): void {
    for (const row of this.ctx.tasks.schedules.due(now)) {
      try {
        const result = this.ctx.db.transaction(() => this.fire(row, now)).immediate();
        if (result) this.publish(result);
      } catch (err) {
        log("task schedule occurrence failed", { taskId: row.task_id, error: String(err) });
      }
    }
  }

  private fire(row: ScheduleRow, now: Date): DispatchResult | undefined {
    const occurrence = latestDueOccurrence(row, now);
    if (occurrence === null) return undefined;
    const late = now.getTime() - new Date(occurrence).getTime() > MISSED_AFTER_MS;
    // Compare and set first: an edit or another tick that got here first wins and nothing fires.
    if (!this.ctx.tasks.schedules.advance(row, now, late ? null : occurrence)) return undefined;
    const workspaceId = row.workspace_id as WorkspaceId;
    let task: Task;
    try {
      task = this.ctx.tasks.mustGet(workspaceId, row.task_id);
    } catch {
      return undefined;
    }
    // A closed task or one without an owner advances its schedule and starts nothing.
    if (task.status === "accepted" || task.status === "cancelled" || task.ownerBotId === null)
      return undefined;
    const dispatch: TaskSubmissionDispatch = late
      ? "missed"
      : this.hasLiveRun(task.id)
        ? "skipped_overlap"
        : "posted";
    return this.submit({
      workspaceId,
      taskId: task.id,
      kind: "scheduled",
      key: `schedule:${row.version}:${occurrence}`,
      actor: "schedule",
      authorId: "schedule",
      dispatch,
      occurrenceAt: occurrence,
    });
  }

  /** Whether a run started by an earlier submission of this task is still live (A3d overlap). */
  private hasLiveRun(taskId: string): boolean {
    const terminal = [...TERMINAL_RUN_STATUSES];
    return (
      this.ctx.db
        .prepare(`SELECT 1 FROM task_submissions s
          JOIN runs r ON r.thread_id = s.thread_id AND r.trigger_ref = s.message_id
          WHERE s.task_id = ? AND r.status NOT IN (${terminal.map(() => "?").join(",")})
          LIMIT 1`)
        .get(taskId, ...terminal) !== undefined
    );
  }

  /** The first linked chat thread the owner is a member of (A3c). */
  private executionThread(task: Task, owner: BotId): ThreadId | undefined {
    for (const threadId of task.threadIds) {
      const thread = this.ctx.threads.get(threadId);
      if (!thread || thread.kind !== "chat") continue;
      if (this.ctx.threads.members(threadId).some((m) => m.botId === owner)) return threadId;
    }
    return undefined;
  }

  private toSubmission(row: SubmissionRow): TaskSubmission {
    const runs =
      row.thread_id !== null && row.message_id !== null
        ? executionRuns(this.ctx.db, { threadId: row.thread_id, messageId: row.message_id })
        : [];
    return {
      id: row.id,
      taskId: row.task_id,
      kind: row.kind,
      key: row.submission_key,
      scopeVersion: row.scope_version,
      actor: row.actor,
      dispatch: row.dispatch,
      occurrenceAt: row.occurrence_at,
      threadId: row.thread_id as ThreadId | null,
      messageId: row.message_id as MessageId | null,
      createdAt: row.created_at,
      runs,
      state: taskExecutionState(row.dispatch, runs),
    };
  }
}

/** The instruction a dispatch posts: who, which task, which submission, and what is asked. */
function instruction(task: Task, botName: string, submissionId: string): string {
  return [
    `@${botName} Please work on task "${task.title}" (task ${task.id}, scope version ${task.scopeVersion}, submission ${submissionId}).`,
    task.description.trim() === "" ? "" : `\n${task.description.trim()}`,
    "\nWhen it is done, deliver it with task_deliver; record progress with task_checkpoint.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Starts the task schedule runner on the next minute boundary; timers are unref'd. */
export class TaskScheduleRunner {
  private startTimer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly dispatcher: TaskDispatcher,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {}

  tick(now: Date = this.clock()): void {
    this.dispatcher.tick(now, this.log);
  }

  start(): void {
    if (this.startTimer || this.interval) return;
    const delay = TASK_SCHEDULE_TICK_MS - (this.clock().getTime() % TASK_SCHEDULE_TICK_MS);
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.safeTick();
      this.interval = setInterval(() => this.safeTick(), TASK_SCHEDULE_TICK_MS);
      this.interval.unref();
    }, delay);
    this.startTimer.unref();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.interval) clearInterval(this.interval);
    this.startTimer = undefined;
    this.interval = undefined;
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (err) {
      this.log("task schedule tick failed", { error: String(err) });
    }
  }
}
