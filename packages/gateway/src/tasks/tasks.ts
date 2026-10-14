// Durable operator work tracking. Task writes never reach the scheduler or a sandbox; the three
// explicit dispatch acts of ADR-0021 amendment 3 live in `task-dispatch.ts`.
import {
  type BotId,
  type DeliverableTask,
  DeskmatesError,
  type RunId,
  TASK_STATUSES,
  type Task,
  type TaskArtifact,
  type TaskCheckpoint,
  type TaskCheckpointDigest,
  type TaskDeliverRequest,
  type TaskDelivery,
  type TaskJson,
  type TaskOutputSchema,
  type TaskScheduleInput,
  type TaskStatus,
  type ThreadId,
  type WorkspaceId,
  deliveredByBot,
  workspaceFileRoot,
} from "@deskmates/contracts";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { publishVerifiedFiles } from "../files/file-publications.js";
import type { VerifiedFile } from "../files/file-verification.js";
import { outputErrors } from "./output-schema.js";
import { TaskSchedules } from "./task-schedule.js";
import {
  TASK_LIMITS,
  acceptTaskVersion,
  checkpointInput,
  createTaskInput,
  taskVersion,
  updateTaskInput,
} from "./validate.js";

/** Operator labels a delivery or acceptance may record (ADR-0022 P1). */
const OPERATOR_LABEL = /^(human:web|user:[A-Za-z0-9_]+)$/;

/** States a bot may deliver from; accepted and cancelled must be reopened by an operator. */
const DELIVERABLE: readonly TaskStatus[] = ["planned", "in_progress", "blocked", "delivered"];

/** How many linked tasks a start request names; the delivery route re-checks the link anyway. */
const DELIVERABLE_LIMIT = 20;

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  owner_bot_id: string | null;
  status: TaskStatus;
  blocked_reason: string;
  next_action: string;
  version: number;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  delivered_by: string | null;
  output_schema_json: string | null;
  output_json: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  scope_version: number;
  deleted_at: string | null;
}

interface DeliveryRow {
  id: string;
  kind: "complete" | "partial";
  run_id: string | null;
  attempt: number;
  delivered_by: string;
  scope_version: number;
  summary: string;
  outstanding_json: string;
  created_at: string;
}

interface CheckpointRow {
  id: string;
  task_id: string;
  run_id: string | null;
  attempt: number;
  bot_id: string | null;
  body_json: string;
  created_at: string;
}

/** What a run's delivery is about to touch; checked again inside the write transaction. */
export interface DeliveryScope {
  workspaceId: WorkspaceId;
  botId: BotId;
  task: Task;
}

export class TaskStore {
  readonly schedules: TaskSchedules;

  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
    defaultTimeZone?: string,
  ) {
    this.schedules = new TaskSchedules(db, clock, defaultTimeZone ?? "UTC");
  }

  list(workspaceId: WorkspaceId): Task[] {
    this.requireWorkspace(workspaceId);
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC, rowid DESC`)
        .all(workspaceId) as TaskRow[]
    ).map((row) => this.load(row));
  }

  /**
   * One page of the workspace's tasks, most recently updated first (`updated_at DESC, rowid
   * DESC`), filtered on the server by status and by a search over the title and the owner bot's
   * name, with the honest total under that filter (#113). Indexed by `tasks_workspace_updated`
   * and `tasks_workspace_status`.
   */
  page(
    workspaceId: WorkspaceId,
    filter: { status?: TaskStatus; q?: string },
    offset: number,
    limit: number,
  ): { tasks: Task[]; total: number } {
    this.requireWorkspace(workspaceId);
    const conditions = ["workspace_id = ?", "deleted_at IS NULL"];
    const params: (string | number)[] = [workspaceId];
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const q = filter.q?.trim();
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(`(title LIKE ? ESCAPE '\\' OR owner_bot_id IN (
        SELECT id FROM bots WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\'))`);
      params.push(pattern, workspaceId, pattern);
    }
    const where = conditions.join(" AND ");
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tasks WHERE ${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TaskRow[];
    return { tasks: rows.map((row) => this.load(row)), total };
  }

  /** Every task of the workspace that is not deleted, counted by status (#113). */
  statusCounts(workspaceId: WorkspaceId): Record<TaskStatus, number> {
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
      TaskStatus,
      number
    >;
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM tasks
         WHERE workspace_id = ? AND deleted_at IS NULL GROUP BY status`,
      )
      .all(workspaceId) as { status: TaskStatus; count: number }[];
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /** A task that is not deleted (ADR-0021 A3e); a deleted one is not found. */
  mustGet(workspaceId: WorkspaceId, id: string): Task {
    this.requireWorkspace(workspaceId);
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL")
      .get(workspaceId, id) as TaskRow | undefined;
    if (!row)
      throw new DeskmatesError("not_found", "Task not found in this workspace", { taskId: id });
    return this.load(row);
  }

  /** The task a create key made, deleted or not (ADR-0021 A3b). */
  findByCreateKey(workspaceId: WorkspaceId, key: string): { id: string; deleted: boolean } | null {
    const row = this.db
      .prepare("SELECT id, deleted_at FROM tasks WHERE workspace_id = ? AND create_key = ?")
      .get(workspaceId, key) as { id: string; deleted_at: string | null } | undefined;
    return row ? { id: row.id, deleted: row.deleted_at !== null } : null;
  }

  /** The oldest task linked to a thread, for a submission found by its key (issue #21). */
  firstLinkedToThread(workspaceId: WorkspaceId, threadId: ThreadId): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ?
        AND id IN (SELECT task_id FROM task_threads WHERE thread_id = ?)
        ORDER BY created_at, rowid LIMIT 1`)
      .get(workspaceId, threadId) as TaskRow | undefined;
    return row ? this.load(row) : undefined;
  }

  /** A task row with its links, which live in task_threads, task_runs and task_artifacts. */
  private load(row: TaskRow): Task {
    const threadIds = (
      this.db
        .prepare("SELECT thread_id FROM task_threads WHERE task_id = ? ORDER BY ordinal")
        .all(row.id) as Array<{ thread_id: string }>
    ).map((r) => r.thread_id as ThreadId);
    const runIds = (
      this.db
        .prepare("SELECT run_id FROM task_runs WHERE task_id = ? ORDER BY ordinal")
        .all(row.id) as Array<{ run_id: string }>
    ).map((r) => r.run_id as RunId);
    const artifacts = (
      this.db
        .prepare(
          "SELECT label, path, run_id FROM task_artifacts WHERE task_id = ? ORDER BY ordinal",
        )
        .all(row.id) as Array<{ label: string; path: string; run_id: string | null }>
    ).map(
      (a): TaskArtifact => ({
        label: a.label,
        path: a.path,
        ...(a.run_id === null ? {} : { runId: a.run_id as RunId }),
      }),
    );
    return toTask(row, { threadIds, runIds, artifacts }, this.schedules.get(row.id));
  }

  /** Replaces a task's links with the ones the task lists, in its order. */
  private writeLinks(task: Task): void {
    for (const table of ["task_threads", "task_runs", "task_artifacts"])
      this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(task.id);
    const thread = this.db.prepare(
      "INSERT INTO task_threads (task_id, ordinal, thread_id) VALUES (?, ?, ?)",
    );
    task.threadIds.forEach((id, i) => thread.run(task.id, i, id));
    const run = this.db.prepare(
      "INSERT INTO task_runs (task_id, ordinal, run_id) VALUES (?, ?, ?)",
    );
    task.runIds.forEach((id, i) => run.run(task.id, i, id));
    const artifact = this.db.prepare(
      "INSERT INTO task_artifacts (task_id, ordinal, path, label, run_id) VALUES (?, ?, ?, ?, ?)",
    );
    task.artifacts.forEach((a, i) => artifact.run(task.id, i, a.path, a.label, a.runId ?? null));
  }

  /**
   * Save a task. `createKey` makes a repeated create find this row instead of writing another;
   * `schedule` saves its trigger in the same transaction. Neither dispatches anything.
   */
  create(
    workspaceId: WorkspaceId,
    raw: unknown,
    opts: { createKey?: string; schedule?: TaskScheduleInput } = {},
  ): Task {
    const input = createTaskInput(raw);
    return this.db
      .transaction(() => {
        this.requireWorkspace(workspaceId);
        const at = this.clock().toISOString();
        const task: Task = {
          id: newId("task"),
          workspaceId,
          title: input.title,
          description: input.description ?? "",
          ownerBotId: input.ownerBotId ?? null,
          status: "planned",
          blockedReason: "",
          nextAction: "",
          threadIds: input.threadIds ?? [],
          runIds: input.runIds ?? [],
          artifacts: input.artifacts ?? [],
          version: 1,
          createdAt: at,
          updatedAt: at,
          deliveredAt: null,
          deliveredBy: null,
          outputSchema: input.outputSchema ?? null,
          output: null,
          acceptedAt: null,
          acceptedBy: null,
          scopeVersion: 1,
          schedule: null,
        };
        this.validateReferences(task);
        this.db
          .prepare(`INSERT INTO tasks (id, workspace_id, title, description, owner_bot_id, status,
        blocked_reason, next_action, version, created_at, updated_at, delivered_at, accepted_at,
        accepted_by, delivered_by, output_schema_json, output_json, scope_version, create_key)
        VALUES (@id, @workspaceId, @title, @description, @ownerBotId, @status,
        @blockedReason, @nextAction, @version, @createdAt, @updatedAt, @deliveredAt, @acceptedAt,
        @acceptedBy, @deliveredBy, @outputSchema, @output, @scopeVersion, @createKey)`)
          .run({ ...bindings(task), createKey: opts.createKey ?? null });
        this.writeLinks(task);
        if (opts.schedule) this.schedules.set(workspaceId, task.id, opts.schedule);
        return this.mustGet(workspaceId, task.id);
      })
      .immediate();
  }

  /**
   * `actor` is the authenticated operator (`user:<id>` or `human:web`); it becomes `deliveredBy`
   * when this edit is the one that declares delivery. An edit that keeps a task delivered keeps
   * its original deliverer; one that leaves `delivered` clears every delivery fact. A schedule in
   * the body is an explicit schedule change (A3d), never a rerun.
   */
  update(workspaceId: WorkspaceId, id: string, raw: unknown, actor = "human:web"): Task {
    if (!OPERATOR_LABEL.test(actor))
      throw new DeskmatesError("validation", "an edit needs an authenticated operator label");
    const { schedule, ...input } = updateTaskInput(raw);
    return this.db
      .transaction(() => {
        const current = this.mustGet(workspaceId, id);
        this.checkVersion(current, input.version);
        const reopening = input.status === "planned" || input.status === "in_progress";
        if ((current.status === "accepted" || current.status === "cancelled") && !reopening) {
          throw new DeskmatesError(
            "invalid_transition",
            "A closed task must be reopened to planned or in_progress before editing",
          );
        }
        const next: Task = {
          ...current,
          ...input,
          version: current.version + 1,
          updatedAt: this.clock().toISOString(),
        };
        if (next.status === "blocked" && (!next.blockedReason.trim() || !next.nextAction.trim())) {
          throw new DeskmatesError(
            "validation",
            "A blocked task requires blockedReason and nextAction",
          );
        }
        // An operator declaring delivery names an artifact; a bot's non-file delivery (A3g) that
        // is already delivered stays editable.
        if (
          next.status === "delivered" &&
          next.artifacts.length === 0 &&
          (current.status !== "delivered" || current.artifacts.length > 0)
        ) {
          throw new DeskmatesError(
            "validation",
            "A delivered task requires at least one artifact reference",
          );
        }
        // A3f: only a change of what is asked moves the scope; links and state do not.
        const scopeChanged =
          next.title !== current.title ||
          next.description !== current.description ||
          JSON.stringify(next.outputSchema) !== JSON.stringify(current.outputSchema);
        next.scopeVersion = current.scopeVersion + (scopeChanged ? 1 : 0);
        // Delivery is an operator declaration about references, never a read or immutable snapshot.
        const stillDelivered = next.status === "delivered" && current.status === "delivered";
        next.deliveredAt =
          next.status === "delivered" ? (current.deliveredAt ?? next.updatedAt) : null;
        next.deliveredBy =
          next.status === "delivered" ? (stillDelivered ? current.deliveredBy : actor) : null;
        next.output = stillDelivered ? current.output : null;
        next.acceptedAt = null;
        next.acceptedBy = null;
        this.validateReferences(next);
        this.write(next, input.version);
        if (schedule !== undefined) this.schedules.set(workspaceId, id, schedule);
        return this.mustGet(workspaceId, id);
      })
      .immediate();
  }

  /**
   * ADR-0021 A3e: mark the task deleted and disable its schedule. Links, submissions, deliveries,
   * publications, checkpoints, threads and runs stay; admitted runs are neither cancelled nor
   * resumed. Call inside the route's transaction so the audit row commits with it.
   */
  softDelete(workspaceId: WorkspaceId, id: string, raw: unknown, actor: string): Task {
    const version = acceptTaskVersion(raw);
    const current = this.mustGet(workspaceId, id);
    this.checkVersion(current, version);
    const at = this.clock().toISOString();
    const result = this.db
      .prepare(`UPDATE tasks SET deleted_at = ?, deleted_by = ?, version = version + 1,
        updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ? AND deleted_at IS NULL`)
      .run(at, actor, at, id, workspaceId, version);
    if (result.changes !== 1)
      throw new DeskmatesError("invalid_transition", "Task changed; reload before editing", {
        reason: "version_conflict",
      });
    this.schedules.set(workspaceId, id, null);
    return { ...current, version: version + 1, updatedAt: at, schedule: null };
  }

  /** Append thread and run links made by a dispatch; advances the version like any change. */
  appendLinks(task: Task, links: { threadIds?: ThreadId[]; runIds?: RunId[] }): Task {
    const threadIds = [...task.threadIds];
    for (const id of links.threadIds ?? []) if (!threadIds.includes(id)) threadIds.push(id);
    const runIds = [...task.runIds];
    for (const id of links.runIds ?? []) if (!runIds.includes(id)) runIds.push(id);
    if (threadIds.length === task.threadIds.length && runIds.length === task.runIds.length)
      return task;
    const next: Task = {
      ...task,
      threadIds: threadIds.slice(-TASK_LIMITS.references),
      runIds: runIds.slice(-TASK_LIMITS.references),
      version: task.version + 1,
      updatedAt: this.clock().toISOString(),
    };
    this.write(next, task.version);
    return this.mustGet(task.workspaceId, task.id);
  }

  /**
   * `acceptedBy` is the authenticated actor: `user:<id>` for a signed-in person, or the shared
   * operator credential's historical `human:web` label (ADR-0022 P1, ADR-0021).
   */
  accept(workspaceId: WorkspaceId, id: string, raw: unknown, acceptedBy: string): Task {
    if (acceptedBy !== "human:web" && !/^user:[A-Za-z0-9_]+$/.test(acceptedBy))
      throw new DeskmatesError("validation", "acceptance needs an authenticated actor");
    const version = acceptTaskVersion(raw);
    return this.db
      .transaction(() => {
        const current = this.mustGet(workspaceId, id);
        this.checkVersion(current, version);
        if (current.status !== "delivered")
          throw new DeskmatesError("invalid_transition", "Only a delivered task can be accepted");
        this.validateReferences(current);
        const at = this.clock().toISOString();
        this.write(
          {
            ...current,
            status: "accepted",
            version: version + 1,
            updatedAt: at,
            acceptedAt: at,
            acceptedBy,
          },
          version,
        );
        return this.mustGet(workspaceId, id);
      })
      .immediate();
  }

  /**
   * Everything about a run's `task_deliver` that needs no workspace read (ADR-0021 amendment 2,
   * A3f, A3g): the task is in the run's workspace (else not found) and linked to the run or its
   * thread (else forbidden), open, at the scope the run was given, the output fits the schema of
   * a complete delivery, and every path passes the lexical policy. Run before verification and
   * again inside the write transaction.
   */
  deliveryScope(runId: RunId, input: TaskDeliverRequest): DeliveryScope {
    const run = this.runScope(runId);
    const current = this.mustGet(run.workspaceId, input.taskId);
    const linked =
      current.runIds.includes(runId) ||
      (run.threadId !== null && current.threadIds.includes(run.threadId));
    if (!linked)
      throw new DeskmatesError(
        "forbidden",
        "This run is not linked to the task or to one of its threads; an operator links work",
        { taskId: current.id, runId },
      );
    if (!DELIVERABLE.includes(current.status))
      throw new DeskmatesError(
        "invalid_transition",
        "An accepted or cancelled task must be reopened by an operator before delivery",
        { taskId: current.id, status: current.status },
      );
    if (input.scopeVersion !== undefined && input.scopeVersion !== current.scopeVersion)
      throw new DeskmatesError(
        "invalid_transition",
        "The task's scope changed since this run was given it; re-read the task before delivering",
        {
          taskId: current.id,
          reason: "stale_scope",
          scopeVersion: input.scopeVersion,
          currentScopeVersion: current.scopeVersion,
        },
      );
    const complete = (input.outstanding ?? []).length === 0;
    if (current.outputSchema !== null && (complete || input.output !== undefined)) {
      const errors =
        input.output === undefined
          ? ["output: required by the task's outputSchema"]
          : outputErrors(current.outputSchema, input.output);
      if (errors.length > 0)
        throw new DeskmatesError(
          "validation",
          "The output does not match the task's outputSchema",
          {
            errors,
          },
        );
    }
    const botNames = this.botNames(run.workspaceId);
    const unsafe = input.artifacts.filter((a) => workspaceFileRoot(a.path, botNames) === undefined);
    if (unsafe.length > 0)
      throw new DeskmatesError(
        "forbidden",
        "Artifact paths must be under /work/ or /home/<bot>/ of this workspace",
        { errors: unsafe.map((a) => `${a.path}: forbidden`) },
      );
    return { workspaceId: run.workspaceId, botId: run.botId, task: current };
  }

  /**
   * A bot's formal delivery (ADR-0021 A3g, ADR-0014 A4). `verified` holds the server's check of
   * every artifact; the caller verified them after `deliveryScope` and before this transaction.
   * Complete: the task moves to `delivered`. Partial: a planned task moves to `in_progress` and is
   * never delivered. Verified artifacts are published idempotently either way.
   */
  deliver(
    runId: RunId,
    input: TaskDeliverRequest,
    verified: ReadonlyMap<string, VerifiedFile>,
  ): { task: Task; delivery: TaskDelivery } {
    return this.db
      .transaction(() => {
        const { workspaceId, botId, task: current } = this.deliveryScope(runId, input);
        for (const a of input.artifacts)
          if (!verified.has(a.path))
            throw new DeskmatesError("validation", "An artifact was not verified", {
              errors: [`${a.path}: not verified`],
            });
        const outstanding = input.outstanding ?? [];
        const kind = outstanding.length === 0 ? "complete" : "partial";
        const stamped = new Map(
          input.artifacts.map((a) => [a.path, { label: a.label, path: a.path, runId }] as const),
        );
        const artifacts: TaskArtifact[] = [
          ...current.artifacts.filter((a) => !stamped.has(a.path)),
          ...stamped.values(),
        ];
        const runIds = current.runIds.includes(runId) ? current.runIds : [...current.runIds, runId];
        if (artifacts.length > TASK_LIMITS.artifacts || runIds.length > TASK_LIMITS.references)
          throw new DeskmatesError(
            "validation",
            `A task holds at most ${TASK_LIMITS.artifacts} artifacts and ${TASK_LIMITS.references} runs`,
          );
        const at = this.clock().toISOString();
        const deliveredBy = deliveredByBot(botId);
        const next: Task =
          kind === "complete"
            ? {
                ...current,
                status: "delivered",
                artifacts,
                runIds,
                version: current.version + 1,
                updatedAt: at,
                deliveredAt: at,
                deliveredBy,
                output: input.output ?? null,
                acceptedAt: null,
                acceptedBy: null,
              }
            : {
                ...current,
                status: current.status === "planned" ? "in_progress" : current.status,
                artifacts,
                runIds,
                version: current.version + 1,
                updatedAt: at,
              };
        this.validateReferences(next);
        this.write(next, current.version);
        const attempt =
          (
            this.db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId) as
              | { attempt: number }
              | undefined
          )?.attempt ?? 1;
        const deliveryId = newId("tdl");
        this.db
          .prepare(`INSERT INTO task_deliveries (id, workspace_id, task_id, run_id, attempt,
            delivered_by, scope_version, kind, summary, outstanding_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            deliveryId,
            workspaceId,
            current.id,
            runId,
            attempt,
            deliveredBy,
            current.scopeVersion,
            kind,
            input.summary,
            JSON.stringify(outstanding),
            at,
          );
        publishVerifiedFiles(this.db, {
          workspaceId,
          taskId: current.id,
          deliveryId,
          runId,
          botId,
          scopeVersion: current.scopeVersion,
          publishedAt: at,
          files: input.artifacts.map((a) => ({
            label: a.label,
            ...(verified.get(a.path) as VerifiedFile),
          })),
        });
        return {
          task: this.mustGet(workspaceId, current.id),
          delivery: this.deliveries(current.id).find((d) => d.id === deliveryId) as TaskDelivery,
        };
      })
      .immediate();
  }

  /** Deliveries of a task, newest first, each with what it published. */
  deliveries(taskId: string, limit = 20): TaskDelivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_deliveries WHERE task_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(taskId, limit) as DeliveryRow[];
    const files = this.db.prepare(`SELECT path, label, size_bytes, sha256, checked_at
      FROM file_publications WHERE delivery_id = ? ORDER BY path`);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      runId: row.run_id as RunId | null,
      attempt: row.attempt,
      deliveredBy: row.delivered_by,
      scopeVersion: row.scope_version,
      summary: row.summary,
      outstanding: JSON.parse(row.outstanding_json) as string[],
      createdAt: row.created_at,
      publications: (
        files.all(row.id) as Array<{
          path: string;
          label: string;
          size_bytes: number;
          sha256: string;
          checked_at: string;
        }>
      ).map((f) => ({
        path: f.path,
        label: f.label,
        sizeBytes: f.size_bytes,
        sha256: f.sha256,
        checkedAt: f.checked_at,
      })),
    }));
  }

  /**
   * `task_checkpoint` (ADR-0021 A3h). Run, attempt and bot come from the run row; evidence paths
   * get the lexical policy and are stored as pointers. No task state changes; nothing is published.
   */
  recordCheckpoint(runId: RunId, raw: unknown): TaskCheckpoint {
    const input = checkpointInput(raw);
    return this.db
      .transaction(() => {
        const run = this.runScope(runId);
        const task = this.mustGet(run.workspaceId, input.taskId);
        const linked =
          task.runIds.includes(runId) ||
          (run.threadId !== null && task.threadIds.includes(run.threadId));
        if (!linked)
          throw new DeskmatesError(
            "forbidden",
            "This run is not linked to the task or to one of its threads",
            { taskId: task.id, runId },
          );
        const botNames = this.botNames(run.workspaceId);
        const unsafe = input.completed
          .flatMap((u) => u.evidence)
          .filter((path) => workspaceFileRoot(path, botNames) === undefined);
        if (unsafe.length > 0)
          throw new DeskmatesError(
            "forbidden",
            "Evidence paths must be under /work/ or /home/<bot>/ of this workspace",
            { errors: unsafe.map((path) => `${path}: forbidden`) },
          );
        const attempt =
          (
            this.db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId) as
              | { attempt: number }
              | undefined
          )?.attempt ?? 1;
        const id = newId("tck");
        const at = this.clock().toISOString();
        this.db
          .prepare(`INSERT INTO task_checkpoints (id, workspace_id, task_id, run_id, attempt,
            bot_id, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            run.workspaceId,
            task.id,
            runId,
            attempt,
            run.botId,
            JSON.stringify({
              completed: input.completed,
              outstanding: input.outstanding ?? [],
              note: input.note ?? "",
            }),
            at,
          );
        return this.latestCheckpoint(task.id) as TaskCheckpoint;
      })
      .immediate();
  }

  latestCheckpoint(taskId: string): TaskCheckpoint | null {
    const row = this.db
      .prepare(`SELECT * FROM task_checkpoints WHERE task_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(taskId) as CheckpointRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.body_json) as Pick<
      TaskCheckpoint,
      "completed" | "outstanding" | "note"
    >;
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id as RunId | null,
      attempt: row.attempt,
      botId: row.bot_id as BotId | null,
      completed: body.completed,
      outstanding: body.outstanding,
      note: body.note,
      createdAt: row.created_at,
    };
  }

  /** Open tasks linked to the run or its thread, newest first: what `task_deliver` may name. */
  deliverableFor(runId: RunId): DeliverableTask[] {
    const rows = this.db
      .prepare(`SELECT t.* FROM runs r
        JOIN tasks t ON t.workspace_id = r.workspace_id
        WHERE r.id = ? AND t.deleted_at IS NULL
          AND t.status IN (${DELIVERABLE.map(() => "?").join(",")})
          AND (EXISTS (SELECT 1 FROM task_runs tr WHERE tr.task_id = t.id AND tr.run_id = r.id)
            OR (r.thread_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM task_threads tt
                WHERE tt.task_id = t.id AND tt.thread_id = r.thread_id)))
        ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`)
      .all(runId, ...DELIVERABLE, DELIVERABLE_LIMIT) as TaskRow[];
    return rows
      .map((row) => this.load(row))
      .map((task) => {
        const checkpoint = this.latestCheckpoint(task.id);
        const digest: TaskCheckpointDigest | undefined = checkpoint
          ? {
              runId: checkpoint.runId,
              attempt: checkpoint.attempt,
              createdAt: checkpoint.createdAt,
              completed: checkpoint.completed,
              outstanding: checkpoint.outstanding,
            }
          : undefined;
        return {
          id: task.id,
          title: task.title,
          ...(task.outputSchema === null ? {} : { outputSchema: task.outputSchema }),
          scopeVersion: task.scopeVersion,
          ...(digest ? { latestCheckpoint: digest } : {}),
        };
      });
  }

  private runScope(runId: RunId): {
    botId: BotId;
    threadId: ThreadId | null;
    workspaceId: WorkspaceId;
  } {
    const row = this.db
      .prepare("SELECT bot_id, thread_id, workspace_id FROM runs WHERE id = ?")
      .get(runId) as { bot_id: string; thread_id: string | null; workspace_id: string } | undefined;
    if (!row) throw new DeskmatesError("not_found", "Run not found", { runId });
    return {
      botId: row.bot_id as BotId,
      threadId: row.thread_id as ThreadId | null,
      workspaceId: row.workspace_id as WorkspaceId,
    };
  }

  private botNames(workspaceId: WorkspaceId): string[] {
    return (
      this.db.prepare("SELECT name FROM bots WHERE workspace_id = ?").all(workspaceId) as {
        name: string;
      }[]
    ).map((b) => b.name);
  }

  private requireWorkspace(id: WorkspaceId): void {
    if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id))
      throw new DeskmatesError("not_found", "Workspace not found", { workspaceId: id });
  }

  checkVersion(current: Task, expected: number): void {
    taskVersion(expected);
    if (current.version !== expected)
      throw new DeskmatesError("invalid_transition", "Task changed; reload before editing", {
        reason: "version_conflict",
        expectedVersion: expected,
        currentVersion: current.version,
      });
  }

  private validateReferences(task: Task): void {
    const workspace = task.workspaceId;
    const check = (kind: string, id: string, row: { workspace_id: string } | undefined) => {
      if (!row)
        throw new DeskmatesError("not_found", `Referenced ${kind} not found`, { referenceId: id });
      if (row.workspace_id !== workspace)
        throw new DeskmatesError("forbidden", `Referenced ${kind} belongs to another workspace`);
    };
    if (task.ownerBotId !== null)
      check(
        "owner bot",
        task.ownerBotId,
        this.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(task.ownerBotId) as
          | { workspace_id: string }
          | undefined,
      );
    for (const id of task.threadIds)
      check(
        "thread",
        id,
        this.db.prepare("SELECT workspace_id FROM threads WHERE id = ?").get(id) as
          | { workspace_id: string }
          | undefined,
      );
    for (const id of new Set([
      ...task.runIds,
      ...task.artifacts.flatMap((a) => (a.runId ? [a.runId] : [])),
    ])) {
      const row = this.db
        .prepare(`SELECT b.workspace_id, t.workspace_id AS thread_workspace_id
        FROM runs r JOIN bots b ON b.id = r.bot_id LEFT JOIN threads t ON t.id = r.thread_id
        WHERE r.id = ?`)
        .get(id) as { workspace_id: string; thread_workspace_id: string | null } | undefined;
      check("run", id, row);
      if (row?.thread_workspace_id && row.thread_workspace_id !== workspace)
        throw new DeskmatesError("forbidden", "Referenced run thread belongs to another workspace");
    }
    const bots = this.botNames(workspace);
    for (const artifact of task.artifacts) {
      if (workspaceFileRoot(artifact.path, bots) === undefined)
        throw new DeskmatesError(
          "forbidden",
          "Artifact paths must be under /work/ or /home/<bot>/ of this workspace",
        );
    }
  }

  private write(task: Task, expectedVersion: number): void {
    const result = this.db
      .prepare(`UPDATE tasks SET title = @title, description = @description,
      owner_bot_id = @ownerBotId, status = @status, blocked_reason = @blockedReason, next_action = @nextAction,
      version = @version, updated_at = @updatedAt, delivered_at = @deliveredAt,
      delivered_by = @deliveredBy, output_schema_json = @outputSchema, output_json = @output,
      accepted_at = @acceptedAt, accepted_by = @acceptedBy, scope_version = @scopeVersion
      WHERE id = @id AND workspace_id = @workspaceId AND version = @expectedVersion
        AND deleted_at IS NULL`)
      .run({ ...bindings(task), expectedVersion });
    if (result.changes !== 1)
      throw new DeskmatesError("invalid_transition", "Task changed; reload before editing", {
        reason: "version_conflict",
      });
    this.writeLinks(task);
  }
}

function bindings(task: Task) {
  const {
    threadIds: _threads,
    runIds: _runs,
    artifacts: _artifacts,
    schedule: _schedule,
    ...row
  } = task;
  return {
    ...row,
    outputSchema: task.outputSchema === null ? null : JSON.stringify(task.outputSchema),
    output: task.output === null ? null : JSON.stringify(task.output),
  };
}

function toTask(
  row: TaskRow,
  links: Pick<Task, "threadIds" | "runIds" | "artifacts">,
  schedule: Task["schedule"],
): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    title: row.title,
    description: row.description,
    ownerBotId: row.owner_bot_id as BotId | null,
    status: row.status,
    blockedReason: row.blocked_reason,
    nextAction: row.next_action,
    ...links,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    deliveredBy: row.delivered_by,
    outputSchema:
      row.output_schema_json === null
        ? null
        : (JSON.parse(row.output_schema_json) as TaskOutputSchema),
    output: row.output_json === null ? null : (JSON.parse(row.output_json) as TaskJson),
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    scopeVersion: row.scope_version,
    schedule,
  };
}
