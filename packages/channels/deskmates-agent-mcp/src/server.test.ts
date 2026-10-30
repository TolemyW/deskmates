// End to end through the MCP protocol: an MCP client talks to the server over an in-memory
// transport, and the server talks to a fake Gateway on a loopback port. One happy path and one
// error path per tool, the wait_task completion and timeout paths, and the token's confinement.

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentMcpServer } from "./server.js";
import { type FakeGateway, startFakeGateway } from "./test-support/fake-gateway.js";
import { TEXT_LIMIT_BYTES } from "./tools.js";

interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  client: Client;
  logs: string[];
  close(): Promise<void>;
}

interface CallResult {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

let gateway: FakeGateway;
let harness: Harness;

async function connect(
  options: { token?: string; workspaceId?: string; gatewayUrl?: string } = {},
): Promise<Harness> {
  const logs: string[] = [];
  const server = createAgentMcpServer({
    config: {
      gatewayUrl: options.gatewayUrl ?? gateway.baseUrl,
      token: options.token ?? gateway.token,
      ...(options.workspaceId ? { defaultWorkspaceId: options.workspaceId } : {}),
      pollIntervalMs: 10,
    },
    log: (line) => logs.push(line),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    logs,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      const text = content[0]?.text ?? "";
      return {
        isError: result.isError === true,
        text,
        data: JSON.parse(text) as Record<string, unknown>,
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(async () => {
  gateway = await startFakeGateway();
  harness = await connect({ workspaceId: "ws_1" });
});

afterEach(async () => {
  // Every request a tool made is a route the fake serves, which is exactly openapi.json.
  expect(gateway.requests.filter((r) => r.route === undefined)).toEqual([]);
  await harness.close();
  await gateway.close();
});

const errorOf = (result: CallResult) => result.data.error as Record<string, unknown>;

async function submitOne(externalKey = "job-1") {
  return harness.call("submit", {
    externalKey,
    botId: "bot_1",
    title: "Summarize page",
    instruction: "Summarize https://example.com into /work/out/job-1.md",
  });
}

describe("tool list", () => {
  it("offers every tool with a description and an object input schema, and no accept_task", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "cancel_run",
        "decide_approval",
        "download_artifact",
        "get_capacity",
        "get_messages",
        "get_run",
        "get_submission",
        "get_task",
        "list_approvals",
        "list_bots",
        "list_tasks",
        "list_workspaces",
        "post_message",
        "submit",
        "wait_task",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("answers an unknown tool with a tool error", async () => {
    const result = await harness.call("accept_task", { taskId: "t" });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("validation");
  });
});

describe("workspaces, bots and capacity", () => {
  it("list_workspaces returns the tenant's workspaces", async () => {
    const result = await harness.call("list_workspaces");
    expect(result.isError).toBe(false);
    expect((result.data.workspaces as { id: string }[]).map((w) => w.id)).toEqual(["ws_1"]);
  });

  it("list_workspaces carries a rejected token as token_rejected", async () => {
    await harness.close();
    harness = await connect({ token: "deskmates-sp.wrong-token-value-abcdef" });
    const result = await harness.call("list_workspaces");
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: "token_rejected", status: 401 });
  });

  it("list_bots returns each bot's role, defaulting the workspace", async () => {
    const result = await harness.call("list_bots");
    expect(result.data.bots).toEqual([
      {
        id: "bot_1",
        name: "scout",
        role: "Researcher: reads public sites and writes reports",
        workspaceId: "ws_1",
        soulVersion: 3,
      },
    ]);
    expect(gateway.requests.at(-1)?.query).toEqual({ workspaceId: "ws_1" });
  });

  it("list_bots refuses a call with no workspace when no default is configured", async () => {
    await harness.close();
    harness = await connect();
    const result = await harness.call("list_bots");
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("validation");
    expect(gateway.requests).toHaveLength(0);
  });

  it("get_capacity returns lanes, browser lock and sidecar slots", async () => {
    const result = await harness.call("get_capacity", { workspaceId: "ws_1" });
    expect(result.data.capacity).toMatchObject({ workspaceId: "ws_1", browserLock: null });
  });

  it("get_capacity reports an unknown workspace as not_found", async () => {
    const result = await harness.call("get_capacity", { workspaceId: "ws_other" });
    expect(errorOf(result)).toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("submit and recovery", () => {
  it("submit creates once and is idempotent on externalKey", async () => {
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    const attachments = [{ name: "input.csv", mimeType: "text/csv", ref: "/work/in/input.csv" }];
    const first = await harness.call("submit", {
      externalKey: "job-1",
      botId: "bot_1",
      title: "Summarize page",
      instruction: "Summarize it",
      description: "One page",
      outputSchema: { type: "object", required: ["summary"] },
      deadline,
      attachments,
    });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ created: true, threadId: "thr_1" });
    // Exactly the contracts `SubmitRequest` keys; the Gateway refuses unknown ones.
    expect(gateway.requests.at(-1)?.body).toEqual({
      externalKey: "job-1",
      botId: "bot_1",
      title: "Summarize page",
      instruction: "Summarize it",
      description: "One page",
      outputSchema: { type: "object", required: ["summary"] },
      deadline,
      attachments,
    });
    const again = await submitOne("job-1");
    expect(again.data).toMatchObject({
      created: false,
      threadId: "thr_1",
      taskId: first.data.taskId,
    });
    expect(gateway.tasks.size).toBe(1);
  });

  it("submit says plainly when the service principal's budget is spent", async () => {
    gateway.failNext("POST /api/workspaces/:id/submit", 429, {
      code: "budget_exceeded",
      message: "service principal concurrent run budget is spent",
      details: {},
    });
    const result = await submitOne();
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: "budget_exceeded", status: 429 });
    expect(String(errorOf(result).hint)).toMatch(/budget/i);
    expect(String(errorOf(result).hint)).toMatch(/retry later/i);
  });

  it("submit rejects a missing required field before calling the Gateway", async () => {
    const result = await harness.call("submit", { externalKey: "k", botId: "bot_1", title: "t" });
    expect(errorOf(result).code).toBe("validation");
    const badAttachment = await harness.call("submit", {
      externalKey: "k",
      botId: "bot_1",
      title: "t",
      instruction: "i",
      attachments: [{ name: "x" }],
    });
    expect(errorOf(badAttachment).code).toBe("validation");
    expect(gateway.requests).toHaveLength(0);
  });

  it("submit carries the Gateway's refusal of a past deadline", async () => {
    const result = await harness.call("submit", {
      externalKey: "late",
      botId: "bot_1",
      title: "t",
      instruction: "i",
      deadline: "2020-01-01T00:00:00Z",
    });
    expect(errorOf(result)).toMatchObject({ code: "validation", status: 400 });
    expect(gateway.tasks.size).toBe(0);
  });

  it("get_submission recovers thread, task and latestRun by externalKey", async () => {
    await submitOne("job-7");
    const result = await harness.call("get_submission", { externalKey: "job-7" });
    expect(result.data).toMatchObject({
      thread: { externalKey: "job-7" },
      task: { title: "Summarize page" },
      latestRun: { status: "queued" },
    });
  });

  it("get_submission reports an unknown key as not_found", async () => {
    const result = await harness.call("get_submission", { externalKey: "never" });
    expect(errorOf(result)).toMatchObject({ code: "not_found" });
  });
});

describe("tasks", () => {
  it("list_tasks reads every page and filters on the server even for matches beyond the first page", async () => {
    const seed = await submitOne();
    const template = gateway.tasks.get(String(seed.data.taskId));
    if (!template) throw new Error("missing task fixture");
    gateway.tasks.clear();
    for (let index = 0; index < 231; index++) {
      const task = {
        ...template,
        id: `task_${index}`,
        status: index < 225 ? ("planned" as const) : ("blocked" as const),
      };
      gateway.tasks.set(task.id, task);
    }
    gateway.tasks.set("other", {
      ...template,
      id: "other",
      workspaceId: "ws_other" as typeof template.workspaceId,
    });
    const all = await harness.call("list_tasks", {});
    expect(all.isError).toBe(false);
    expect(all.data.tasks).toHaveLength(231);
    expect(new Set((all.data.tasks as { id: string }[]).map((task) => task.id)).size).toBe(231);
    const requests = gateway.requests.filter(
      (request) => request.route === "GET /api/workspaces/:workspaceId/tasks",
    );
    expect(requests.map((request) => request.query)).toEqual([
      { offset: "0", limit: "100" },
      { offset: "100", limit: "100" },
      { offset: "200", limit: "100" },
    ]);
    const filtered = await harness.call("list_tasks", { status: "blocked" });
    expect(filtered.data.tasks).toHaveLength(6);
    expect(gateway.requests.at(-1)?.query).toEqual({
      offset: "0",
      limit: "100",
      status: "blocked",
    });
  });

  it("get_task returns the task", async () => {
    const submitted = await submitOne();
    const result = await harness.call("get_task", { taskId: submitted.data.taskId });
    expect(result.data.task).toMatchObject({ id: submitted.data.taskId, status: "planned" });
  });

  it("get_task reports a missing task", async () => {
    const result = await harness.call("get_task", { taskId: "task_missing" });
    expect(errorOf(result)).toMatchObject({ code: "not_found", status: 404 });
  });

  it("list_tasks filters by status", async () => {
    const a = await submitOne("a");
    await submitOne("b");
    const task = gateway.tasks.get(String(a.data.taskId));
    if (task) task.status = "delivered";
    const result = await harness.call("list_tasks", { status: "delivered" });
    expect((result.data.tasks as { id: string }[]).map((t) => t.id)).toEqual([a.data.taskId]);
    const all = await harness.call("list_tasks", {});
    expect(all.data.tasks).toHaveLength(2);
  });

  it("list_tasks rejects an unknown status and carries a Gateway refusal", async () => {
    const bad = await harness.call("list_tasks", { status: "done" });
    expect(errorOf(bad).code).toBe("validation");
    gateway.failNext("GET /api/workspaces/:workspaceId/tasks", 403, {
      code: "forbidden",
      message: "requires the member role in this tenant",
      details: {},
    });
    const refused = await harness.call("list_tasks", {});
    expect(errorOf(refused)).toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("wait_task", () => {
  it("returns when the task is delivered, with the latest run", async () => {
    const submitted = await submitOne();
    const taskId = String(submitted.data.taskId);
    setTimeout(() => {
      const task = gateway.tasks.get(taskId);
      if (task) {
        task.status = "delivered";
        task.output = { summary: "done" };
      }
      for (const run of gateway.runs.values()) run.status = "succeeded";
    }, 40);
    const result = await harness.call("wait_task", { taskId, timeoutSeconds: 5 });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      outcome: "delivered",
      task: { status: "delivered", output: { summary: "done" } },
      latestRun: { status: "succeeded" },
    });
    expect(result.data.reason).toBeUndefined();
  });

  it("does not answer runs_terminal on a task read that went stale mid-poll", async () => {
    const submitted = await submitOne();
    const taskId = String(submitted.data.taskId);
    for (const run of gateway.runs.values()) run.status = "succeeded";
    // The delivery lands between the tool's task read and its runs read: the runs answer is held
    // and the task is delivered meanwhile, an order a real Gateway can produce.
    gateway.delayNext("GET /api/runs", 40);
    setTimeout(() => {
      const task = gateway.tasks.get(taskId);
      if (task) {
        task.status = "delivered";
        task.output = { summary: "done" };
      }
    }, 10);
    const result = await harness.call("wait_task", { taskId, timeoutSeconds: 5 });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      outcome: "delivered",
      task: { status: "delivered", output: { summary: "done" } },
      latestRun: { status: "succeeded" },
    });
    expect(result.data.reason).toBeUndefined();
  });

  it("returns when every linked run is terminal, naming the no_reply reason", async () => {
    const submitted = await submitOne();
    for (const run of gateway.runs.values()) {
      run.status = "failed";
      run.error = "no_reply";
    }
    const result = await harness.call("wait_task", {
      taskId: submitted.data.taskId,
      timeoutSeconds: 5,
    });
    expect(result.data).toMatchObject({
      outcome: "runs_terminal",
      reason: "no_reply",
      latestRun: { status: "failed", error: "no_reply" },
    });
  });

  it("names the deadline reason for a run the deadline cancelled", async () => {
    const submitted = await submitOne();
    for (const run of gateway.runs.values()) {
      run.status = "cancelled";
      run.error = "deadline";
    }
    const result = await harness.call("wait_task", {
      taskId: submitted.data.taskId,
      timeoutSeconds: 5,
    });
    expect(result.data).toMatchObject({ outcome: "runs_terminal", reason: "deadline" });
  });

  it("times out while a run is still working", async () => {
    const submitted = await submitOne();
    for (const run of gateway.runs.values()) run.status = "running";
    const started = Date.now();
    const result = await harness.call("wait_task", {
      taskId: submitted.data.taskId,
      timeoutSeconds: 0.15,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      outcome: "timeout",
      task: { status: "planned" },
      latestRun: { status: "running" },
    });
  });

  it("reports a missing task as a tool error", async () => {
    const result = await harness.call("wait_task", { taskId: "task_missing", timeoutSeconds: 1 });
    expect(errorOf(result)).toMatchObject({ code: "not_found" });
  });
});

describe("messages and runs", () => {
  it("get_messages pages after a seq", async () => {
    const submitted = await submitOne();
    await harness.call("post_message", {
      threadId: submitted.data.threadId,
      body: "Also add a title",
    });
    const result = await harness.call("get_messages", {
      threadId: submitted.data.threadId,
      afterSeq: 1,
    });
    expect((result.data.messages as { seq: number }[]).map((m) => m.seq)).toEqual([2]);
  });

  it("get_messages reports a missing thread", async () => {
    const result = await harness.call("get_messages", { threadId: "thr_missing" });
    expect(errorOf(result)).toMatchObject({ code: "not_found" });
  });

  it("post_message sends mustReply and returns the woken runs", async () => {
    const submitted = await submitOne();
    const result = await harness.call("post_message", {
      threadId: submitted.data.threadId,
      body: "Status?",
      mustReply: true,
    });
    expect(gateway.requests.at(-1)?.body).toEqual({ body: "Status?", mustReply: true });
    expect(result.data).toMatchObject({
      message: { mustReply: true },
      runs: [{ status: "queued" }],
    });
  });

  it("post_message reports a missing thread", async () => {
    const result = await harness.call("post_message", { threadId: "thr_missing", body: "hi" });
    expect(errorOf(result)).toMatchObject({ code: "not_found", status: 404 });
  });

  it("get_run returns the run with its error reason and usage", async () => {
    const submitted = await submitOne();
    const run = (submitted.data.runs as { id: string }[])[0];
    const stored = gateway.runs.get(String(run?.id));
    if (stored) {
      stored.status = "failed";
      stored.error = "no_reply";
    }
    const result = await harness.call("get_run", { runId: run?.id });
    expect(result.data).toMatchObject({ run: { status: "failed", error: "no_reply" }, usage: [] });
  });

  it("get_run reports a missing run", async () => {
    const result = await harness.call("get_run", { runId: "run_missing" });
    expect(errorOf(result)).toMatchObject({ code: "not_found" });
  });

  it("cancel_run cancels an open run", async () => {
    const submitted = await submitOne();
    const run = (submitted.data.runs as { id: string }[])[0];
    const result = await harness.call("cancel_run", { runId: run?.id });
    expect(result.data).toMatchObject({ run: { status: "cancelled" } });
  });

  it("cancel_run carries invalid_transition for a finished run", async () => {
    const run = gateway.addRun({ threadId: "thr_x", status: "succeeded" });
    const result = await harness.call("cancel_run", { runId: run.id });
    expect(errorOf(result)).toMatchObject({ code: "invalid_transition", status: 409 });
  });
});

describe("approvals", () => {
  beforeEach(() => {
    gateway.approvals.set("approval_1", {
      id: "approval_1",
      kind: "tool",
      runId: "run_9",
      botId: "bot_1",
      threadId: "thr_9",
      action: { toolName: "Bash", input: { command: "git push" }, argumentSummary: "git push" },
      riskLevel: "L2",
      waitMode: "deferred",
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<typeof gateway.approvals.set>[1]);
  });

  it("list_approvals lists pending approvals of a thread", async () => {
    const result = await harness.call("list_approvals", { threadId: "thr_9" });
    expect((result.data.approvals as { id: string }[]).map((a) => a.id)).toEqual(["approval_1"]);
    const other = await harness.call("list_approvals", { threadId: "thr_other" });
    expect(other.data.approvals).toEqual([]);
  });

  it("list_approvals carries a Gateway outage", async () => {
    gateway.failNext("GET /api/approvals", 503, {
      code: "sandbox_unavailable",
      message: "down",
      details: {},
    });
    const result = await harness.call("list_approvals", {});
    expect(errorOf(result)).toMatchObject({ code: "sandbox_unavailable", status: 503 });
  });

  it("decide_approval allow_always returns the stored rule", async () => {
    const result = await harness.call("decide_approval", {
      approvalId: "approval_1",
      decision: "allow_always",
      reason: "pushes to this repo are fine",
    });
    expect(result.data).toMatchObject({
      approval: { decision: "allow_always" },
      rule: { id: "rule_1" },
    });
    expect(gateway.requests.at(-1)?.body).toEqual({
      decision: "allow_always",
      reason: "pushes to this repo are fine",
    });
  });

  it("decide_approval refuses an unknown decision and carries a second decision's conflict", async () => {
    const bad = await harness.call("decide_approval", {
      approvalId: "approval_1",
      decision: "yes",
    });
    expect(errorOf(bad).code).toBe("validation");
    await harness.call("decide_approval", { approvalId: "approval_1", decision: "deny" });
    const again = await harness.call("decide_approval", {
      approvalId: "approval_1",
      decision: "allow_once",
    });
    expect(errorOf(again)).toMatchObject({ code: "invalid_transition", status: 409 });
  });
});

describe("download_artifact", () => {
  it("returns text content with its size and hash", async () => {
    gateway.files.set("/work/out/report.md", new TextEncoder().encode("# Report\nAll good.\n"));
    const result = await harness.call("download_artifact", { path: "/work/out/report.md" });
    const sha = createHash("sha256").update("# Report\nAll good.\n").digest("hex");
    expect(result.data).toEqual({
      path: "/work/out/report.md",
      kind: "text",
      bytes: 19,
      sha256: sha,
      truncated: false,
      text: "# Report\nAll good.\n",
    });
  });

  it("bounds text to 256 KiB", async () => {
    const big = "a".repeat(TEXT_LIMIT_BYTES + 10);
    gateway.files.set("/work/big.txt", new TextEncoder().encode(big));
    const result = await harness.call("download_artifact", { path: "/work/big.txt" });
    expect(result.data).toMatchObject({
      kind: "text",
      bytes: TEXT_LIMIT_BYTES + 10,
      truncated: true,
    });
    expect(String(result.data.text)).toHaveLength(TEXT_LIMIT_BYTES);
  });

  it("returns only size and hash for binary content", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    gateway.files.set("/work/img.png", bytes);
    const result = await harness.call("download_artifact", { path: "/work/img.png" });
    expect(result.data).toEqual({
      path: "/work/img.png",
      kind: "binary",
      bytes: 7,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("carries the file policy refusal", async () => {
    const result = await harness.call("download_artifact", { path: "/etc/passwd" });
    expect(errorOf(result)).toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("token confinement", () => {
  it("never puts the token in a log line or a tool error", async () => {
    // A Gateway that echoes the credential back in its error body.
    gateway.failNext("GET /api/workspaces", 400, {
      code: "validation",
      message: `bad header Bearer ${gateway.token}`,
      details: { authorization: gateway.token },
    });
    const outputs: string[] = [];
    outputs.push((await harness.call("list_workspaces")).text);
    gateway.failNext("GET /api/runs/:id", 500, { code: "internal", message: "internal error" });
    outputs.push((await harness.call("get_run", { runId: "run_1" })).text);
    outputs.push((await harness.call("get_task", { taskId: gateway.token })).text);
    await harness.close();
    // An unreachable Gateway: the transport error goes through the same path.
    harness = await connect({ workspaceId: "ws_1", gatewayUrl: "http://127.0.0.1:9" });
    outputs.push((await harness.call("list_workspaces")).text);
    outputs.push((await harness.call("wait_task", { taskId: "t", timeoutSeconds: 0.05 })).text);
    for (const text of outputs) expect(text).not.toContain(gateway.token);
    expect(outputs[0]).toContain("[redacted]");
    expect(JSON.parse(outputs[3] ?? "{}").error.code).toBe("gateway_unreachable");
    for (const line of harness.logs) expect(line).not.toContain(gateway.token);
    expect(harness.logs.length).toBeGreaterThan(0);
  });

  it("sends the token only in the Authorization header", async () => {
    await submitOne();
    await harness.call("download_artifact", { path: "/work/none" });
    for (const request of gateway.requests) {
      expect(request.authorization).toBe(`Bearer ${gateway.token}`);
      expect(JSON.stringify(request.query)).not.toContain(gateway.token);
      expect(JSON.stringify(request.body ?? {})).not.toContain(gateway.token);
      expect(request.path).not.toContain(gateway.token);
    }
  });
});
