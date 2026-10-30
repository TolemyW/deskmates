// Demo routes and seed of the Tasks page: three sample tasks in `galaxy-ops`, creation, edits
// with version checks, delivery and human acceptance. Task records live in the shared state
// because the Files collection lists their artifacts.

import {
  type BotDefinition,
  type CreateTaskRequest,
  TASK_STATUSES,
  type Task,
  type TaskExecution,
  type TaskSchedule,
  type TaskSubmission,
  type UpdateTaskInput,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest, DemoSeedContext } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, id, minutesAgo } from "../../demo/state.js";
import { demoStamp } from "../task-kinds/demo.js";

export const demo: DemoFeature = { route, seed: { after: "history", run: seed } };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  // Demo-only task records are operator-maintained too: these mutations emit no run or chat.
  // Production validation and persistence live in the Gateway, not in this demo.
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/tasks(?:\/([^/]+)(\/accept|\/run)?)?$/))) {
    const workspaceId = decodeURIComponent(x[1] ?? "") as WorkspaceId;
    if (!s.workspaces.some((ws) => ws.id === workspaceId)) return notFound("workspace");
    const taskId = x[2] ? decodeURIComponent(x[2]) : undefined;
    const invalid = (message: string, status = 400): Result => ({
      status,
      json: { code: status === 409 ? "invalid_transition" : "validation", message, details: {} },
    });
    if (!taskId) {
      if (method === "GET") {
        // One page, most recently updated first, filtered and searched like the Gateway (#113).
        const own = [...s.tasks.values()].filter((task) => task.workspaceId === workspaceId);
        const status = req.query.get("status");
        const q = (req.query.get("q") ?? "").trim().toLocaleLowerCase();
        const listed = own
          .filter(
            (task) =>
              (!status || task.status === status) &&
              (!q || task.title.toLocaleLowerCase().includes(q)),
          )
          .sort((a, c) => c.updatedAt.localeCompare(a.updatedAt));
        const limit = Number(req.query.get("limit") ?? 25) || 25;
        const offset = Number(req.query.get("offset") ?? 0) || 0;
        const statusCounts = Object.fromEntries(TASK_STATUSES.map((value) => [value, 0]));
        for (const task of own) statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
        return ok({
          tasks: listed.slice(offset, offset + limit),
          offset,
          limit,
          total: listed.length,
          statusCounts,
        });
      }
      if (method !== "POST") return notFound("route");
      const input = b as unknown as CreateTaskRequest;
      if (typeof input.title !== "string" || !input.title.trim())
        return invalid("A title is required");
      const at = new Date().toISOString();
      const task: Task = {
        id: id("task"),
        workspaceId,
        title: input.title.trim(),
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
        schedule: input.schedule ? demoSchedule(input.schedule) : null,
      };
      // ADR-0021 A4c: a template stamps the kind (the demo appends no description section).
      const stamp = input.templateId
        ? demoStamp(s, workspaceId, input.templateId, input.fields ?? {})
        : undefined;
      if (stamp) task.kind = stamp;
      s.tasks.set(task.id, task);
      // The demo has no runtime: an immediate create records a submission that never starts.
      if (input.trigger === "immediate") {
        const submission = demoSubmission(task, "immediate", at);
        return created({ task, submission });
      }
      return created({ task });
    }
    const task = s.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) return notFound("task");
    if (method === "GET" && !x[3]) return ok({ task, execution: demoExecution(task) });
    if (b.version !== task.version) return invalid("Task changed; reload before editing", 409);
    const at = new Date().toISOString();
    if (method === "DELETE" && !x[3]) {
      s.tasks.delete(task.id);
      return ok({ deleted: true, taskId: task.id });
    }
    if (x[3] === "/run" && method === "POST") {
      if (!task.ownerBotId) return invalid("Running a task needs a responsible (owner) bot");
      if (b.feedback !== undefined) {
        if (task.status !== "delivered" || typeof b.feedback !== "string" || !b.feedback.trim())
          return invalid("A revision needs a delivered task and feedback", 409);
        const revised: Task = {
          ...task,
          status: "in_progress",
          version: task.version + 1,
          deliveredAt: null,
          deliveredBy: null,
          output: null,
          updatedAt: at,
        };
        s.tasks.set(task.id, revised);
        return created({ task: revised, submission: demoSubmission(revised, "manual", at) });
      }
      return created({ task, submission: demoSubmission(task, "manual", at) });
    }
    if (x[3] && method === "POST") {
      if (task.status !== "delivered") return invalid("Only a delivered task can be accepted", 409);
      const accepted: Task = {
        ...task,
        status: "accepted",
        version: task.version + 1,
        updatedAt: at,
        acceptedAt: at,
        acceptedBy: "human:web",
      };
      s.tasks.set(task.id, accepted);
      return ok({ task: accepted });
    }
    if (method !== "PATCH" || x[3]) return notFound("route");
    const patch = b as unknown as UpdateTaskInput;
    if (b.status === "accepted") return invalid("Use explicit human acceptance");
    if (
      (task.status === "accepted" || task.status === "cancelled") &&
      patch.status !== "planned" &&
      patch.status !== "in_progress"
    )
      return invalid("Reopen this task before editing", 409);
    const { schedule: nextSchedule, ...fields } = patch;
    const changed: Task = {
      ...task,
      ...fields,
      ...(nextSchedule === undefined
        ? {}
        : { schedule: nextSchedule === null ? null : demoSchedule(nextSchedule) }),
      version: task.version + 1,
      updatedAt: at,
    };
    if (
      changed.status === "blocked" &&
      (!changed.blockedReason.trim() || !changed.nextAction.trim())
    )
      return invalid("Blocked tasks need a reason and next action");
    if (changed.status === "delivered" && !changed.artifacts.length)
      return invalid("Delivery needs an artifact");
    if (changed.status === "delivered") changed.deliveredAt = task.deliveredAt ?? at;
    else changed.deliveredAt = null;
    const stillDelivered = changed.status === "delivered" && task.status === "delivered";
    changed.deliveredBy =
      changed.status === "delivered" ? (stillDelivered ? task.deliveredBy : "human:web") : null;
    changed.output = stillDelivered ? task.output : null;
    changed.acceptedAt = null;
    changed.acceptedBy = null;
    s.tasks.set(task.id, changed);
    return ok({ task: changed });
  }
  return undefined;
}

/** Sample operator-maintained records for the local design preview; they never create runs. */
function seed(s: DemoState, { now, ws, chief, researcher, qa }: DemoSeedContext): void {
  const sampleTasks: [string, string, BotDefinition, Task["status"]][] = [
    [
      "Weekly operations brief",
      "Assemble KPI changes, open tickets and risks into a one-page brief.",
      chief,
      "in_progress",
    ],
    [
      "Export priority tickets",
      "Attach the current open P1 ticket list for the weekly review.",
      qa,
      "blocked",
    ],
    [
      "Review KPI changes",
      "Compare this week's revenue, active fleets and churn with last week.",
      researcher,
      "delivered",
    ],
  ];
  for (const [title, description, owner, status] of sampleTasks) {
    const task: Task = {
      id: id("task"),
      workspaceId: ws.id,
      title,
      description,
      ownerBotId: owner.id,
      status,
      blockedReason: status === "blocked" ? "Waiting for export approval" : "",
      nextAction: status === "blocked" ? "Review the pending request in the team chat" : "",
      threadIds: [],
      runIds: [],
      artifacts: status === "delivered" ? [{ label: "KPI findings", path: "/work/kpis.md" }] : [],
      version: 1,
      createdAt: minutesAgo(120, now),
      updatedAt: minutesAgo(5, now),
      deliveredAt: status === "delivered" ? minutesAgo(5, now) : null,
      deliveredBy: status === "delivered" ? "human:operator" : null,
      outputSchema: null,
      output:
        status === "delivered"
          ? {
              status: "Ready for review",
              checks: ["Compared the available KPI exports", "Linked the findings file"],
              open_issues: [
                "This demo has no live data connection. Verify the source period before accepting.",
              ],
            }
          : null,
      acceptedAt: null,
      acceptedBy: null,
      scopeVersion: 1,
      schedule: null,
    };
    s.tasks.set(task.id, task);
  }
}

/** Demo submissions per task; the preview has no scheduler, so none ever starts a run. */
const submissions = new Map<string, TaskSubmission[]>();

function demoSubmission(task: Task, kind: TaskSubmission["kind"], at: string): TaskSubmission {
  const submission: TaskSubmission = {
    id: id("tsub"),
    taskId: task.id,
    kind,
    key: id("key"),
    scopeVersion: task.scopeVersion,
    actor: "human:web",
    dispatch: "posted",
    occurrenceAt: null,
    threadId: null,
    messageId: null,
    createdAt: at,
    runs: [],
    state: "not_started",
  };
  submissions.set(task.id, [submission, ...(submissions.get(task.id) ?? [])]);
  return submission;
}

function demoExecution(task: Task): TaskExecution {
  return {
    observedAt: new Date().toISOString(),
    submissions: submissions.get(task.id) ?? [],
    linkedRuns: [],
    deliveries: [],
    latestCheckpoint: null,
  };
}

function demoSchedule(input: NonNullable<CreateTaskRequest["schedule"]>): TaskSchedule {
  return {
    kind: input.kind,
    runAt: input.kind === "once" ? input.runAt : null,
    cron: input.kind === "repeat" ? input.cron : null,
    timeZone: input.timeZone ?? "UTC",
    enabled: true,
    version: 1,
    nextFireAt: input.kind === "once" ? input.runAt : null,
    lastFiredAt: null,
  };
}
