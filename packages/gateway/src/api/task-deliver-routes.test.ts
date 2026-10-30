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
  it("refuses an in-flight delivery when its run is cancelled during file verification", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id], outputSchema: schema });
    await serveDigests(workspace, { "/work/counts.csv": "a,b\n1,2\n" });
    const digest = vi.mocked(provider.exec).getMockImplementation();
    let entered!: () => void;
    let release!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(provider.exec).mockImplementation(async (handle, request) => {
      entered();
      await gate;
      if (!digest) throw new Error("missing digest fixture");
      return digest(handle, request);
    });
    const pending = deliver(run.id, task.id, body()).then((response) => response);
    await verifying;
    const cancelled = await operatorApi("POST", `/api/runs/${run.id}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    release();
    const result = await pending;
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().details).toMatchObject({ reason: "run_finished", status: "cancelled" });
    expect(sandbox.deskmates.ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
    expect(sandbox.deskmates.ctx.tasks.deliveries(task.id)).toEqual([]);
    expect(sandbox.deskmates.ctx.db.prepare("SELECT * FROM file_publications").all()).toEqual([]);
  });

  it.each(["cancelled", "stopped", "failed", "succeeded", "silent"] as const)(
    "refuses a %s run before verifying any files even if it holds a token",
    async (status) => {
      const { workspace, thread, run, tasksUrl } = seed();
      const task = await createTask(tasksUrl, { threadIds: [thread.id] });
      const ctx = sandbox.deskmates.ctx;
      ctx.runs.transition(run.id, "running");
      if (status === "stopped") ctx.runs.transition(run.id, "waiting_continuation");
      ctx.runs.transition(run.id, status);
      const execs = await serveDigests(workspace, { "/work/counts.csv": "a,b\n1,2\n" });
      const result = await deliver(run.id, task.id, body());
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json().details.reason).toBe("run_finished");
      expect(execs).toEqual([]);
      expect(ctx.tasks.mustGet(workspace.id, task.id)).toEqual(task);
    },
  );

  it("replays identical concurrent and later deliveries without new rows, events or fileless receipts", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id], outputSchema: schema });
    await serveDigests(workspace, { "/work/counts.csv": "a,b\n1,2\n" });
    const events: GatewayEvent[] = [];
    sandbox.deskmates.ctx.bus.subscribe((event) => events.push(event));
    const results = await Promise.all([
      deliver(run.id, task.id, body()),
      deliver(run.id, task.id, body()),
    ]);
    const retry = await deliver(run.id, task.id, body());
    for (const result of [...results, retry]) {
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual(results[0]?.json());
      expect(result.json().delivery.publications).toHaveLength(1);
    }
    expect(sandbox.deskmates.ctx.tasks.deliveries(task.id)).toHaveLength(1);
    expect(events.filter((event) => event.type === "task_delivered")).toHaveLength(1);
    const logs = sandbox.deskmates.ctx.db
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'log'")
      .all(run.id) as { payload_json: string }[];
    expect(logs.filter((row) => JSON.parse(row.payload_json).tool === "task_deliver")).toHaveLength(
      1,
    );
  });

  it("keeps genuine revisions, reopened tasks, new attempts and changed bytes distinct", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const files = { "/work/counts.csv": "a,b\n1,2\n" };
    await serveDigests(workspace, files);
    const first = (await deliver(run.id, task.id, body())).json<{
      task: Task;
      delivery: TaskDelivery;
    }>();
    const changed = (await deliver(run.id, task.id, body({ output: { rows: 4 } }))).json<{
      task: Task;
      delivery: TaskDelivery;
    }>();
    expect(changed.delivery.id).not.toBe(first.delivery.id);
    await operatorApi("PATCH", `${tasksUrl}/${task.id}`, {
      version: changed.task.version,
      status: "planned",
    });
    const reopened = (await deliver(run.id, task.id, body({ output: { rows: 4 } }))).json<{
      task: Task;
      delivery: TaskDelivery;
    }>();
    expect(reopened.delivery.id).not.toBe(changed.delivery.id);
    files["/work/counts.csv"] = "changed bytes";
    const bytes = (await deliver(run.id, task.id, body({ output: { rows: 4 } }))).json<{
      task: Task;
      delivery: TaskDelivery;
    }>();
    expect(bytes.delivery.id).not.toBe(reopened.delivery.id);
    sandbox.deskmates.ctx.db
      .prepare("UPDATE runs SET attempt = attempt + 1 WHERE id = ?")
      .run(run.id);
    const attempt = (await deliver(run.id, task.id, body({ output: { rows: 4 } }))).json<{
      task: Task;
      delivery: TaskDelivery;
    }>();
    expect(attempt.delivery.id).not.toBe(bytes.delivery.id);
    expect(attempt.delivery.attempt).toBe(2);
    expect(sandbox.deskmates.ctx.tasks.deliveries(task.id)).toHaveLength(5);
  });

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

  // Issue #39 item 5: the bot's relative path names a file in its work directory, and a refused
  // call carries an example of a valid one.
  it("verifies and publishes a relative artifact path resolved under the bot's directory", async () => {
    const { workspace, thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const execs = await serveDigests(workspace, { "/work/bots/one/web/app.py": "print(1)" });
    const response = await deliver(run.id, task.id, {
      summary: "Wrote the app",
      artifacts: [{ label: "App", path: "web/app.py" }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(execs.map((e) => e.path)).toEqual(["/work/bots/one/web/app.py"]);
    expect(response.json<{ task: Task }>().task.artifacts).toEqual([
      { label: "App", path: "/work/bots/one/web/app.py", runId: run.id },
    ]);
  });

  it("answers a missing summary with an example whose output follows the schema", async () => {
    const { thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id], outputSchema: schema });
    const response = await deliver(run.id, task.id, { artifacts: [], output: { rows: 3 } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "validation",
      details: {
        key: "summary",
        workDir: "/work/bots/one",
        example: { taskId: task.id, summary: expect.any(String), output: { rows: 0 } },
      },
    });
  });

  it("names the work directory when /tmp is refused, before any workspace read", async () => {
    const { thread, run, tasksUrl } = seed();
    const task = await createTask(tasksUrl, { threadIds: [thread.id] });
    const exec = vi.spyOn(provider, "exec");
    const response = await deliver(
      run.id,
      task.id,
      body({ output: undefined, artifacts: [{ label: "x", path: "/tmp/x" }] }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("/work/bots/one");
    expect(response.json().details).toMatchObject({
      workDir: "/work/bots/one",
      example: { artifacts: [{ path: "/work/bots/one/result.md" }] },
    });
    expect(exec).not.toHaveBeenCalled();
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
    // Issue #39 item 5: a commit hash and a URL are typed evidence; `..` cannot leave /work.
    const typed = await post({
      completed: [
        { unit: "fix", outcome: "pushed", evidence: ["9489f6a", "https://example.com/pull/7"] },
      ],
    });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(typed.json().checkpoint.completed[0]).toEqual({
      unit: "fix",
      outcome: "pushed",
      evidence: ["9489f6a", "https://example.com/pull/7"],
      evidenceKinds: ["commit", "url"],
    });
    const escaping = await post({
      completed: [{ unit: "x", outcome: "x", evidence: ["../../../etc/passwd"] }],
    });
    expect(escaping.statusCode).toBe(403);
    expect(escaping.json().details).toMatchObject({
      workDir: "/work/bots/one",
      example: { taskId: task.id },
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
