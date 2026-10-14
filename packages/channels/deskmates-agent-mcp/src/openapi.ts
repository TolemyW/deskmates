// The operator routes the MCP tools call, as a small hand-written table, and the OpenAPI 3.1
// document generated from it (`openapi.json`, refreshed by `npm run openapi`). The table is the
// documentation of this package's contract with the Gateway; `openapi.test.ts` checks that every
// tool maps to a row and every row is a route in the Gateway's manifest.

import { DECISION, ID, type JsonSchema, SUBMIT_BODY, TASK_STATUS } from "./schemas.js";

interface Param {
  name: string;
  description: string;
  required?: true;
  schema?: JsonSchema;
}

interface ResponseSpec {
  description: string;
  /** A `#/components/schemas` name, or an inline schema. */
  schema?: string | JsonSchema;
  /** `application/octet-stream` instead of JSON. */
  binary?: true;
}

export interface Operation {
  operationId: string;
  method: "get" | "post";
  /** OpenAPI path template, `{name}` for a path parameter. */
  path: string;
  summary: string;
  pathParams?: Param[];
  query?: Param[];
  body?: JsonSchema;
  responses: Record<string, ResponseSpec>;
}

const objectOf = (properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name: string): JsonSchema => ({ type: "array", items: ref(name) });

const wsParam = (name = "id"): Param => ({ name, description: "Workspace id", required: true });

export const OPERATIONS: readonly Operation[] = [
  {
    operationId: "listWorkspaces",
    method: "get",
    path: "/api/workspaces",
    summary: "Workspaces of the caller's tenant",
    responses: {
      "200": { description: "OK", schema: objectOf({ workspaces: arrayOf("Object") }) },
    },
  },
  {
    operationId: "listBots",
    method: "get",
    path: "/api/bots",
    summary: "Bots, optionally of one workspace; each carries its name and role",
    query: [{ name: "workspaceId", description: "Only this workspace's bots" }],
    responses: { "200": { description: "OK", schema: objectOf({ bots: arrayOf("Bot") }) } },
  },
  {
    operationId: "getCapacity",
    method: "get",
    path: "/api/capacity",
    summary: "Free lanes, queue depth and parked runs per bot; browser lock; sidecar slots",
    query: [{ name: "workspaceId", description: "Workspace id", required: true }],
    responses: { "200": { description: "OK", schema: objectOf({ capacity: ref("Object") }) } },
  },
  {
    operationId: "submitWork",
    method: "post",
    path: "/api/workspaces/{id}/submit",
    summary:
      "Create a thread bound to (channel, externalKey), post one must-reply instruction and a linked task; idempotent on externalKey. Admin role: a member-role service principal gets 403 (ADR-0022 amendment 1)",
    pathParams: [wsParam()],
    body: SUBMIT_BODY,
    responses: {
      "201": { description: "Created", schema: "SubmitResponse" },
      "200": {
        description:
          "A repeated externalKey: the original ids and current runs; nothing is created and no budget is checked",
        schema: "SubmitResponse",
      },
    },
  },
  {
    operationId: "getSubmission",
    method: "get",
    path: "/api/workspaces/{id}/submissions",
    summary: "Recover a submission's thread, task and latest run by externalKey (404 if unknown)",
    pathParams: [wsParam()],
    query: [{ name: "externalKey", description: "The key given to submit", required: true }],
    responses: { "200": { description: "OK", schema: "Submission" } },
  },
  {
    operationId: "listTasks",
    method: "get",
    path: "/api/workspaces/{workspaceId}/tasks",
    summary: "Tasks of a workspace",
    pathParams: [wsParam("workspaceId")],
    responses: { "200": { description: "OK", schema: objectOf({ tasks: arrayOf("Task") }) } },
  },
  {
    operationId: "getTask",
    method: "get",
    path: "/api/workspaces/{workspaceId}/tasks/{id}",
    summary: "One task, with its status, linked threads and runs, artifacts and output",
    pathParams: [wsParam("workspaceId"), { name: "id", description: "Task id", required: true }],
    responses: { "200": { description: "OK", schema: objectOf({ task: ref("Task") }) } },
  },
  {
    operationId: "listMessages",
    method: "get",
    path: "/api/threads/{id}/messages",
    summary: "A thread's transcript after a sequence number",
    pathParams: [{ name: "id", description: "Thread id", required: true }],
    query: [
      {
        name: "afterSeq",
        description: "Return messages with seq greater than this",
        schema: { type: "integer", minimum: 0 },
      },
    ],
    responses: { "200": { description: "OK", schema: objectOf({ messages: arrayOf("Object") }) } },
  },
  {
    operationId: "postMessage",
    method: "post",
    path: "/api/threads/{id}/messages",
    summary: "Post a human message, waking members as routing decides",
    pathParams: [{ name: "id", description: "Thread id", required: true }],
    body: objectOf({ body: { type: "string", minLength: 1 }, mustReply: { type: "boolean" } }, [
      "body",
    ]),
    responses: {
      "201": {
        description: "Posted",
        schema: objectOf({ message: ref("Object"), runs: arrayOf("Run") }),
      },
      "200": { description: "A redelivery of an earlier externalId", schema: ref("Object") },
    },
  },
  {
    operationId: "listRuns",
    method: "get",
    path: "/api/runs",
    summary: "Runs of the caller's tenant, optionally of one thread",
    query: [{ name: "threadId", description: "Only this thread's runs" }],
    responses: { "200": { description: "OK", schema: objectOf({ runs: arrayOf("Run") }) } },
  },
  {
    operationId: "getRun",
    method: "get",
    path: "/api/runs/{id}",
    summary: "One run and its token usage",
    pathParams: [{ name: "id", description: "Run id", required: true }],
    responses: {
      "200": { description: "OK", schema: objectOf({ run: ref("Run"), usage: arrayOf("Object") }) },
    },
  },
  {
    operationId: "cancelRun",
    method: "post",
    path: "/api/runs/{id}/cancel",
    summary: "Cancel a run that has not finished",
    pathParams: [{ name: "id", description: "Run id", required: true }],
    responses: { "200": { description: "OK", schema: objectOf({ run: ref("Run") }) } },
  },
  {
    operationId: "listApprovals",
    method: "get",
    path: "/api/approvals",
    summary: "Pending (or decided) approvals, optionally of one thread",
    query: [
      { name: "threadId", description: "Only this thread's approvals" },
      {
        name: "status",
        description: "pending (default) or decided",
        schema: { type: "string", enum: ["pending", "decided"] },
      },
    ],
    responses: {
      "200": { description: "OK", schema: objectOf({ approvals: arrayOf("Object") }) },
    },
  },
  {
    operationId: "decideApproval",
    method: "post",
    path: "/api/approvals/{id}/decide",
    summary: "Decide a pending approval; allow_always also stores a rule",
    pathParams: [{ name: "id", description: "Approval id", required: true }],
    body: objectOf({ decision: DECISION, reason: { type: "string" } }, ["decision"]),
    responses: {
      "200": {
        description: "Decided",
        schema: objectOf({ approval: ref("Object"), rule: ref("Object") }, ["approval"]),
      },
    },
  },
  {
    operationId: "downloadFile",
    method: "get",
    path: "/api/workspaces/{id}/files",
    summary: "Download one workspace file under /work/ or /home/<bot>/ (ADR-0014)",
    pathParams: [wsParam()],
    query: [{ name: "path", description: "Absolute path in the workspace", required: true }],
    responses: { "200": { description: "The file's bytes", binary: true } },
  },
];

/** The Gateway's route-manifest key, e.g. `GET /api/runs/:id`. */
export function policyKey(op: Pick<Operation, "method" | "path">): string {
  return `${op.method.toUpperCase()} ${op.path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const SCHEMAS: Record<string, JsonSchema> = {
  Object: { type: "object", description: "See the Gateway's contracts package for the shape." },
  Error: objectOf(
    {
      code: { type: "string", description: "DeskmatesError code, e.g. not_found, budget_exceeded" },
      message: { type: "string" },
      details: { type: "object" },
    },
    ["code", "message"],
  ),
  Bot: objectOf(
    {
      id: ID,
      name: { type: "string" },
      role: { type: "string" },
      workspaceId: ID,
      soulVersion: { type: "integer" },
    },
    ["id", "name", "role", "workspaceId"],
  ),
  Task: objectOf(
    {
      id: ID,
      workspaceId: ID,
      title: { type: "string" },
      description: { type: "string" },
      ownerBotId: { type: ["string", "null"] },
      status: TASK_STATUS,
      threadIds: { type: "array", items: { type: "string" } },
      runIds: { type: "array", items: { type: "string" } },
      artifacts: {
        type: "array",
        items: objectOf(
          { label: { type: "string" }, path: { type: "string" }, runId: { type: "string" } },
          ["label", "path"],
        ),
      },
      version: { type: "integer" },
      deliveredAt: { type: ["string", "null"] },
      deliveredBy: { type: ["string", "null"] },
      outputSchema: { type: ["object", "null"] },
      output: { description: "Structured output the bot delivered, or null" },
      acceptedAt: { type: ["string", "null"] },
      acceptedBy: { type: ["string", "null"] },
    },
    ["id", "workspaceId", "title", "status", "version"],
  ),
  Run: objectOf(
    {
      id: ID,
      botId: ID,
      threadId: { type: "string" },
      lane: { type: "string", enum: ["interactive", "background"] },
      status: {
        type: "string",
        enum: [
          "queued",
          "running",
          "waiting_approval_live",
          "waiting_approval",
          "waiting_browser",
          "waiting_continuation",
          "succeeded",
          "silent",
          "failed",
          "cancelled",
          "stopped",
        ],
      },
      error: {
        type: "string",
        description: "`no_reply`, `deadline`, or free text from the sidecar or scheduler",
      },
      startedAt: { type: "string" },
      finishedAt: { type: "string" },
    },
    ["id", "botId", "status"],
  ),
  SubmitResponse: objectOf(
    {
      threadId: ID,
      taskId: ID,
      messageId: ID,
      runs: arrayOf("Run"),
    },
    ["threadId", "taskId", "messageId", "runs"],
  ),
  Submission: objectOf(
    {
      thread: ref("Object"),
      task: {
        oneOf: [ref("Task"), { type: "null" }],
        description: "Null only when an operator has unlinked the task since",
      },
      latestRun: {
        oneOf: [ref("Run"), { type: "null" }],
        description: "The thread's newest run; null when none was created",
      },
    },
    ["thread", "task", "latestRun"],
  ),
};

function parameter(param: Param, location: "path" | "query"): JsonSchema {
  return {
    name: param.name,
    in: location,
    description: param.description,
    required: location === "path" || param.required === true,
    schema: param.schema ?? { type: "string" },
  };
}

function content(spec: ResponseSpec): JsonSchema | undefined {
  if (spec.binary)
    return { "application/octet-stream": { schema: { type: "string", format: "binary" } } };
  if (spec.schema === undefined) return undefined;
  const schema = typeof spec.schema === "string" ? ref(spec.schema) : spec.schema;
  return { "application/json": { schema } };
}

export function buildOpenApiDocument(): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of OPERATIONS) {
    const parameters = [
      ...(op.pathParams ?? []).map((p) => parameter(p, "path")),
      ...(op.query ?? []).map((p) => parameter(p, "query")),
    ];
    const responses: Record<string, JsonSchema> = {};
    for (const [status, spec] of Object.entries(op.responses)) {
      const body = content(spec);
      responses[status] = { description: spec.description, ...(body ? { content: body } : {}) };
    }
    responses["4XX"] = { $ref: "#/components/responses/Error" };
    responses["5XX"] = { $ref: "#/components/responses/Error" };
    const item = paths[op.path] ?? {};
    item[op.method] = {
      operationId: op.operationId,
      summary: op.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: op.body } },
            },
          }
        : {}),
      responses,
    };
    paths[op.path] = item;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Deskmates operator API: the subset deskmates-agent-mcp uses",
      version: "0.1.0",
      description:
        "Generated from packages/channels/deskmates-agent-mcp/src/openapi.ts. Every route is on the Gateway's authenticated operator listener and is tenant-scoped; ids of another tenant answer the same 404 as missing ones. Errors carry a DeskmatesError body; 429 means a request, queue or service-principal budget is spent and the call may be retried later.",
    },
    servers: [
      {
        url: "{gatewayUrl}",
        variables: { gatewayUrl: { default: "http://127.0.0.1:8081" } },
      },
    ],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "A service principal token (deskmates-sp.<token>) or the operator token.",
        },
      },
      responses: {
        Error: {
          description: "A DeskmatesError",
          content: { "application/json": { schema: ref("Error") } },
        },
      },
      schemas: SCHEMAS,
    },
  };
}
