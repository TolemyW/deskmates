// T1 (ADR-0021 amendment 2): `POST /internal/runs/:runId/tasks/:taskId/deliver` is the bot's only
// way to move a task, authenticated by that run's token alone; operator routes set the schema.
import { createHash } from "node:crypto";
import type { RunId, Task, TaskDelivery, WorkspaceId } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

let sandbox: FastifyInstance;
let operator: FastifyInstance;
let provider: FakeProvider;

beforeEach(async () => {
  provider = new FakeProvider();
  sandbox = buildGateway(testConfig(), provider, { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

const schema = {
  type: "object",
  required: ["rows"],
  additionalProperties: false,
  properties: { rows: { type: "integer" } },
};

function seed(name = "one") {
  const ctx = sandbox.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name, sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name, role: "writer" });
  const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id] });
  const run = ctx.runs.create({
    botId: bot.id,
    threadId: thread.id,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "test",
    config: ctx.runConfig(),
  });
  return { workspace, bot, thread, run, tasksUrl: `/api/workspaces/${workspace.id}/tasks` };
}

async function operatorApi(method: "POST" | "PATCH", url: string, payload: unknown) {
  return operator.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    payload: payload as Record<string, unknown>,
  });
}

async function createTask(tasksUrl: string, extra: Record<string, unknown>) {
  const response = await operatorApi("POST", tasksUrl, { title: "Count rows", ...extra });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ task: Task }>().task;
}

function deliver(runId: RunId, taskId: string, payload: unknown, token?: string) {
  return sandbox.inject({
    method: "POST",
    url: `/internal/runs/${runId}/tasks/${taskId}/deliver`,
    headers: {
      authorization: `Bearer ${token ?? sandbox.deskmates.ctx.tokens.issue(runId).token}`,
    },
    payload: payload as Record<string, unknown>,
  });
}

/**
 * Plays the workspace's `file-read --digest`: a listed path answers with its size and SHA-256,
 * a path mapped to an error code is refused, anything else is not found. Returns the requests.
 */
async function serveDigests(
  workspace: { id: string },
  files: Record<string, string | { error: string }>,
): Promise<Array<Record<string, unknown>>> {
  const ctx = sandbox.deskmates.ctx;
  await ctx.sandboxes.ensure(ctx.workspaces.mustGet(workspace.id as WorkspaceId));
  const seen: Array<Record<string, unknown>> = [];
  vi.spyOn(provider, "exec").mockImplementation(async (_handle, req) => {
    const request = JSON.parse(req.stdin ?? "{}") as Record<string, unknown>;
    seen.push({ cmd: req.cmd, ...request });
    const file = files[request.path as string];
    const result =
      typeof file === "string"
        ? { fileSize: file.length, sha256: createHash("sha256").update(file).digest("hex") }
        : { error: file?.error ?? "not_found", message: "refused" };
    return {
      exitCode: typeof file === "string" ? 0 : 1,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: "",
      timedOut: false,
    };
  });
  return seen;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const body = (extra: Record<string, unknown> = {}) => ({
  summary: "Counted 3 rows",
  artifacts: [{ label: "Counts", path: "/work/counts.csv" }],
  output: { rows: 3 },
  ...extra,
});

describe("task_deliver route", () => {
  it("delivers a linked task, publishes task_delivered and starts nothing", async () => {
    const { workspace, bot, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id], outputSchema: schema });
    expect(task.outputSchema).toEqual(schema);
    const ctx = sandbox.deskmates.ctx;
    const events: GatewayEvent[] = [];
    ctx.bus.subscribe((event) => events.push(event));
    const kick = vi.spyOn(sandbox.deskmates.scheduler, "kick");
    const execs = await serveDigests(workspace, { "/work/counts.csv": "a,b\n1,2\n" });
    const runsBefore = ctx.db.prepare("SELECT id, status FROM runs").all();
    const messagesBefore = ctx.db.prepare("SELECT * FROM thread_messages").all();

    const response = await deliver(run.id, task.id, body());
    expect(response.statusCode, response.body).toBe(200);
    const delivered = response.json<{ task: Task }>().task;
    expect(delivered).toMatchObject({
      status: "delivered",
      deliveredBy: `bot:${bot.id}`,
      output: { rows: 3 },
      runIds: [run.id],
      artifacts: [{ label: "Counts", path: "/work/counts.csv", runId: run.id }],
    });
    expect(ctx.tasks.mustGet(workspace.id, task.id)).toEqual(delivered);
    expect(events).toContainEqual({
      type: "task_delivered",
      threadId: thread.id,
      workspaceId: workspace.id,
      task: delivered,
      runId: run.id,
      summary: "Counted 3 rows",
    });
    const ledger = ctx.db
      .prepare("SELECT kind, payload_json FROM run_events WHERE run_id = ?")
      .all(run.id) as { kind: string; payload_json: string }[];
    expect(
      ledger.map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload_json) })),
    ).toContainEqual({
      kind: "log",
      payload: {
        tool: "task_deliver",
        taskId: task.id,
        summary: "Counted 3 rows",
        kind: "complete",
        artifacts: 1,
        published: 1,
        outstanding: 0,
        hasOutput: true,
      },
    });
    // ADR-0014 A4: the server checked the file through the fixed command, path in stdin only.
    expect(execs).toEqual([
      {
        cmd: ["deskmates-sidecar", "file-read"],
        path: "/work/counts.csv",
        botNames: ["one"],
        maxBytes: expect.any(Number),
        digest: true,
      },
    ]);
    const delivery = response.json<{ delivery: TaskDelivery }>().delivery;
    expect(delivery).toMatchObject({
      kind: "complete",
      runId: run.id,
      attempt: 1,
      scopeVersion: 1,
      outstanding: [],
      publications: [
        { path: "/work/counts.csv", label: "Counts", sizeBytes: 8, sha256: sha("a,b\n1,2\n") },
      ],
    });
    // Issue #70: the run API reports the delivery beside the run's status.
    const detail = await operator.inject({
      method: "GET",
      url: `/api/runs/${run.id}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
    });
    expect(detail.json<{ run: { visibility: unknown } }>().run.visibility).toMatchObject({
      deliveredTask: true,
      visibleOutcome: true,
    });
    expect(ctx.db.prepare("SELECT id, status FROM runs").all()).toEqual(runsBefore);
    expect(ctx.db.prepare("SELECT * FROM thread_messages").all()).toEqual(messagesBefore);
    expect(kick).not.toHaveBeenCalled();

    // Acceptance stays a human act on the operator listener.
    const accepted = await operatorApi("POST", `${tasksUrl}/${task.id}/accept`, {
      version: delivered.version,
    });
    expect(accepted.json().task).toMatchObject({ status: "accepted", acceptedBy: "human:web" });
  });

  it("returns schema errors to the bot and writes nothing", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id], outputSchema: schema });
    const response = await deliver(run.id, task.id, body({ output: { rows: "3", extra: true } }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "validation",
      details: {
        errors: ["output.rows: expected integer, got string", "output: unexpected property extra"],
      },
    });
    expect(sandbox.deskmates.ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
  });

  it("refuses an unlinked run, another workspace's task and a bad artifact path", async () => {
    const own = seed("own");
    const other = seed("other");
    const ctx = sandbox.deskmates.ctx;
    const task = await createTask(own.tasksUrl, { threadIds: [own.thread.id] });
    const unlinked = ctx.runs.create({
      botId: own.bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "x",
      config: ctx.runConfig(),
    });
    const cases: [RunId, unknown, number][] = [
      [unlinked.id, body(), 403],
      [other.run.id, body(), 404],
      [own.run.id, body({ artifacts: [{ label: "Cookies", path: "/profile/Cookies" }] }), 403],
      [own.run.id, body({ artifacts: [{ label: "x", path: "/home/other/x" }] }), 403],
      [own.run.id, body({ outstanding: "later" }), 400],
      [own.run.id, body({ summary: "" }), 400],
    ];
    for (const [runId, payload, status] of cases) {
      const response = await deliver(runId, task.id, payload);
      expect(response.statusCode, response.body).toBe(status);
    }
    expect(ctx.tasks.mustGet(own.workspace.id, task.id)).toEqual(task);
  });

  it("is reachable only with the run's own token, never from the operator listener", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const ctx = sandbox.deskmates.ctx;
    const sibling = ctx.runs.create({
      botId: run.botId,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "sibling",
      config: ctx.runConfig(),
    });
    const url = `/internal/runs/${run.id}/tasks/${task.id}/deliver`;
    for (const token of [TEST_OPERATOR_TOKEN, ctx.tokens.issue(sibling.id).token, "nope"]) {
      const response = await deliver(run.id, task.id, body(), token);
      expect(response.statusCode).toBe(401);
    }
    expect((await sandbox.inject({ method: "POST", url, payload: body() })).statusCode).toBe(401);
    const runToken = ctx.tokens.issue(run.id).token;
    expect(
      (
        await operator.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${runToken}` },
          payload: body(),
        })
      ).statusCode,
    ).toBe(404);
    // A run token is no operator credential, so it cannot set a schema or accept either.
    for (const [method, path, payload] of [
      ["PATCH", `${tasksUrl}/${task.id}`, { version: 1, outputSchema: {} }],
      ["POST", `${tasksUrl}/${task.id}/accept`, { version: 1 }],
    ] as const) {
      const response = await operator.inject({
        method,
        url: path,
        headers: { authorization: `Bearer ${runToken}` },
        payload,
      });
      expect(response.statusCode).toBe(401);
    }
    expect(ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
  });

  it("refuses the whole delivery when any file fails verification and writes nothing", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    await serveDigests(workspace, {
      "/work/ok.md": "fine",
      "/work/link.md": { error: "forbidden" },
      "/work/huge.bin": { error: "payload_too_large" },
    });
    const response = await deliver(run.id, task.id, {
      summary: "Done",
      artifacts: [
        { label: "ok", path: "/work/ok.md" },
        { label: "missing", path: "/work/missing.md" },
        { label: "link", path: "/work/link.md" },
        { label: "huge", path: "/work/huge.bin" },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().details).toMatchObject({
      reason: "verification_failed",
      errors: [
        "/work/missing.md: not_found",
        "/work/link.md: forbidden",
        "/work/huge.bin: payload_too_large",
      ],
    });
    const ctx = sandbox.deskmates.ctx;
    expect(ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
    expect(ctx.db.prepare("SELECT count(*) AS n FROM file_publications").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT count(*) AS n FROM task_deliveries").get()).toEqual({ n: 0 });
  });

  it("refuses a stopped workspace without starting it, and an old image's content reply", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const ensure = vi.spyOn(sandbox.deskmates.ctx.sandboxes, "ensure");
    const stopped = await deliver(run.id, task.id, body({ output: undefined }));
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().details).toEqual({ reason: "workspace_not_running" });
    expect(ensure).not.toHaveBeenCalled();
    ensure.mockRestore();
    await sandbox.deskmates.ctx.sandboxes.ensure(
      sandbox.deskmates.ctx.workspaces.mustGet(workspace.id),
    );
    vi.spyOn(provider, "exec").mockResolvedValue({
      exitCode: 0,
      stdout: `${JSON.stringify({ base64: "", size: 0 })}\n`,
      stderr: "",
      timedOut: false,
    });
    const old = await deliver(run.id, task.id, body({ output: undefined }));
    expect(old.statusCode).toBe(400);
    expect(old.json().details.errors).toEqual(["/work/counts.csv: invalid_response"]);
    expect(sandbox.deskmates.ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
  });

  it("publishes once on a retry and supersedes when the bytes change", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    await serveDigests(workspace, { "/work/counts.csv": "v1" });
    const payload = body({ output: undefined });
    expect((await deliver(run.id, task.id, payload)).statusCode).toBe(200);
    expect((await deliver(run.id, task.id, payload)).statusCode).toBe(200);
    const ctx = sandbox.deskmates.ctx;
    const rows = () =>
      ctx.db
        .prepare("SELECT sha256, superseded_at FROM file_publications ORDER BY published_at")
        .all() as Array<{ sha256: string; superseded_at: string | null }>;
    expect(rows()).toEqual([{ sha256: sha("v1"), superseded_at: null }]);
    vi.restoreAllMocks();
    await serveDigests(workspace, { "/work/counts.csv": "v2" });
    expect((await deliver(run.id, task.id, payload)).statusCode).toBe(200);
    expect(rows().map((r) => [r.sha256, r.superseded_at === null])).toEqual([
      [sha("v1"), false],
      [sha("v2"), true],
    ]);
  });

  it("refuses a stale scope and keeps a partial delivery undelivered", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    await serveDigests(workspace, { "/work/counts.csv": "rows" });
    const edited = await operatorApi("PATCH", `${tasksUrl}/${task.id}`, {
      version: 1,
      description: "Count only the active rows",
    });
    expect(edited.json().task.scopeVersion).toBe(2);
    // A link or state edit leaves the scope alone (A3f).
    const linked = await operatorApi("PATCH", `${tasksUrl}/${task.id}`, {
      version: 2,
      nextAction: "wait",
    });
    expect(linked.json().task.scopeVersion).toBe(2);
    const stale = await deliver(run.id, task.id, body({ output: undefined, scopeVersion: 1 }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toMatchObject({ reason: "stale_scope", currentScopeVersion: 2 });
    const partial = await deliver(
      run.id,
      task.id,
      body({ output: undefined, scopeVersion: 2, outstanding: ["Illustrated report"] }),
    );
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json().task.status).toBe("in_progress");
    expect(partial.json().delivery).toMatchObject({
      kind: "partial",
      outstanding: ["Illustrated report"],
    });
    expect(sandbox.deskmates.ctx.tasks.mustGet(workspace.id, task.id).deliveredAt).toBeNull();
  });

  it("records a checkpoint bound to the run and attempt; it changes and publishes nothing", async () => {
    const { workspace, bot, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const ctx = sandbox.deskmates.ctx;
    const post = (payload: unknown) =>
      sandbox.inject({
        method: "POST",
        url: `/internal/runs/${run.id}/tasks/${task.id}/checkpoints`,
        headers: { authorization: `Bearer ${ctx.tokens.issue(run.id).token}` },
        payload: payload as Record<string, unknown>,
      });
    const bad = await post({
      completed: [{ unit: "case 1", outcome: "ok", evidence: ["/profile/Cookies"] }],
    });
    expect(bad.statusCode).toBe(403);
    const recorded = await post({
      completed: [
        { unit: "case 1", outcome: "passed", evidence: ["/work/case1.png"] },
        { unit: "case 2", outcome: "passed" },
      ],
      outstanding: ["case 3"],
      note: "halfway",
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json().checkpoint).toMatchObject({
      taskId: task.id,
      runId: run.id,
      attempt: 1,
      botId: bot.id,
      outstanding: ["case 3"],
    });
    expect(ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
    expect(ctx.db.prepare("SELECT count(*) AS n FROM file_publications").get()).toEqual({ n: 0 });
    // The next wake of this thread names it as the latest checkpoint (A3k).
    expect(ctx.tasks.deliverableFor(run.id)[0]?.latestCheckpoint).toMatchObject({
      runId: run.id,
      completed: [{ unit: "case 1" }, { unit: "case 2", evidence: [] }],
      outstanding: ["case 3"],
    });
  });

  it("validates operator schemas and records the operator as deliverer on PATCH", async () => {
    const { workspace, tasksUrl } = seed();
    const bad = await operatorApi("POST", tasksUrl, {
      title: "Bad schema",
      outputSchema: { type: "string", format: "email" },
    });
    expect(bad.statusCode).toBe(400);
    expect(sandbox.deskmates.ctx.tasks.list(workspace.id)).toEqual([]);
    const task = await createTask(tasksUrl, {});
    const patched = await operatorApi("PATCH", `${tasksUrl}/${task.id}`, {
      version: 1,
      outputSchema: schema,
      status: "delivered",
      artifacts: [{ label: "R", path: "/work/r.md" }],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().task).toMatchObject({
      outputSchema: schema,
      deliveredBy: "human:web",
      output: null,
    });
  });
});
