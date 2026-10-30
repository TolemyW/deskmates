// T1: ADR-0014 operator download of one workspace file. The fake provider plays the sidecar's
// `file-read` command, so these cases cover what the Gateway does with each verdict; the policy
// itself is proven on a real filesystem in packages/sidecar/src/file-read.test.ts.

import type { ExecRequest, ExecResult, Workspace } from "@deskmates/contracts";
import Fastify from "fastify";
import { type MockInstance, afterEach, describe, expect, it, vi } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { registerErrorHandler } from "./errors.js";
import { PREVIEW_MAX_LIVE_PER_CALLER, registerFileRoutes } from "./file-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

const auth = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

async function setup(
  opts: { running?: boolean; config?: Parameters<typeof testConfig>[0] } = {},
): Promise<{
  app: ReturnType<typeof buildGateway>;
  provider: FakeProvider;
  workspace: Workspace;
  exec: MockInstance<FakeProvider["exec"]>;
  reply: (result: Partial<ExecResult>) => void;
}> {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(opts.config), provider, {
    surface: "combined-test",
    startCron: false,
  });
  apps.push(app);
  await app.ready();
  app.deskmates.scheduler.stop();
  const ctx = app.deskmates.ctx;
  const workspace = ctx.workspaces.create({ name: "files", sandboxProvider: "docker" });
  ctx.bots.create({ name: "nova", role: "test", workspaceId: workspace.id });
  ctx.bots.create({ name: "atlas", role: "test", workspaceId: workspace.id });
  const other = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" });
  ctx.bots.create({ name: "stranger", role: "test", workspaceId: other.id });
  if (opts.running !== false) await ctx.sandboxes.ensure(workspace);
  let next: Partial<ExecResult> = {};
  const exec = vi.spyOn(provider, "exec").mockImplementation(
    async (): Promise<ExecResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...next,
    }),
  );
  return {
    app,
    provider,
    workspace,
    exec,
    reply: (result) => {
      next = result;
    },
  };
}

function ok(bytes: Buffer): Partial<ExecResult> {
  return {
    stdout: `${JSON.stringify({ base64: bytes.toString("base64"), size: bytes.length })}\n`,
  };
}

function failed(error: string, message = "refused"): Partial<ExecResult> {
  return { exitCode: 1, stdout: `${JSON.stringify({ error, message })}\n` };
}

const url = (workspaceId: string, path: string): string =>
  `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`;

describe("GET /api/workspaces/:id/files", () => {
  it("returns the file as an attachment with the ADR-0014 headers", async () => {
    const { app, workspace, reply } = await setup();
    const bytes = Buffer.from([0, 1, 2, 255, 60, 115, 99, 114, 105, 112, 116, 62]);
    reply(ok(bytes));
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/out/report.html"),
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="report.html"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(bytes);
  });

  it("runs the fixed file-read command with the path only in stdin JSON", async () => {
    const { app, workspace, exec, reply } = await setup();
    reply(ok(Buffer.from("a,b\n")));
    const path = "/home/nova/out.csv";
    await app.inject({ method: "GET", url: url(workspace.id, path), headers: auth });
    expect(exec).toHaveBeenCalledTimes(1);
    const request = exec.mock.calls[0]?.[1] as ExecRequest;
    expect(request.cmd).toEqual(["deskmates-sidecar", "file-read"]);
    expect(request.cmd.join(" ")).not.toContain(path);
    expect(request.env).toBeUndefined();
    expect(JSON.parse(request.stdin as string)).toEqual({
      path,
      botNames: expect.arrayContaining(["nova", "atlas"]),
      maxBytes: GIB,
      offset: 0,
      length: MIB,
      allowFileAboveMaxBytes: false,
    });
    expect((JSON.parse(request.stdin as string) as { botNames: string[] }).botNames).toHaveLength(
      2,
    );
  });

  it("refuses bad path shapes before any exec", async () => {
    const { app, workspace, exec } = await setup();
    for (const path of [
      "/profile/Cookies",
      "/work/../profile/x",
      "/etc/passwd",
      "/home/stranger/x",
      "/home/other-workspace-bot/x",
      "/work/报告，最终.md",
      "work/a.md",
      "/work/",
      "/work/a b.md",
      "/work/$(id)",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: url(workspace.id, path),
        headers: auth,
      });
      expect(response.statusCode, path).toBe(403);
      expect(response.json().code, path).toBe("forbidden");
      expect(response.json().message, path).not.toContain("profile");
    }
    for (const query of ["", "?path=", "?path=a&path=b"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.id}/files${query}`,
        headers: auth,
      });
      expect(response.statusCode, query).toBe(400);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<ExecResult>, number, string]>([
    ["a symlink into /profile", failed("forbidden", "/profile/Cookies leaked"), 403, "forbidden"],
    ["a directory", failed("forbidden"), 403, "forbidden"],
    ["a 1 MiB + 1 byte file", failed("payload_too_large"), 413, "payload_too_large"],
    ["a missing file", failed("not_found"), 404, "not_found"],
    ["an unknown error code", failed("internal"), 503, "sandbox_unavailable"],
    ["non-JSON output", { exitCode: 1, stdout: "Segmentation fault" }, 503, "sandbox_unavailable"],
    ["exit 0 with malformed output", { stdout: "{}" }, 503, "sandbox_unavailable"],
    [
      "exit 0 with a size mismatch",
      { stdout: JSON.stringify({ base64: "YWJj", size: 4 }) },
      503,
      "sandbox_unavailable",
    ],
    [
      "exit 0 with invalid base64",
      { stdout: JSON.stringify({ base64: "not base64!", size: 3 }) },
      503,
      "sandbox_unavailable",
    ],
    ["exit 0 above one range", ok(Buffer.alloc(MIB + 1)), 503, "sandbox_unavailable"],
    ["a timeout", { exitCode: -1, timedOut: true }, 503, "sandbox_unavailable"],
  ])("maps the command's verdict for %s", async (_label, result, status, code) => {
    const { app, workspace, reply } = await setup();
    reply(result);
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/x.bin"),
      headers: auth,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    // The container's message is not passed through: a refusal names only the policy.
    expect(response.json().message).not.toContain("leaked");
  });

  it("maps a provider failure to sandbox_unavailable", async () => {
    const { app, workspace, exec } = await setup();
    exec.mockRejectedValueOnce(new Error("socket hang up"));
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/x.bin"),
      headers: auth,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("sandbox_unavailable");
  });

  it("passes the configured byte cap to the command", async () => {
    const { app, workspace, exec, reply } = await setup({
      config: { fileDownloadMaxBytes: 4 * MIB },
    });
    reply(ok(Buffer.from("x")));
    await app.inject({ method: "GET", url: url(workspace.id, "/work/x"), headers: auth });
    expect(JSON.parse(exec.mock.calls[0]?.[1].stdin as string).maxBytes).toBe(4 * MIB);
  });

  it("serves bounded preview ranges for a file above the 1 GiB download cap", async () => {
    const { app, workspace, reply, exec } = await setup();
    const bytes = Buffer.from("preview");
    reply({
      stdout: `${JSON.stringify({
        base64: bytes.toString("base64"),
        size: bytes.length,
        fileSize: 2 * GIB,
        offset: 0,
        eof: false,
      })}\n`,
    });
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/huge.pdf"),
      headers: {
        ...auth,
        range: "bytes=0-6",
        "x-deskmates-preview-id": "preview_1234567890",
      },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 0-6/${2 * GIB}`);
    expect(response.rawPayload).toEqual(bytes);
    expect(JSON.parse(exec.mock.calls[0]?.[1].stdin as string)).toMatchObject({
      offset: 0,
      length: 7,
      allowFileAboveMaxBytes: true,
    });
  });

  it("enforces 64 requests and 64 MiB for one preview identity", async () => {
    const { app, workspace, reply, exec } = await setup();
    const bytes = Buffer.from("x");
    reply({
      stdout: `${JSON.stringify({
        base64: bytes.toString("base64"),
        size: 1,
        fileSize: 2 * GIB,
        offset: 0,
        eof: false,
      })}\n`,
    });
    const headers = {
      ...auth,
      range: `bytes=0-${MIB - 1}`,
      "x-deskmates-preview-id": "preview_budget_1234",
    };
    for (let i = 0; i < 64; i++)
      expect(
        (await app.inject({ method: "GET", url: url(workspace.id, "/work/huge.pdf"), headers }))
          .statusCode,
      ).toBe(206);
    const refused = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/huge.pdf"),
      headers,
    });
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toMatchObject({
      code: "payload_too_large",
      details: { reason: "preview_budget", maxBytes: 64 * MIB, maxRanges: 64 },
    });
    expect(exec).toHaveBeenCalledTimes(64);
  });

  it("serves a fresh preview identity per open, more than the cap in sequence (#61 L2)", async () => {
    const { app, workspace, reply, exec } = await setup();
    const preview = (id: string, path: string) =>
      app.inject({
        method: "GET",
        url: url(workspace.id, path),
        headers: { ...auth, range: "bytes=0-0", "x-deskmates-preview-id": `preview_open_${id}` },
      });
    // A whole small file: the identity reaches the end of its file.
    reply(ok(Buffer.from("x")));
    const opens = PREVIEW_MAX_LIVE_PER_CALLER + 20;
    for (let i = 0; i < opens; i++)
      expect((await preview(`${i}`.padStart(6, "0"), `/work/f${i}.md`)).statusCode).toBe(206);
    // The first range of a large file: the identity stops mid-file and goes idle.
    reply({
      stdout: `${JSON.stringify({ base64: "eA==", size: 1, fileSize: GIB, offset: 0, eof: false })}\n`,
    });
    for (let i = 0; i < opens; i++)
      expect((await preview(`big${i}`.padStart(6, "0"), "/work/big.pdf")).statusCode).toBe(206);
    expect(exec).toHaveBeenCalledTimes(2 * opens);
  });

  it("refuses a new preview identity only while every held one is mid-stream (#61 L2)", async () => {
    const { app, workspace, reply, exec } = await setup();
    reply(ok(Buffer.from("x")));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = exec.getMockImplementation();
    exec.mockImplementation(async (...args) => {
      await gate;
      return (respond as NonNullable<typeof respond>)(...args);
    });
    const preview = (id: string) =>
      app.inject({
        method: "GET",
        url: url(workspace.id, "/work/a.md"),
        headers: { ...auth, range: "bytes=0-0", "x-deskmates-preview-id": `preview_busy_${id}` },
      });
    const held = Array.from({ length: PREVIEW_MAX_LIVE_PER_CALLER }, (_, i) =>
      preview(`${i}`.padStart(6, "0")),
    );
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(PREVIEW_MAX_LIVE_PER_CALLER));
    const refused = await preview("fresh0");
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      code: "rate_limited",
      details: { reason: "preview_limit", maxPreviews: PREVIEW_MAX_LIVE_PER_CALLER },
    });
    release();
    for (const response of await Promise.all(held)) expect(response.statusCode).toBe(206);
    expect((await preview("fresh1")).statusCode).toBe(206);
  });

  it("streams more than one sidecar range in order", async () => {
    const { app, workspace, exec } = await setup({ config: { fileDownloadMaxBytes: 4 * MIB } });
    const first = Buffer.alloc(MIB, 1);
    const second = Buffer.from("tail");
    exec.mockImplementation(async (_handle, request) => {
      const input = JSON.parse(request.stdin as string) as { offset: number };
      const bytes = input.offset === 0 ? first : second;
      return {
        exitCode: 0,
        stderr: "",
        timedOut: false,
        stdout: `${JSON.stringify({
          base64: bytes.toString("base64"),
          size: bytes.length,
          fileSize: MIB + second.length,
          offset: input.offset,
          eof: input.offset !== 0,
        })}\n`,
      };
    });
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/stream.bin"),
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    // Buffer.equals, not toEqual: a deep comparison of 1 MiB walked every byte and took this test
    // past its 5 s timeout on CI runners (#97, #98).
    expect(response.rawPayload.length).toBe(MIB + second.length);
    expect(response.rawPayload.equals(Buffer.concat([first, second]))).toBe(true);
    expect(exec.mock.calls.map((call) => JSON.parse(call[1].stdin as string).offset)).toEqual([
      0,
      MIB,
    ]);
  });

  it("reports a stopped workspace and never starts one", async () => {
    const { app, provider, workspace, exec } = await setup({ running: false });
    const ensure = vi.spyOn(app.deskmates.ctx.sandboxes, "ensure");
    const create = vi.spyOn(provider, "create");
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/a.md"),
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "not_found",
      message: expect.stringContaining("not running"),
      details: { reason: "workspace_not_running" },
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(provider.created).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("answers not_found for an unknown workspace", async () => {
    const { app, exec } = await setup();
    const response = await app.inject({
      method: "GET",
      url: url("ws_missing", "/work/a.md"),
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
    expect(exec).not.toHaveBeenCalled();
  });

  it("works while a run holds the bot's lane", async () => {
    const { app, workspace, reply } = await setup();
    const ctx = app.deskmates.ctx;
    const bot = ctx.bots.list(workspace.id)[0];
    if (!bot) throw new Error("no bot");
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "interactive",
      triggerKind: "webhook",
      triggerRef: "busy",
      triggerPayload: { body: "task" },
      config: ctx.runConfig(),
    });
    ctx.runs.transition(run.id, "running");
    reply(ok(Buffer.from("live")));
    const response = await app.inject({
      method: "GET",
      url: url(workspace.id, "/work/a.md"),
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("live");
  });
});

describe("download log", () => {
  it("writes one info line per download with workspace, path, bytes and operator", async () => {
    const { app: gateway, workspace, reply } = await setup();
    const lines: Array<{ msg: string; data: Record<string, unknown> }> = [];
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app);
    registerFileRoutes(app, gateway.deskmates.ctx, {
      log: (msg, data) => lines.push({ msg, data }),
    });
    await app.ready();
    reply(ok(Buffer.from("12345")));
    const response = await app.inject({ method: "GET", url: url(workspace.id, "/work/a.md") });
    expect(response.statusCode).toBe(200);
    expect(lines).toEqual([
      {
        msg: "workspace file downloaded",
        data: { workspaceId: workspace.id, path: "/work/a.md", bytes: 5, operator: "operator" },
      },
    ]);

    // A refusal is logged with its reason, not as a download.
    lines.length = 0;
    reply(failed("payload_too_large"));
    await app.inject({ method: "GET", url: url(workspace.id, "/work/big.bin") });
    await app.inject({ method: "GET", url: url(workspace.id, "/profile/Cookies") });
    expect(lines).toEqual([
      {
        msg: "workspace file download refused",
        data: {
          workspaceId: workspace.id,
          path: "/work/big.bin",
          reason: "payload_too_large",
          operator: "operator",
        },
      },
      {
        msg: "workspace file download refused",
        data: {
          workspaceId: workspace.id,
          path: "/profile/Cookies",
          reason: "forbidden",
          operator: "operator",
        },
      },
    ]);
  });
});
