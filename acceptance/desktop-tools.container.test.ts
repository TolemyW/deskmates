// T2 (ADR-0048 decisions 3, 5, 7, 8, 9 and 11, amendment 1 A5): the desktop variant image and the
// sidecar's desktop-proxy in front of the real LCU, with no model. A scripted MCP client stands in for the
// SDK, as the SDK-shape contract test does. Ten executable cases passed on 2026-10-19; it needs
// Docker on a Linux host and a locally built variant (scripts/build-workspace-desktop-image.sh), named by
// DESKMATES_T2_DESKTOP_IMAGE, with DESKMATES_T2_BASE_IMAGE naming the base it was built from. The
// upstream application cannot be redistributed (decision 12), so no CI host has the image and the
// file skips everywhere else.
//
// The native form needs a test-only derivative built from images/workspace-desktop/fixture,
// selected with DESKMATES_T2_DESKTOP_FIXTURE_IMAGE. The clean production variant has no fixture.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { StartRunRequest, WorkspaceId } from "@deskmates/contracts";
import { DockerProvider } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopInputLocks } from "../packages/gateway/src/desktop/desktop-input-lock.js";
import {
  type Harness,
  TEST_OPERATOR_TOKEN,
  startHarness,
  waitFor,
} from "../packages/gateway/src/test-support/harness.js";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const FIXTURE_IMAGE = process.env.DESKMATES_T2_DESKTOP_FIXTURE_IMAGE ?? "";
const IMAGE = FIXTURE_IMAGE || process.env.DESKMATES_T2_DESKTOP_IMAGE || "";
const BASE = process.env.DESKMATES_T2_BASE_IMAGE ?? "";
const daemon = process.platform === "linux" && docker("info").status === 0;
const available =
  daemon && IMAGE !== "" && BASE !== "" && docker("image", "inspect", IMAGE).status === 0;
if (!available)
  console.warn(
    "[desktop-tools] skipped: needs Docker on Linux and DESKMATES_T2_DESKTOP_IMAGE / DESKMATES_T2_BASE_IMAGE naming a locally built variant and its base",
  );

const container = `deskmates-t2-desktop-${randomBytes(4).toString("hex")}`;

interface Rpc {
  id?: unknown;
  method?: string;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** The SDK side of the desktop proxy, over `docker exec -i`. */
class ScriptedClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<string, (m: Rpc) => void>();
  private seq = 0;
  constructor(environment: Record<string, string> = {}, target = container) {
    this.proc = spawn("docker", [
      "exec",
      "-i",
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      target,
      "deskmates-sidecar",
      "desktop-proxy",
      "--",
      "/opt/lcu/current/bin/lcu",
    ]);
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const m = JSON.parse(line) as Rpc;
      const done = this.waiting.get(JSON.stringify(m.id));
      if (done) {
        this.waiting.delete(JSON.stringify(m.id));
        done(m);
      }
    });
  }
  send(m: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }
  request(method: string, params: unknown, timeoutMs = 60_000): Promise<Rpc> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.waiting.set(JSON.stringify(id), (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.send({ id, method, params });
    });
  }
  async initialize(): Promise<Rpc> {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "deskmates-t2", version: "0" },
    });
    this.send({ method: "notifications/initialized" });
    return init;
  }
  close(): void {
    this.proc.stdin.end();
  }
}

const text = (m: Rpc): string =>
  JSON.stringify((m.result?.content as unknown[] | undefined) ?? m.error ?? "");

/** A valid operator bearer must not bypass the relay's route filter through CONNECT. */
function operatorStatusThroughTunnel(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let socket: Duplex | undefined;
    let settled = false;
    const finish = (error?: Error, status?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      tunnel.destroy();
      if (error) reject(error);
      else resolve(status as number);
    };
    const timer = setTimeout(() => finish(new Error("operator tunnel probe timed out")), 10_000);
    const tunnel = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "CONNECT",
      path: "desktop-gateway.test:80",
    });
    tunnel.once("error", (error) => finish(error));
    tunnel.once("connect", (response, connected) => {
      socket = connected;
      if (response.statusCode !== 200) return finish(new Error("fixture CONNECT was refused"));
      let headers = "";
      connected.on("data", (bytes: Buffer) => {
        headers += bytes.toString("utf8");
        const status = /^HTTP\/1\.1 (\d{3}) /.exec(headers)?.[1];
        if (status) finish(undefined, Number(status));
      });
      connected.once("error", (error) => finish(error));
      connected.once("end", () => finish(new Error("operator tunnel closed before its response")));
      connected.write(
        `GET /api/workspaces HTTP/1.1\r\nHost: desktop-gateway.test\r\nAuthorization: Bearer ${TEST_OPERATOR_TOKEN}\r\nConnection: close\r\n\r\n`,
      );
    });
    tunnel.end();
  });
}

describe.runIf(available)("desktop variant and desktop-proxy (ADR-0048)", () => {
  let client: ScriptedClient;
  let gateway: Harness | undefined;
  let relay: Server | undefined;
  const tunnels = new Set<Duplex>();
  let finishRuns: (() => void) | undefined;
  const coordinatedClients: ScriptedClient[] = [];
  let coordinated: { workspaceId: WorkspaceId; clients: ScriptedClient[]; runs: StartRunRequest[] };

  const coordination = async () => {
    if (coordinated) return coordinated;
    gateway = await startHarness({ runTimeoutSeconds: 600 });
    const h = gateway;
    const seeded = await h.seed();
    const done = new Promise<void>((resolve) => {
      finishRuns = resolve;
    });
    const runs: StartRunRequest[] = [];
    h.provider.onRun(async (request, gw) => {
      runs.push(request);
      await done;
      await gw.post("ended", {
        type: "run_ended",
        runId: request.runId,
        outcome: "completed",
        summary: {
          done: "T2 desktop check",
          reply: "",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
        },
        usage: [],
      });
    });
    for (const bot of [
      seeded.bot,
      h.app.deskmates.ctx.bots.create({
        name: "vega",
        role: "tester",
        workspaceId: seeded.workspace.id,
      }),
    ]) {
      const thread = h.app.deskmates.ctx.threads.create({
        workspaceId: seeded.workspace.id,
        botIds: [bot.id],
      });
      expect(
        (
          await h.api("POST", `/api/threads/${thread.id}/messages`, {
            body: "Hold this synthetic T2 run.",
          })
        ).status,
      ).toBe(201);
    }
    await waitFor(() => runs.length === 2, 5_000, "two live run tokens");
    // This test-only forward proxy exposes only this ephemeral Gateway's internal routes to
    // the container. Operator routes and arbitrary upstream origins are never forwarded.
    relay = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://desktop-gateway.test");
      if (
        url.origin !== "http://desktop-gateway.test" ||
        !/^\/internal\/runs\/[^/]+\/(desktop-lock|events)$/.test(url.pathname)
      ) {
        response.writeHead(403).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const forwarded = await fetch(`${h.baseUrl}${url.pathname}`, {
          method: request.method ?? "POST",
          headers: {
            authorization: request.headers.authorization ?? "",
            "content-type": "application/json",
          },
          body: Buffer.concat(chunks),
        });
        response.writeHead(forwarded.status, { "content-type": "application/json" });
        response.end(await forwarded.text());
      } catch {
        response.writeHead(502).end();
      }
    });
    // Undici tunnels HTTP too. Terminate into this same filtering HTTP listener, so the
    // request inside CONNECT also crosses the route allowlist and then run-token authorization.
    relay.on("connect", (request, socket, head) => {
      if (request.url !== "desktop-gateway.test:80") {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const target = relay?.address();
      if (!target || typeof target === "string") {
        socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: target.port });
      for (const stream of [socket, upstream]) {
        tunnels.add(stream);
        stream.once("close", () => tunnels.delete(stream));
      }
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    await new Promise<void>((resolve) => relay?.listen(0, "0.0.0.0", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("desktop relay has no port");
    const clients = runs.map(
      (request) =>
        new ScriptedClient({
          DESKMATES_EGRESS_PROXY: `http://host.docker.internal:${address.port}`,
          DESKMATES_DESKTOP_COORDINATION: JSON.stringify({
            runId: request.runId,
            attempt: request.attempt,
            token: request.modelAuthToken,
            gatewayBaseUrl: "http://desktop-gateway.test",
            resumed: false,
          }),
        }),
    );
    coordinatedClients.push(...clients);
    for (const c of clients) {
      expect((await c.initialize()).error).toBeUndefined();
      const boot = await c.request("tools/call", {
        name: "js",
        arguments: { code: "await cua.getState()" },
      });
      expect(boot.result?.isError, text(boot)).not.toBe(true);
    }
    coordinated = { workspaceId: seeded.workspace.id, clients, runs };
    return coordinated;
  };

  beforeAll(async () => {
    expect(
      docker(
        "run",
        "-d",
        "--name",
        container,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        "DESKMATES_VNC_PASSWORD=deadbeef",
        "-e",
        "DESKMATES_VNC_VIEW_PASSWORD=cafe1234",
        "-e",
        "DESKMATES_EGRESS_PROXY=http://127.0.0.1:9",
        IMAGE,
      ).status,
    ).toBe(0);
    let healthy = false;
    for (let i = 0; i < 240; i++) {
      const inspected = docker(
        "inspect",
        "--format",
        "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
        container,
      );
      const [running, status] = inspected.stdout.trim().split(" ");
      if (running !== "true") {
        const logged = docker("logs", "--tail", "80", container);
        const logs = `${logged.stdout}${logged.stderr}`;
        throw new Error(`desktop variant exited before it became healthy: ${logs}`);
      }
      if (status === "healthy") {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) {
      const logged = docker("logs", "--tail", "80", container);
      const logs = `${logged.stdout}${logged.stderr}`;
      throw new Error(`desktop variant did not become healthy: ${logs}`);
    }
    client = new ScriptedClient();
    if (FIXTURE_IMAGE) {
      expect(
        docker("exec", "-d", container, "python3", "/opt/deskmates/desktop-fixture.py").status,
      ).toBe(0);
      await waitFor(
        () =>
          docker("exec", container, "xdotool", "search", "--name", "^Deskmates T2 Fixture$")
            .status === 0,
        10_000,
        "native fixture window",
      );
    }
  }, 180_000);

  afterAll(async () => {
    client?.close();
    for (const c of coordinatedClients) c.close();
    finishRuns?.();
    for (const socket of tunnels) socket.destroy();
    await gateway?.close();
    relay?.closeAllConnections();
    if (relay) await new Promise<void>((resolve) => relay?.close(() => resolve()));
    docker("rm", "-f", container);
  });

  it("declares the capability and adds no privilege over the base (decisions 9, 11)", () => {
    const facts = (image: string) =>
      JSON.parse(docker("image", "inspect", image).stdout)[0] as {
        Config: { Labels?: Record<string, string>; Env?: string[]; User?: string };
      };
    const desktop = facts(IMAGE);
    const base = facts(BASE);
    expect(desktop.Config.Labels?.["org.deskmates.capabilities"]).toBe("desktop-lcu-v1");
    expect(desktop.Config.Env).toContain("DESKMATES_IMAGE_CAPABILITIES=desktop-lcu-v1");
    expect(desktop.Config.User ?? "").toBe(base.Config.User ?? "");
    expect(docker("exec", container, "test", "-e", "/var/lib/apt/lists/lock").status).not.toBe(0);
  });

  it("passes the upstream instructions through and shows js and js_reset only (decisions 3, 7)", async () => {
    const init = await client.initialize();
    expect(typeof init.result?.instructions).toBe("string");
    expect(String(init.result?.instructions).length).toBeGreaterThan(0);
    const listed = await client.request("tools/list", {});
    const names = (listed.result?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["js", "js_reset"]);
    const hostOnly = await client.request("tools/call", { name: "turn_ended", arguments: {} });
    expect(hostOnly.result?.isError).toBe(true);
  }, 120_000);

  it("wraps desktop text and keeps a screenshot's media type (decision 8)", async () => {
    const state = await client.request("tools/call", {
      name: "js",
      arguments: { code: "const s = await cua.getState(); JSON.stringify(s).slice(0, 2000)" },
    });
    expect(text(state)).toContain('<untrusted source=\\"desktop:lcu\\">');
    const shot = await client.request("tools/call", {
      name: "js",
      arguments: {
        code: "let windows = await cua.listWindows(); let app = await cua.getApp({ windowId: windows[0].id }); await app.getAXStateAndScreenshot();",
      },
    });
    const image = (shot.result?.content as { type: string; mimeType?: string }[]).find(
      (c) => c.type === "image",
    );
    expect(image, JSON.stringify(shot)).toBeDefined();
    expect(image?.mimeType).toMatch(/^image\/(jpeg|png)$/);
  }, 120_000);

  it("kills LCU after a cancelled call and restarts it with the rediscovery notice (decisions 5, 7)", async () => {
    const id = 9_000;
    client.send({
      id,
      method: "tools/call",
      params: { name: "js", arguments: { code: "await new Promise((r) => setTimeout(r, 60000))" } },
    });
    await new Promise((r) => setTimeout(r, 1_000));
    client.send({ method: "notifications/cancelled", params: { requestId: id } });
    await new Promise((r) => setTimeout(r, 4_000));
    const after = await client.request("tools/call", { name: "js", arguments: { code: "1 + 1" } });
    expect(text(after)).toContain("this desktop session is new");
  }, 120_000);

  it("reads XTEST input as raw events with the image's reader (amendment 1, A5)", () => {
    const out = docker(
      "exec",
      container,
      "sh",
      "-c",
      "timeout 4 $DESKMATES_DESKTOP_INPUT_RECORDER > /tmp/xi2.log 2>&1 & reader=$!; sleep 1; xdotool key shift; xdotool mousemove 30 40 mousemove_relative -- 10 10 click 1; sleep 1; kill $reader 2>/dev/null || true; cat /tmp/xi2.log",
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/EVENT type \d+ \(RawKeyPress\)/);
    expect(out.stdout).toMatch(/EVENT type \d+ \(RawButtonPress\)/);
    expect(out.stdout).toMatch(/EVENT type \d+ \(RawMotion\)/);
  }, 30_000);

  it("dispatches nothing during human takeover and cancels a live call on the new epoch", async () => {
    const { workspaceId, clients } = await coordination();
    const c = clients[0] as ScriptedClient;
    const h = gateway as Harness;
    const address = relay?.address();
    if (!address || typeof address === "string") throw new Error("desktop relay has no port");
    expect(await operatorStatusThroughTunnel(address.port)).toBe(403);
    expect(
      (await h.api("POST", `/api/workspaces/${workspaceId}/takeover`, { authorId: "ops" })).status,
    ).toBe(200);
    const denied = await c.request("tools/call", {
      name: "js",
      arguments: { code: "globalThis.forbiddenDesktopWrite = true" },
    });
    expect(text(denied)).toContain("human");
    expect(
      (await h.api("POST", `/api/workspaces/${workspaceId}/handback`, { authorId: "ops" })).status,
    ).toBe(200);
    const check = await c.request("tools/call", {
      name: "js",
      arguments: { code: "nodeRepl.write(typeof globalThis.forbiddenDesktopWrite)" },
    });
    expect(text(check)).toContain("undefined");
    const pending = c.request("tools/call", {
      name: "js",
      arguments: { code: "await cua.listWindows(); await new Promise(r => setTimeout(r, 10000));" },
    });
    await waitFor(
      () =>
        desktopInputLocks(h.app.deskmates.ctx)
          .list(workspaceId)
          .some((l) => l.mode === "shared"),
      5_000,
      "live desktop lease",
    );
    await h.api("POST", `/api/workspaces/${workspaceId}/takeover`, { authorId: "ops" });
    expect(text(await pending)).toContain("desktop_call_interrupted");
    await h.api("POST", `/api/workspaces/${workspaceId}/handback`, { authorId: "ops" });
  }, 90_000);

  it("overlaps two focus-free calls and keeps raw input alone under the Gateway lease", async () => {
    const { workspaceId, clients } = await coordination();
    const [a, b] = clients as [ScriptedClient, ScriptedClient];
    const h = gateway as Harness;
    const shared = (c: ScriptedClient) =>
      c.request("tools/call", {
        name: "js",
        arguments: {
          code: "await cua.listWindows(); await new Promise(r => setTimeout(r, 1500));",
        },
      });
    const pending = [shared(a), shared(b)];
    await waitFor(
      () =>
        desktopInputLocks(h.app.deskmates.ctx)
          .list(workspaceId)
          .filter((l) => l.mode === "shared").length === 2,
      5_000,
      "overlapping shared leases",
    );
    for (const result of await Promise.all(pending)) expect(result.result?.isError).not.toBe(true);
    await a.request("tools/call", {
      name: "js",
      arguments: {
        code: "var windows = await cua.listWindows(); var fixture = await cua.getApp({ windowId: windows[0].id });",
      },
    });
    const exclusive = a.request("tools/call", {
      name: "js",
      arguments: {
        code: "await fixture.pressKey('shift'); await new Promise(r => setTimeout(r, 1500));",
      },
    });
    await waitFor(
      () => desktopInputLocks(h.app.deskmates.ctx).exclusiveHeld(workspaceId),
      5_000,
      "exclusive raw input lease",
    );
    const following = shared(b);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      desktopInputLocks(h.app.deskmates.ctx)
        .list(workspaceId)
        .filter((l) => l.mode !== "waiting")
        .map((l) => l.mode),
    ).toEqual(["exclusive"]);
    const peer = coordinated.runs[1] as StartRunRequest;
    const browser = await fetch(`${h.baseUrl}/internal/runs/${peer.runId}/browser-lock`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${peer.modelAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "browser_lock", runId: peer.runId, op: "acquire" }),
    });
    expect(await browser.json()).toMatchObject({ granted: false });
    expect((await exclusive).result?.isError).not.toBe(true);
    expect((await following).result?.isError).not.toBe(true);
  }, 90_000);
  it("records key input for its exclusive call and zero input for overlapping read-only calls", async () => {
    const { workspaceId, clients, runs } = await coordination();
    const [a, b] = clients as [ScriptedClient, ScriptedClient];
    const h = gateway as Harness;
    const recordFor = (run: StartRunRequest, id: string) =>
      h.app.deskmates.ctx.events
        .list(run.runId)
        .find(
          (e) =>
            e.payload.source === "desktop" &&
            e.payload.op === "input_record" &&
            e.payload.toolUseId === id,
        )?.payload;
    const call = (c: ScriptedClient, id: string, code: string) =>
      c.request("tools/call", {
        name: "js",
        arguments: { code },
        _meta: { "claudecode/toolUseId": id },
      });
    const reads = [
      call(a, "t2-read-a", "await cua.listWindows(); await new Promise(r => setTimeout(r, 1000));"),
      call(b, "t2-read-b", "await cua.listWindows(); await new Promise(r => setTimeout(r, 1000));"),
    ];
    await waitFor(
      () =>
        desktopInputLocks(h.app.deskmates.ctx)
          .list(workspaceId)
          .filter((l) => l.mode === "shared").length === 2,
      5_000,
      "two read calls",
    );
    for (const result of await Promise.all(reads))
      expect(result.result?.isError, text(result)).not.toBe(true);
    const input = await call(
      a,
      "t2-key",
      "var inputProcess = await import('node:child_process'); inputProcess.execFileSync('/usr/bin/xdotool', ['key', 'shift'], {env: {DISPLAY: ':99', PATH: '/usr/bin:/bin'}}); await new Promise(r => setTimeout(r, 200));",
    );
    expect(input.result?.isError, text(input)).not.toBe(true);
    const first = runs[0] as StartRunRequest;
    const second = runs[1] as StartRunRequest;
    await waitFor(
      () =>
        recordFor(first, "t2-key") !== undefined && recordFor(second, "t2-read-b") !== undefined,
      5_000,
      "durable input records",
    );
    for (const [run, id] of [
      [first, "t2-read-a"],
      [second, "t2-read-b"],
    ] as const)
      expect(recordFor(run, id)).toMatchObject({ mode: "shared", keys: 0, buttons: 0, motions: 0 });
    expect(recordFor(first, "t2-key")).toMatchObject({
      mode: "exclusive",
      keys: expect.any(Number),
    });
    expect(Number(recordFor(first, "t2-key")?.keys)).toBeGreaterThan(0);
    expect(Object.keys(recordFor(first, "t2-key") ?? {})).not.toContain("keycode");
  }, 90_000);
  it.skipIf(!FIXTURE_IMAGE)(
    "saves the native GTK fixture with the exact multilingual bytes typed through js",
    async () => {
      const { clients } = await coordination();
      const c = clients[1] as ScriptedClient;
      const expected = "Deskmates native verification 中文 ✅";
      const invoke = async (code: string) => {
        const result = await c.request("tools/call", { name: "js", arguments: { code } });
        expect(result.result?.isError, text(result)).not.toBe(true);
        return (result.result?.content as { type: string; text?: string }[])
          .filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n");
      };
      const initial = await invoke(
        "var candidates = await cua.listWindows(); var nativeWindow = candidates.find(w => w.title === 'Deskmates T2 Fixture'); var nativeFixture = await cua.getApp({ windowId: nativeWindow.id });",
      );
      const input = /^\s*(\d+) text.*Verification text/m.exec(initial)?.[1];
      expect(input, initial).toBeDefined();
      const filled = await invoke(
        `await nativeFixture.click(${input}); await nativeFixture.pressKey('ctrl+a'); await nativeFixture.typeText(${JSON.stringify(expected)}); await nativeFixture.getAXState();`,
      );
      expect(filled).toContain(expected);
      const button = /^\s*(\d+) push button Save verification\s*$/m.exec(filled)?.[1];
      expect(button, filled).toBeDefined();
      const saved = await invoke(
        `await nativeFixture.click(${button}); await nativeFixture.getAXState();`,
      );
      expect(saved).toMatch(/\d+ text Saved/);
      const bytes = docker("exec", container, "cat", "/tmp/deskmates-native-fixture.txt");
      expect(bytes.status).toBe(0);
      expect(Buffer.from(bytes.stdout, "utf8")).toEqual(Buffer.from(expected, "utf8"));
      const capture = await c.request("tools/call", {
        name: "js",
        arguments: { code: "await nativeFixture.getAXStateAndScreenshot();" },
      });
      const image = (
        capture.result?.content as { type: string; mimeType?: string; data?: string }[]
      ).find((item) => item.type === "image");
      expect(image?.mimeType, text(capture)).toMatch(/^image\/(jpeg|png)$/);
      const evidence = process.env.DESKMATES_DESKTOP_EVIDENCE_DIR;
      if (evidence && image?.data) {
        mkdirSync(evidence, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(evidence, image.mimeType === "image/jpeg" ? "native-saved.jpg" : "native-saved.png"),
          Buffer.from(image.data, "base64"),
          { mode: 0o600 },
        );
      }
    },
    90_000,
  );
  it("refuses a private-address request from the real LCU kernel at the managed egress proxy", async () => {
    const provider = new DockerProvider({
      egressProxyImage: process.env.EGRESS_PROXY_IMAGE || "deskmates/egress-proxy:dev",
    });
    const handle = await provider.create({
      workspaceId: `t2-desktop-egress-${randomBytes(4).toString("hex")}` as WorkspaceId,
      image: IMAGE,
      env: { DESKMATES_VNC_PASSWORD: "deadbeef", DESKMATES_VNC_VIEW_PASSWORD: "cafe1234" },
      egressAllowlist: [],
      volumes: {},
      ports: [],
    });
    let c: ScriptedClient | undefined;
    try {
      await waitFor(
        () => docker("exec", handle.providerRef, "deskmates-healthz").status === 0,
        90_000,
        "B4 desktop workspace",
      );
      c = new ScriptedClient({}, handle.providerRef);
      expect((await c.initialize()).error).toBeUndefined();
      await c.request("tools/call", { name: "js", arguments: { code: "await cua.getState()" } });
      const result = await c.request("tools/call", {
        name: "js",
        arguments: {
          code: "var http = await import('node:http'); var status = await new Promise((resolve, reject) => { var req = http.request({hostname: 'egress-proxy', port: 3128, method: 'GET', path: 'http://10.255.255.250/', headers: {host: '10.255.255.250'}}, res => {res.resume(); resolve(res.statusCode)}); req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout'))); req.end(); }); nodeRepl.write(status);",
        },
      });
      expect(result.result?.isError, text(result)).not.toBe(true);
      expect(text(result)).toContain("403");
      const inspected = JSON.parse(docker("inspect", handle.providerRef).stdout)[0] as {
        NetworkSettings: { Networks: Record<string, unknown> };
      };
      const networks = Object.keys(inspected.NetworkSettings.Networks);
      expect(networks).toHaveLength(1);
      expect(
        docker(
          "network",
          "inspect",
          "--format",
          "{{.Internal}}",
          networks[0] as string,
        ).stdout.trim(),
      ).toBe("true");
    } finally {
      c?.close();
      await provider.destroy(handle);
    }
  }, 120_000);
});
