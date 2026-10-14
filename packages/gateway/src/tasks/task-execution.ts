// The measured execution side of a task (ADR-0021 amendment 3, decision A3l), read at one Gateway
// instant. Every time here is a Gateway timestamp from the run, submission or delivery rows;
// bot-supplied text or times never become freshness. Declared task state is never derived from
// it: the UI shows the two side by side.

import type {
  BotId,
  IsoTimestamp,
  RunId,
  RunStatus,
  Task,
  TaskExecution,
  TaskExecutionRun,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import type { TaskDispatcher } from "./task-dispatch.js";
import type { TaskStore } from "./tasks.js";

interface RunRow {
  id: string;
  bot_id: string;
  status: RunStatus;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  pending: number;
}

const RUN_COLUMNS = `r.id, r.bot_id, r.status, r.attempt, r.created_at, r.started_at, r.finished_at,
  (SELECT count(*) FROM approvals a WHERE a.run_id = r.id AND a.decision IS NULL) AS pending`;

function toRun(row: RunRow): TaskExecutionRun {
  return {
    id: row.id as RunId,
    botId: row.bot_id as BotId,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at as IsoTimestamp,
    startedAt: row.started_at as IsoTimestamp | null,
    finishedAt: row.finished_at as IsoTimestamp | null,
    pendingApprovals: row.pending,
  };
}

/** The runs one posted submission message woke (thread-scoped, so the thread index serves it). */
export function executionRuns(
  db: GatewayDb,
  ref: { threadId: string; messageId: string },
): TaskExecutionRun[] {
  return (
    db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs r
        WHERE r.thread_id = ? AND r.trigger_kind = 'thread_message' AND r.trigger_ref = ?
        ORDER BY r.created_at, r.id`)
      .all(ref.threadId, ref.messageId) as RunRow[]
  ).map(toRun);
}

/** Runs linked to the task (task_runs), newest first, at most 20. */
function linkedRuns(db: GatewayDb, taskId: string): TaskExecutionRun[] {
  return (
    db
      .prepare(`SELECT ${RUN_COLUMNS} FROM task_runs tr JOIN runs r ON r.id = tr.run_id
        WHERE tr.task_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`)
      .all(taskId) as RunRow[]
  ).map(toRun);
}

export function taskExecution(
  deps: { db: GatewayDb; tasks: TaskStore; dispatcher: TaskDispatcher },
  task: Task,
  now: Date,
): TaskExecution {
  return {
    observedAt: now.toISOString() as IsoTimestamp,
    submissions: deps.dispatcher.list(task.id),
    linkedRuns: linkedRuns(deps.db, task.id),
    deliveries: deps.tasks.deliveries(task.id),
    latestCheckpoint: deps.tasks.latestCheckpoint(task.id),
  };
}
