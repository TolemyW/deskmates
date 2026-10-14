// The MCP tools. Each is a thin typed call to one operator route (two or three for wait_task),
// named by operationId so `openapi.test.ts` can check the mapping. Arguments are checked here
// before any request, so a malformed call never spends the tenant's request budget.

import { createHash } from "node:crypto";
import {
  type Approval,
  type Attachment,
  type BotDefinition,
  RUN_ERROR_DEADLINE,
  RUN_ERROR_NO_REPLY,
  type Run,
  type SubmissionResponse,
  type SubmitRequest,
  type SubmitResponse,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  isTerminal,
} from "@deskmates/contracts";
import type { GatewayClient } from "./gateway-client.js";
import {
  APPROVAL_DECISIONS,
  DECISION,
  EXTERNAL_KEY,
  ID,
  type JsonSchema,
  SUBMIT_ATTACHMENTS_MAX,
  SUBMIT_BODY,
  TASK_STATUS,
  WORKSPACE_ID,
} from "./schemas.js";

/** download_artifact returns at most this many bytes of text. */
export const TEXT_LIMIT_BYTES = 256 * 1024;
/** wait_task's longest wait. Keep it under the MCP client's own request timeout. */
export const WAIT_MAX_SECONDS = 3_600;

/** A bad tool argument; reported like a Gateway `validation` error. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface ToolContext {
  client: GatewayClient;
  defaultWorkspaceId?: string | undefined;
  pollIntervalMs: number;
  /** Progress for long calls (wait_task), when the MCP client asked for it. */
  progress?: ((progress: number, total: number, message: string) => Promise<void>) | undefined;
}

type Args = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object"; properties: Record<string, JsonSchema> };
  /** operationIds in openapi.ts this tool calls. */
  operations: readonly string[];
  run(args: Args, ctx: ToolContext): Promise<Record<string, unknown>>;
}

/** A run as the run routes return it: the ledger row, including the Gateway's `error` reason. */
type RunRow = Run & { createdAt?: string; error?: string };

const enc = encodeURIComponent;

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "")
    throw new ToolInputError(`${key} is required and must be a non-empty string`);
  return value;
}

function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string`);
  return value;
}

function submitAttachments(raw: unknown): Attachment[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > SUBMIT_ATTACHMENTS_MAX)
    throw new ToolInputError(`attachments must be an array of at most ${SUBMIT_ATTACHMENTS_MAX}`);
  return raw.map((item: unknown) => {
    const a = (item && typeof item === "object" ? item : {}) as Args;
    return { name: str(a, "name"), mimeType: str(a, "mimeType"), ref: str(a, "ref") };
  });
}

function workspaceOf(args: Args, ctx: ToolContext): string {
  const id = optStr(args, "workspaceId") || ctx.defaultWorkspaceId;
  if (!id)
    throw new ToolInputError(
      "workspaceId is required (no DESKMATES_WORKSPACE_ID default is configured)",
    );
  return id;
}

function object(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): ToolDefinition["inputSchema"] {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function botSummary(bot: BotDefinition): Record<string, unknown> {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role,
    workspaceId: bot.workspaceId,
    soulVersion: bot.soulVersion,
  };
}

function runSummary(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    botId: run.botId,
    status: run.status,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
  };
}

const TASK_DONE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "delivered",
  "accepted",
  "cancelled",
]);
const REASONS: ReadonlySet<string> = new Set([RUN_ERROR_NO_REPLY, RUN_ERROR_DEADLINE]);

async function getTask(ctx: ToolContext, workspaceId: string, taskId: string): Promise<Task> {
  const { task } = await ctx.client.get<{ task: Task }>(
    `/api/workspaces/${enc(workspaceId)}/tasks/${enc(taskId)}`,
  );
  return task;
}

/** The task's runs: every run of its threads, plus runs linked by id that live elsewhere. */
async function linkedRuns(ctx: ToolContext, task: Task): Promise<RunRow[]> {
  const byId = new Map<string, RunRow>();
  for (const threadId of task.threadIds) {
    // A newest-first keyset page (#113 slice R): follow it to the end.
    let cursor: string | undefined;
    do {
      const page: { runs: RunRow[]; nextCursor?: string } = await ctx.client.get("/api/runs", {
        threadId,
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      for (const run of page.runs) byId.set(run.id, run);
      cursor = page.nextCursor;
    } while (cursor);
  }
  for (const runId of task.runIds) {
    if (byId.has(runId)) continue;
    const { run } = await ctx.client.get<{ run: RunRow }>(`/api/runs/${enc(runId)}`);
    byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) =>
    (a.createdAt ?? a.startedAt ?? "").localeCompare(b.createdAt ?? b.startedAt ?? ""),
  );
}

async function waitTask(args: Args, ctx: ToolContext): Promise<Record<string, unknown>> {
  const workspaceId = workspaceOf(args, ctx);
  const taskId = str(args, "taskId");
  const timeoutSeconds = args.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > WAIT_MAX_SECONDS
  )
    throw new ToolInputError(`timeoutSeconds must be a number from 0 to ${WAIT_MAX_SECONDS}`);
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  for (;;) {
    let task = await getTask(ctx, workspaceId, taskId);
    const runs = await linkedRuns(ctx, task);
    const runsTerminal = runs.length > 0 && runs.every((run) => isTerminal(run.status));
    // The task read and the runs read are two requests, not one snapshot: a run can end and its
    // task be delivered between them. Before answering `runs_terminal`, read the task once more
    // so a delivery that already landed is reported as one.
    if (runsTerminal && !TASK_DONE.has(task.status)) task = await getTask(ctx, workspaceId, taskId);
    const outcome = TASK_DONE.has(task.status)
      ? task.status
      : runsTerminal
        ? "runs_terminal"
        : Date.now() >= deadline
          ? "timeout"
          : undefined;
    if (outcome !== undefined) {
      const latest = runs.at(-1);
      const reason =
        latest?.error !== undefined && REASONS.has(latest.error)
          ? latest.error
          : runs.find((run) => run.error !== undefined && REASONS.has(run.error))?.error;
      return {
        outcome,
        task,
        latestRun: latest ? runSummary(latest) : null,
        runs: runs.map(runSummary),
        ...(reason !== undefined ? { reason } : {}),
        waitedSeconds: Math.round((Date.now() - started) / 100) / 10,
      };
    }
    const elapsed = (Date.now() - started) / 1000;
    await ctx.progress?.(
      elapsed,
      timeoutSeconds,
      `task ${task.status}; runs: ${runs.map((run) => run.status).join(", ") || "none yet"}`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(ctx.pollIntervalMs, deadline - Date.now()))),
    );
  }
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The longest prefix of at most `limit` bytes that ends on a UTF-8 character boundary. */
function utf8Prefix(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.length <= limit) return bytes;
  let end = limit;
  // A continuation byte is 10xxxxxx; back up to the start of the character it belongs to.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_workspaces",
    description:
      "List the Deskmates workspaces your credential can use. A workspace is one shared computer (browser, shell, files) for a group of bots.",
    inputSchema: object({}),
    operations: ["listWorkspaces"],
    run: async (_args, ctx) => ctx.client.get("/api/workspaces"),
  },
  {
    name: "list_bots",
    description:
      "List the bots of a workspace with each bot's id, name and role (what it is for). Pick the botId for submit from here.",
    inputSchema: object({ workspaceId: WORKSPACE_ID }),
    operations: ["listBots"],
    run: async (args, ctx) => {
      const { bots } = await ctx.client.get<{ bots: BotDefinition[] }>("/api/bots", {
        workspaceId: workspaceOf(args, ctx),
      });
      return { bots: bots.map(botSummary) };
    },
  },
  {
    name: "get_capacity",
    description:
      "Show a workspace's capacity now: per bot whether its interactive and background lanes are free, queued and parked runs, who holds the workspace browser lock, and sidecar slots. Use it to pace submits: each bot runs one run per lane at a time.",
    inputSchema: object({ workspaceId: WORKSPACE_ID }),
    operations: ["getCapacity"],
    run: async (args, ctx) =>
      ctx.client.get("/api/capacity", { workspaceId: workspaceOf(args, ctx) }),
  },
  {
    name: "submit",
    description:
      "Submit one unit of work: creates a thread bound to your externalKey, posts the instruction as a must-reply message to the bot, and creates a linked task. Idempotent on externalKey: a repeat returns the existing threadId, taskId and runs with created=false. Then call wait_task.",
    inputSchema: object(
      { workspaceId: WORKSPACE_ID, ...(SUBMIT_BODY.properties as Record<string, JsonSchema>) },
      SUBMIT_BODY.required as string[],
    ),
    operations: ["submitWork"],
    run: async (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const outputSchema = args.outputSchema;
      if (
        outputSchema !== undefined &&
        (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema))
      )
        throw new ToolInputError("outputSchema must be a JSON Schema object");
      const description = optStr(args, "description");
      const deadline = optStr(args, "deadline");
      const attachments = submitAttachments(args.attachments);
      // Exactly the contracts `SubmitRequest` keys; the Gateway refuses any other key with 400.
      const body: Partial<Record<keyof SubmitRequest, unknown>> = {
        externalKey: str(args, "externalKey"),
        botId: str(args, "botId"),
        title: str(args, "title"),
        instruction: str(args, "instruction"),
        ...(description !== undefined ? { description } : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      };
      const response = await ctx.client.post<SubmitResponse>(
        `/api/workspaces/${enc(workspaceId)}/submit`,
        body,
      );
      return { ...response.body, created: response.status === 201 };
    },
  },
  {
    name: "get_submission",
    description:
      "Recover a submission by its externalKey: its thread, task (null if an operator unlinked it) and latestRun (null if none was created). Use it after a crash or a lost submit response; submitting the same key again is also safe and returns the original ids.",
    inputSchema: object({ workspaceId: WORKSPACE_ID, externalKey: EXTERNAL_KEY }, ["externalKey"]),
    operations: ["getSubmission"],
    run: async (args, ctx) => {
      const submission = await ctx.client.get<SubmissionResponse>(
        `/api/workspaces/${enc(workspaceOf(args, ctx))}/submissions`,
        { externalKey: str(args, "externalKey") },
      );
      return { ...submission };
    },
  },
  {
    name: "get_task",
    description:
      "Read one task: status (planned, in_progress, blocked, delivered, accepted, cancelled), linked threads and runs, artifacts, and the structured output a bot delivered.",
    inputSchema: object({ workspaceId: WORKSPACE_ID, taskId: ID }, ["taskId"]),
    operations: ["getTask"],
    run: async (args, ctx) => ({
      task: await getTask(ctx, workspaceOf(args, ctx), str(args, "taskId")),
    }),
  },
  {
    name: "list_tasks",
    description: "List a workspace's tasks, optionally only those in one status.",
    inputSchema: object({ workspaceId: WORKSPACE_ID, status: TASK_STATUS }),
    operations: ["listTasks"],
    run: async (args, ctx) => {
      const status = optStr(args, "status");
      if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status))
        throw new ToolInputError(`status must be one of ${TASK_STATUSES.join(", ")}`);
      const { tasks } = await ctx.client.get<{ tasks: Task[] }>(
        `/api/workspaces/${enc(workspaceOf(args, ctx))}/tasks`,
      );
      return { tasks: status === undefined ? tasks : tasks.filter((t) => t.status === status) };
    },
  },
  {
    name: "wait_task",
    description:
      "Wait until a task is delivered, accepted or cancelled, or every run linked to it has ended, or the timeout passes. Returns outcome (delivered, accepted, cancelled, runs_terminal or timeout), the task, the latest run, and reason no_reply (the bot ended without answering) or deadline (the thread's deadline cancelled it) when present. A timeout is not an error: call again to keep waiting.",
    inputSchema: object(
      {
        workspaceId: WORKSPACE_ID,
        taskId: ID,
        timeoutSeconds: {
          type: "number",
          minimum: 0,
          maximum: WAIT_MAX_SECONDS,
          description:
            "How long to wait. Keep it below your MCP client's tool-call timeout; progress notifications are sent while waiting when the client asks for them.",
        },
      },
      ["taskId", "timeoutSeconds"],
    ),
    operations: ["getTask", "listRuns", "getRun"],
    run: waitTask,
  },
  {
    name: "get_messages",
    description:
      "Read a thread's messages after a sequence number (default 0, the whole transcript): the instruction, bot replies, and system notices such as approval requests.",
    inputSchema: object(
      {
        threadId: ID,
        afterSeq: { type: "integer", minimum: 0, description: "Return messages after this seq" },
      },
      ["threadId"],
    ),
    operations: ["listMessages"],
    run: async (args, ctx) => {
      const afterSeq = args.afterSeq;
      if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || (afterSeq as number) < 0))
        throw new ToolInputError("afterSeq must be a non-negative integer");
      return ctx.client.get(`/api/threads/${enc(str(args, "threadId"))}/messages`, {
        afterSeq: afterSeq as number | undefined,
      });
    },
  },
  {
    name: "post_message",
    description:
      "Post a follow-up message in a thread, e.g. a correction or an answer to a bot's question. mustReply=true makes a run that ends without replying count as failed with reason no_reply.",
    inputSchema: object(
      { threadId: ID, body: { type: "string", minLength: 1 }, mustReply: { type: "boolean" } },
      ["threadId", "body"],
    ),
    operations: ["postMessage"],
    run: async (args, ctx) => {
      const mustReply = args.mustReply;
      if (mustReply !== undefined && typeof mustReply !== "boolean")
        throw new ToolInputError("mustReply must be a boolean");
      const response = await ctx.client.post<Record<string, unknown>>(
        `/api/threads/${enc(str(args, "threadId"))}/messages`,
        { body: str(args, "body"), ...(mustReply ? { mustReply: true } : {}) },
      );
      return response.body;
    },
  },
  {
    name: "get_run",
    description:
      "Read one run: status, error reason (no_reply, deadline or free text), timing, summary and token usage.",
    inputSchema: object({ runId: ID }, ["runId"]),
    operations: ["getRun"],
    run: async (args, ctx) => ctx.client.get(`/api/runs/${enc(str(args, "runId"))}`),
  },
  {
    name: "cancel_run",
    description:
      "Cancel a run that has not finished (queued, running, or parked waiting for an approval or the browser). A finished run answers invalid_transition.",
    inputSchema: object({ runId: ID }, ["runId"]),
    operations: ["cancelRun"],
    run: async (args, ctx) =>
      (
        await ctx.client.post<Record<string, unknown>>(
          `/api/runs/${enc(str(args, "runId"))}/cancel`,
        )
      ).body,
  },
  {
    name: "list_approvals",
    description:
      "List approval requests: risky actions (external side effects) a bot's run is waiting on. Pending by default; optionally only one thread's.",
    inputSchema: object({
      threadId: ID,
      status: { type: "string", enum: ["pending", "decided"] },
    }),
    operations: ["listApprovals"],
    run: async (args, ctx) => {
      const status = optStr(args, "status");
      if (status !== undefined && status !== "pending" && status !== "decided")
        throw new ToolInputError("status must be pending or decided");
      return ctx.client.get<{ approvals: Approval[] }>("/api/approvals", {
        threadId: optStr(args, "threadId"),
        status,
      });
    },
  },
  {
    name: "decide_approval",
    description:
      "Decide a pending approval as any thread member may. allow_always also stores a rule so matching calls by that bot are allowed without asking again. Read the proposed action first (list_approvals).",
    inputSchema: object({ approvalId: ID, decision: DECISION, reason: { type: "string" } }, [
      "approvalId",
      "decision",
    ]),
    operations: ["decideApproval"],
    run: async (args, ctx) => {
      const decision = str(args, "decision");
      if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision))
        throw new ToolInputError(`decision must be one of ${APPROVAL_DECISIONS.join(", ")}`);
      const reason = optStr(args, "reason");
      const response = await ctx.client.post<Record<string, unknown>>(
        `/api/approvals/${enc(str(args, "approvalId"))}/decide`,
        { decision, ...(reason !== undefined ? { reason } : {}) },
      );
      return response.body;
    },
  },
  {
    name: "download_artifact",
    description:
      "Download one workspace file under /work/ or /home/<bot>/ (e.g. a task artifact path). Text comes back as content, bounded to 256 KiB; binary comes back as its byte count and SHA-256 only.",
    inputSchema: object(
      {
        workspaceId: WORKSPACE_ID,
        path: { type: "string", minLength: 1, description: "Absolute path in the workspace" },
      },
      ["path"],
    ),
    operations: ["downloadFile"],
    run: async (args, ctx) => {
      const path = str(args, "path");
      const bytes = await ctx.client.bytes(`/api/workspaces/${enc(workspaceOf(args, ctx))}/files`, {
        path,
      });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!isText(bytes)) return { path, kind: "binary", bytes: bytes.length, sha256 };
      const shown = utf8Prefix(bytes, TEXT_LIMIT_BYTES);
      return {
        path,
        kind: "text",
        bytes: bytes.length,
        sha256,
        truncated: shown.length < bytes.length,
        text: new TextDecoder().decode(shown),
      };
    },
  },
];
