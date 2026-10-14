// T0/T1 with the fake SDK and an in-memory Gateway (ADR-0021 amendment 2): `task_deliver` is
// offered only when the run names deliverable tasks, posts to the run's own internal route with
// the run token, needs no approval, and hands a Gateway refusal back to the model as text.

import type {
  BotId,
  RunEnded,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { parseStartRunRequest } from "./start-run-request.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-tasks";
const HOME = "/home/nova";
const SCHEMA = { type: "object", required: ["rows"], properties: { rows: { type: "integer" } } };

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-1" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: {
      kind: "thread_message",
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Count the rows and deliver",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post", "task_deliver"],
    deliverableTasks: [
      { id: "task_1", title: "Count rows", outputSchema: SCHEMA, scopeVersion: 3 },
    ],
    ...overrides,
  };
}

interface DeliverCall {
  path: string;
  authorization: string | null;
  body: unknown;
}

function setup(steps: ScriptStep[], answer: { status: number; body: unknown }) {
  const sdk = createFakeSdk(steps);
  const gateway = createFakeGateway();
  const calls: DeliverCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!/\/tasks\/[^/]+\/deliver$/.test(path)) return gateway.fetch(input, init);
    calls.push({
      path,
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => new Date("2026-10-09T10:00:00Z"),
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  return { gateway, deps, calls };
}

const go = (deps: SidecarDeps, req: StartRunRequest): Promise<RunEnded> =>
  runOnce(req, deps, { approvalPollMs: 1, batchDelayMs: 1 });

const deliverStep = (input: Record<string, unknown> = {}): ScriptStep => ({
  type: "tool_call",
  name: "mcp__deskmates__task_deliver",
  input: {
    taskId: "task_1",
    summary: "Counted 3 rows",
    artifacts: [{ label: "Counts", path: "/work/counts.csv" }],
    output: { rows: 3 },
    ...input,
  },
});

const deliveredTask = {
  task: { id: "task_1", status: "delivered", deliveredBy: "bot:bot-nova", version: 2 },
  delivery: { kind: "complete", outstanding: [], publications: [{ path: "/work/counts.csv" }] },
};

describe("task_deliver", () => {
  it("is registered only when the run offers it, and names the deliverable tasks", async () => {
    const tools: { name: string; description: string }[] = [];
    for (const req of [request(), request({ tools: ["thread_post"] })]) {
      const { deps } = setup([{ type: "end", summary: "" }], { status: 200, body: {} });
      const original = deps.createSdkMcpServer;
      deps.createSdkMcpServer = (options) => {
        tools.push(
          ...(options.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        );
        return original(options);
      };
      await go(deps, req);
    }
    const offered = tools.filter((t) => t.name === "task_deliver");
    expect(offered).toHaveLength(1);
    expect(offered[0]?.description).toContain("task_1");
    expect(offered[0]?.description).toContain("Count rows");
    expect(offered[0]?.description).toContain('"required":["rows"]');
    expect(offered[0]?.description).toMatch(/human accepts/i);
  });

  it("posts to the run's own route with the run token and needs no approval", async () => {
    const { gateway, deps, calls } = setup([deliverStep(), { type: "end", summary: "" }], {
      status: 200,
      body: deliveredTask,
    });
    await go(deps, request());
    expect(calls).toEqual([
      {
        path: "/internal/runs/run-1/tasks/task_1/deliver",
        authorization: `Bearer ${TOKEN}`,
        body: {
          summary: "Counted 3 rows",
          artifacts: [{ label: "Counts", path: "/work/counts.csv" }],
          scopeVersion: 3,
          output: { rows: 3 },
        },
      },
    ]);
    expect(gateway.approvals).toEqual([]);
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload.isError).not.toBe(true);
    expect(String(result?.payload.content)).toMatch(/delivered.*awaits human acceptance/i);
    expect(gateway.events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        payload: expect.objectContaining({ source: "task_deliver", taskId: "task_1" }),
      }),
    );
  });

  it("hands the Gateway's schema errors back to the model as a tool error", async () => {
    const { gateway, deps, calls } = setup(
      [deliverStep({ output: { rows: "3" } }), { type: "end", summary: "" }],
      {
        status: 400,
        body: {
          code: "validation",
          message: "The output does not match the task's outputSchema",
          details: { errors: ["output.rows: expected integer, got string"] },
        },
      },
    );
    const ended = await go(deps, request());
    expect(calls).toHaveLength(1);
    expect(ended.outcome).toBe("completed");
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload.isError).toBe(true);
    const text = String(result?.payload.content);
    expect(text).toContain("The task was not delivered");
    expect(text).toContain("output.rows: expected integer, got string");
  });

  it("sends a partial, file-less delivery and says the task stays open (A3g)", async () => {
    const { gateway, deps, calls } = setup(
      [
        deliverStep({ artifacts: undefined, outstanding: ["Illustrated report"] }),
        { type: "end", summary: "" },
      ],
      {
        status: 200,
        body: {
          task: { id: "task_1", status: "in_progress", version: 2 },
          delivery: { kind: "partial", outstanding: ["Illustrated report"], publications: [] },
        },
      },
    );
    await go(deps, request());
    expect(calls[0]?.body).toEqual({
      summary: "Counted 3 rows",
      artifacts: [],
      outstanding: ["Illustrated report"],
      scopeVersion: 3,
      output: { rows: 3 },
    });
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(String(result?.payload.content)).toMatch(/partial delivery.*stays open/i);
  });

  it("records a checkpoint on the run's own route (A3h)", async () => {
    const sdk = createFakeSdk([
      {
        type: "tool_call",
        name: "mcp__deskmates__task_checkpoint",
        input: {
          taskId: "task_1",
          completed: [{ unit: "case 1", outcome: "passed", evidence: ["/work/case1.png"] }],
          outstanding: ["case 2"],
        },
      },
      { type: "end", summary: "" },
    ]);
    const gateway = createFakeGateway();
    const seen: Array<{ path: string; body: unknown }> = [];
    const { deps } = setup([], { status: 200, body: {} });
    deps.query = sdk.query;
    deps.tool = sdk.tool;
    deps.createSdkMcpServer = sdk.createSdkMcpServer;
    deps.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (!path.endsWith("/checkpoints")) return gateway.fetch(input, init);
      seen.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ checkpoint: { taskId: "task_1", runId: "run-1", attempt: 1 } }),
        { status: 200 },
      );
    };
    await go(deps, request());
    expect(seen).toEqual([
      {
        path: "/internal/runs/run-1/tasks/task_1/checkpoints",
        body: {
          completed: [{ unit: "case 1", outcome: "passed", evidence: ["/work/case1.png"] }],
          outstanding: ["case 2"],
        },
      },
    ]);
    expect(gateway.approvals).toEqual([]);
  });

  it("keeps deliverable tasks through start request validation", () => {
    const parsed = parseStartRunRequest(JSON.stringify(request()));
    expect(parsed.ok && parsed.value.deliverableTasks).toEqual([
      { id: "task_1", title: "Count rows", outputSchema: SCHEMA, scopeVersion: 3 },
    ]);
    expect(parsed.ok && parsed.value.tools).toContain("task_deliver");
  });
});
