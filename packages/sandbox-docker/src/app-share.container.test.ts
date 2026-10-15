// T2 (ADR-0035 decisions 4 and 7): a tiny frontend + backend app started detached inside a real
// workspace container answers through the egress proxy's app relay on host loopback. The page
// carries a form, the form posts to the backend's API, and a client-side route refreshed in the
// browser gets the same page. The workspace publishes no port of its own; the relay refuses a
// wrong key and the screen relay ports. Uses `node:22-alpine` as the workspace image so the app
// needs nothing installed. Build the egress image from this tree first and point
// EGRESS_PROXY_IMAGE at it; skips when Docker is unreachable.

import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { SandboxHandle, WorkspaceId } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_EGRESS_PROXY_IMAGE, DockerProvider } from "./docker-provider.js";
import { requireEgressImage } from "./testing/image-preflight.js";

const IMAGE = "node:22-alpine";
const EGRESS_IMAGE = process.env.EGRESS_PROXY_IMAGE?.trim() || DEFAULT_EGRESS_PROXY_IMAGE;
const PORT = 3000;

/** One port serves the page (any non-API path, so client routes refresh) and the API. */
const APP = `
const http = require("node:http");
const todos = [];
const page = '<!doctype html><title>Todo</title><form method="post" action="/api/todos">' +
  '<input name="title"><button>Add</button></form><script>document.title += " ready";</script>';
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/todos") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      todos.push(new URLSearchParams(body).get("title"));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ todos }));
    });
    return;
  }
  if (req.url === "/api/todos") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ todos }));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
}).listen(${PORT}, "0.0.0.0");
`;

async function dockerReachable(p: DockerProvider): Promise<boolean> {
  try {
    const res = await p.client.request("GET", "/_ping", undefined, { timeoutMs: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

const provider = new DockerProvider({
  containerCommand: ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"],
  egressProxyImage: EGRESS_IMAGE,
});
const available = await dockerReachable(provider);
if (!available) console.warn("[app-share.container.test] Docker daemon unreachable; skipping.");

/** Open the relay, name the port with `key`; resolves with the socket or the relay's refusal. */
function relay(handle: SandboxHandle, port: number, key = handle.appRelayKey ?? "") {
  const [host, relayPort] = (handle.appRelayAddress ?? "").split(":");
  return new Promise<net.Socket | string>((resolve, reject) => {
    const socket = net.connect({ host: host ?? "127.0.0.1", port: Number(relayPort) });
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      const end = text.indexOf("\n");
      if (end < 0) return;
      socket.off("data", onData);
      if (text.slice(0, end) === "OK") resolve(socket);
      else {
        socket.destroy();
        resolve(text.slice(0, end));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`DESKMATES-APP/1 ${key} ${port}\n`);
  });
}

async function request(
  handle: SandboxHandle,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const socket = await relay(handle, PORT);
  if (typeof socket === "string") throw new Error(`relay refused: ${socket}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path,
        headers: {
          host: "label.apps.localhost",
          connection: "close",
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        createConnection: () => socket,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe.skipIf(!available)("published app through the egress proxy relay (T2)", () => {
  const workspaceId = `t2-app-${randomUUID().slice(0, 8)}` as WorkspaceId;
  let handle: SandboxHandle;

  beforeAll(async () => {
    await requireEgressImage(provider, EGRESS_IMAGE);
    if ((await provider.client.request("GET", `/images/${IMAGE}/json`)).status !== 200)
      throw new Error(`${IMAGE} is not present locally; pull it once before this test`);
    handle = await provider.create({
      workspaceId,
      image: IMAGE,
      env: {},
      volumes: {},
      ports: [],
      egressAllowlist: [],
    });
    // Detached, as the tool tells a bot to start it: it must outlive this exec.
    const started = await provider.exec(handle, {
      cmd: ["sh", "-c", "cat > /tmp/app.js && (setsid node /tmp/app.js > /tmp/app.log 2>&1 &)"],
      stdin: APP,
      timeoutMs: 15_000,
    });
    expect(started.exitCode).toBe(0);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const socket = await relay(handle, PORT);
      if (typeof socket !== "string") {
        socket.destroy();
        break;
      }
      if (Date.now() > deadline) throw new Error(`app never answered: ${socket}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 180_000);

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
  }, 60_000);

  it("reaches the app through a loopback relay, not a port of the workspace", async () => {
    expect(handle.appRelayAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(handle.appRelayKey).toMatch(/^[0-9a-f]{32}$/);
    const inspect = await provider.client.request("GET", `/containers/${handle.providerRef}/json`);
    const ports = (JSON.parse(inspect.body) as { NetworkSettings: { Ports: unknown } })
      .NetworkSettings.Ports;
    expect(Object.values(ports ?? {}).filter((binding) => binding !== null)).toEqual([]);
  });

  it("loads the page, round-trips the form through the API, and refreshes a client route", async () => {
    const page = await request(handle, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<form method="post" action="/api/todos">');
    const posted = await request(handle, "POST", "/api/todos", "title=milk");
    expect(posted.status).toBe(201);
    expect(JSON.parse(posted.body)).toEqual({ todos: ["milk"] });
    expect(JSON.parse((await request(handle, "GET", "/api/todos")).body)).toEqual({
      todos: ["milk"],
    });
    const refreshed = await request(handle, "GET", "/todos/7");
    expect(refreshed.body).toBe(page.body);
  });

  it("refuses a wrong key, the screen relay ports and a port with nothing listening", async () => {
    expect(await relay(handle, PORT, "f".repeat(32))).toBe("ERR key");
    expect(await relay(handle, 6080)).toBe("ERR port");
    expect(await relay(handle, 22)).toBe("ERR port");
    expect(await relay(handle, 3999)).toBe("ERR unreachable");
  });
});
