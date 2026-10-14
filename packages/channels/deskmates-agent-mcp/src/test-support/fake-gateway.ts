// A stand-in for the Gateway operator routes the MCP tools call, on a real loopback port so the
// client's HTTP code is exercised end to end. Route shapes mirror packages/gateway/src/api
// (registry, capacity, task, thread, run, run-cancel, approval and file routes) and the composite
// submit route of issue #21. State is plain maps a test mutates directly.

import { type IncomingMessage, type Server, createServer } from "node:http";
import type {
  Approval,
  BotDefinition,
  Run,
  RunStatus,
  Task,
  Thread,
  ThreadMessage,
  Workspace,
} from "@deskmates/contracts";

export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** The route template that matched, `METHOD /api/...:param`, or undefined for a 404. */
  route: string | undefined;
  query: Record<string, string>;
  authorization: string | undefined;
  body: unknown;
}

export type FakeRun = Run & { createdAt: string; error?: string };

interface Reply {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
}

interface Injected {
  status: number;
  body: unknown;
}

type Handler = (
  params: Record<string, string>,
  query: Record<string, string>,
  body: unknown,
) => Reply;

export interface FakeGateway {
  baseUrl: string;
  token: string;
  requests: RecordedRequest[];
  workspaces: Workspace[];
  bots: BotDefinition[];
  tasks: Map<string, Task>;
  threads: Map<string, Thread>;
  messages: Map<string, ThreadMessage[]>;
  runs: Map<string, FakeRun>;
  approvals: Map<string, Approval>;
  files: Map<string, Uint8Array>;
  /** The next request to `route` (e.g. `POST /api/runs/:id/cancel`) answers this instead. */
  failNext(route: string, status: number, body: unknown): void;
  /**
   * The next request to `route` is held for `ms` before it is answered, so a test can put a
   * state change between two reads the tool makes in one poll.
   */
  delayNext(route: string, ms: number): void;
  /** Every route template the fake serves, `METHOD /api/...:param`. */
  routes(): string[];
  /** Add a run linked to a thread (and to the task, when given). */
  addRun(input: { threadId: string; status: RunStatus; taskId?: string; error?: string }): FakeRun;
  close(): Promise<void>;
}

const now = (): string => new Date().toISOString();

/** contracts `SubmitRequest` keys; the real route refuses any other with 400. */
const SUBMIT_KEYS = [
  "externalKey",
  "botId",
  "title",
  "instruction",
  "description",
  "outputSchema",
  "deadline",
  "attachments",
  "authorId",
];

const notFound = (message: string): Reply => ({
  status: 404,
  json: { code: "not_found", message, details: {} },
});

const validation = (message: string): Reply => ({
  status: 400,
  json: { code: "validation", message, details: {} },
});

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const g = got[i] as string;
    if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(g);
    else if (w !== g) return undefined;
  }
  return params;
}

export async function startFakeGateway(
  token = "deskmates-sp.fake-secret-token-0123456789",
): Promise<FakeGateway> {
  let counter = 0;
  const id = (prefix: string): string => `${prefix}_${++counter}`;
  const requests: RecordedRequest[] = [];
  const injected = new Map<string, Injected>();
  const delayed = new Map<string, number>();
  const workspaces: Workspace[] = [
    {
      id: "ws_1",
      name: "Ops",
      egressAllowlist: ["*"],
      createdAt: now(),
    } as unknown as Workspace, // Only the fields a tool returns verbatim matter here.
  ];
  const bots: BotDefinition[] = [
    {
      id: "bot_1",
      name: "scout",
      role: "Researcher: reads public sites and writes reports",
      workspaceId: "ws_1",
      soulVersion: 3,
      connectors: [],
      messageAllowlist: [],
      cron: [],
      createdAt: now(),
    } as unknown as BotDefinition, // Branded ids are plain strings on the wire.
  ];
  const tasks = new Map<string, Task>();
  const threads = new Map<string, Thread>();
  const messages = new Map<string, ThreadMessage[]>();
  const runs = new Map<string, FakeRun>();
  const approvals = new Map<string, Approval>();
  const files = new Map<string, Uint8Array>();
  const submissions = new Map<string, { threadId: string; taskId: string; messageId: string }>();

  const workspaceExists = (wsId: string) => workspaces.some((ws) => ws.id === wsId);

  const addMessage = (threadId: string, body: string, mustReply: boolean): ThreadMessage => {
    const list = messages.get(threadId) ?? [];
    const message = {
      id: id("msg"),
      threadId,
      seq: list.length + 1,
      authorKind: "human",
      authorId: "service:sp_1",
      body,
      attachments: [],
      mentions: [],
      relayCount: 0,
      ...(mustReply ? { mustReply: true } : {}),
      ts: now(),
    } as unknown as ThreadMessage;
    list.push(message);
    messages.set(threadId, list);
    return message;
  };

  const addRun: FakeGateway["addRun"] = ({ threadId, status, taskId, error }) => {
    const run = {
      id: id("run"),
      botId: "bot_1",
      threadId,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "msg",
      status,
      attempt: 1,
      createdAt: new Date(Date.now() + counter).toISOString(),
      ...(error ? { error } : {}),
    } as unknown as FakeRun;
    runs.set(run.id, run);
    if (taskId) {
      const task = tasks.get(taskId);
      if (task) task.runIds = [...task.runIds, run.id];
    }
    return run;
  };

  const table: Record<string, Handler> = {
    "GET /api/workspaces": () => ({ status: 200, json: { workspaces } }),
    "GET /api/bots": (_p, q) => ({
      status: 200,
      json: { bots: bots.filter((b) => !q.workspaceId || b.workspaceId === q.workspaceId) },
    }),
    "GET /api/capacity": (_p, q) => {
      if (!q.workspaceId) return validation("workspaceId is required");
      if (!workspaceExists(q.workspaceId)) return notFound("workspace not found");
      return {
        status: 200,
        json: {
          capacity: {
            workspaceId: q.workspaceId,
            containerRunning: true,
            browserLock: null,
            sidecars: { active: 0 },
            bots: [
              {
                botId: "bot_1",
                name: "scout",
                lanes: {
                  interactive: { free: true, queued: 0, parked: 0 },
                  background: { free: true, queued: 0, parked: 0 },
                },
              },
            ],
          },
        },
      };
    },
    "POST /api/workspaces/:id/submit": (p, _q, raw) => {
      if (!workspaceExists(p.id as string)) return notFound("workspace not found");
      const body = record(raw);
      // As packages/gateway/src/api/submit-routes.ts: the whole body is checked first.
      for (const key of Object.keys(body))
        if (!SUBMIT_KEYS.includes(key)) return validation(`Unknown submit property: ${key}`);
      if (typeof body.deadline === "string" && Date.parse(body.deadline) <= Date.now())
        return validation("deadline must be in the future");
      const externalKey = body.externalKey;
      if (typeof externalKey !== "string" || externalKey === "")
        return validation("externalKey is required");
      if (typeof body.instruction !== "string") return validation("instruction is required");
      const existing = submissions.get(externalKey);
      if (existing) {
        return {
          status: 200,
          json: {
            ...existing,
            runs: [...runs.values()].filter((r) => r.threadId === existing.threadId),
          },
        };
      }
      const threadId = id("thr");
      threads.set(threadId, {
        id: threadId,
        workspaceId: p.id,
        kind: "chat",
        channel: "agent",
        externalKey,
        title: String(body.title ?? ""),
        turnBudget: 8,
        status: "open",
        ...(typeof body.deadline === "string" ? { deadline: body.deadline } : {}),
        createdAt: now(),
        updatedAt: now(),
      } as unknown as Thread);
      const message = addMessage(threadId, body.instruction, true);
      const taskId = id("task");
      tasks.set(taskId, {
        id: taskId,
        workspaceId: p.id,
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        ownerBotId: body.botId,
        status: "planned",
        blockedReason: "",
        nextAction: "",
        threadIds: [threadId],
        runIds: [],
        artifacts: [],
        version: 1,
        createdAt: now(),
        updatedAt: now(),
        deliveredAt: null,
        deliveredBy: null,
        outputSchema: (body.outputSchema as Task["outputSchema"]) ?? null,
        output: null,
        acceptedAt: null,
        acceptedBy: null,
      } as unknown as Task);
      const run = addRun({ threadId, status: "queued", taskId });
      submissions.set(externalKey, { threadId, taskId, messageId: message.id });
      return { status: 201, json: { threadId, taskId, messageId: message.id, runs: [run] } };
    },
    "GET /api/workspaces/:id/submissions": (p, q) => {
      if (!q.externalKey) return validation("externalKey is required");
      const found = submissions.get(q.externalKey);
      if (!found || !workspaceExists(p.id as string)) return notFound("no such submission");
      const linked = [...runs.values()].filter((r) => r.threadId === found.threadId);
      return {
        status: 200,
        json: {
          thread: threads.get(found.threadId),
          task: tasks.get(found.taskId),
          latestRun: linked[linked.length - 1] ?? null,
        },
      };
    },
    "GET /api/workspaces/:workspaceId/tasks": (p) => ({
      status: 200,
      json: { tasks: [...tasks.values()].filter((t) => t.workspaceId === p.workspaceId) },
    }),
    "GET /api/workspaces/:workspaceId/tasks/:id": (p) => {
      const task = tasks.get(p.id as string);
      if (!task || task.workspaceId !== p.workspaceId) return notFound("task not found");
      return { status: 200, json: { task } };
    },
    "GET /api/threads/:id/messages": (p, q) => {
      if (!threads.has(p.id as string)) return notFound("thread not found");
      const after = Number.parseInt(q.afterSeq ?? "0", 10) || 0;
      return {
        status: 200,
        json: { messages: (messages.get(p.id as string) ?? []).filter((m) => m.seq > after) },
      };
    },
    "POST /api/threads/:id/messages": (p, _q, raw) => {
      if (!threads.has(p.id as string)) return notFound("thread not found");
      const body = record(raw);
      if (typeof body.body !== "string" || body.body === "") return validation("body is required");
      const message = addMessage(p.id as string, body.body, body.mustReply === true);
      const run = addRun({ threadId: p.id as string, status: "queued" });
      return { status: 201, json: { message, runs: [run] } };
    },
    "GET /api/runs": (_p, q) => ({
      status: 200,
      json: { runs: [...runs.values()].filter((r) => !q.threadId || r.threadId === q.threadId) },
    }),
    "GET /api/runs/:id": (p) => {
      const run = runs.get(p.id as string);
      if (!run) return notFound("run not found");
      return { status: 200, json: { run, usage: [] } };
    },
    "POST /api/runs/:id/cancel": (p) => {
      const run = runs.get(p.id as string);
      if (!run) return notFound("run not found");
      if (["succeeded", "silent", "failed", "cancelled", "stopped"].includes(run.status))
        return {
          status: 409,
          json: { code: "invalid_transition", message: `run is ${run.status}`, details: {} },
        };
      run.status = "cancelled";
      return { status: 200, json: { run } };
    },
    "GET /api/approvals": (_p, q) => ({
      status: 200,
      json: {
        approvals: [...approvals.values()].filter(
          (a) =>
            (!q.threadId || a.threadId === q.threadId) &&
            ((q.status ?? "pending") === "decided") === (a.decision !== undefined),
        ),
      },
    }),
    "POST /api/approvals/:id/decide": (p, _q, raw) => {
      const approval = approvals.get(p.id as string);
      if (!approval) return notFound("approval not found");
      const body = record(raw);
      if (!["allow_once", "allow_always", "deny"].includes(String(body.decision)))
        return validation("decision must be allow_once, allow_always or deny");
      if (approval.decision !== undefined)
        return {
          status: 409,
          json: { code: "invalid_transition", message: "already decided", details: {} },
        };
      const decided = {
        ...approval,
        decision: body.decision,
        decidedBy: "human:service:sp_1",
        decidedAt: now(),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      } as Approval;
      approvals.set(approval.id, decided);
      return {
        status: 200,
        json: {
          approval: decided,
          ...(body.decision === "allow_always" ? { rule: { id: "rule_1" } } : {}),
        },
      };
    },
    "GET /api/workspaces/:id/files": (p, q) => {
      if (!workspaceExists(p.id as string)) return notFound("workspace not found");
      if (!q.path?.startsWith("/work/"))
        return {
          status: 403,
          json: {
            code: "forbidden",
            message:
              "Only regular files under /work/ or /home/<bot>/ of this workspace can be downloaded",
            details: {},
          },
        };
      const bytes = files.get(q.path);
      if (!bytes) return notFound("No such file in the workspace");
      return { status: 200, bytes };
    },
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    let route: string | undefined;
    let params: Record<string, string> = {};
    for (const key of Object.keys(table)) {
      const [method, pattern] = key.split(" ") as [string, string];
      if (method !== req.method) continue;
      const found = match(pattern, url.pathname);
      if (found) {
        route = key;
        params = found;
        break;
      }
    }
    const authorization = req.headers.authorization;
    requests.push({
      method: req.method ?? "",
      path: url.pathname,
      route,
      query,
      authorization,
      body,
    });
    const send = (reply: Reply): void => {
      if (reply.bytes) {
        res.writeHead(reply.status, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(reply.bytes));
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json ?? {}));
    };
    if (authorization !== `Bearer ${token}`) {
      send({
        status: 401,
        json: { code: "token_rejected", message: "not signed in", details: {} },
      });
      return;
    }
    if (!route) {
      send(notFound(`route ${req.method} ${url.pathname} not found`));
      return;
    }
    const delay = delayed.get(route);
    if (delay !== undefined) {
      delayed.delete(route);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const failure = injected.get(route);
    if (failure) {
      injected.delete(route);
      send({ status: failure.status, json: failure.body });
      return;
    }
    send((table[route] as Handler)(params, query, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    workspaces,
    bots,
    tasks,
    threads,
    messages,
    runs,
    approvals,
    files,
    failNext: (route, status, body) => injected.set(route, { status, body }),
    delayNext: (route, ms) => delayed.set(route, ms),
    routes: () => Object.keys(table),
    addRun,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
