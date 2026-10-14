// T2: real pinned MCP target errors cross the opt-in proxy and its second stale lookup returns
// a fresh image. The failed click is never retried. No model or public network is involved.

import { randomUUID } from "node:crypto";
import type { SandboxHandle, WorkspaceId } from "@deskmates/contracts";
import { DockerProvider } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dockerAvailable,
  ensureWorkspaceImage,
  testDockerProviderOptions,
  workspaceImage,
} from "./support/docker.js";

const available = await dockerAvailable();
const provider = new DockerProvider(testDockerProviderOptions());
const image = workspaceImage();

describe.skipIf(!available)("M2 vision fallback (T2, pinned MCP)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-vision-${suffix}` as WorkspaceId;
  const volumes = [
    `deskmates-t2-vision-work-${suffix}`,
    `deskmates-t2-vision-profile-${suffix}`,
    `deskmates-t2-vision-home-${suffix}`,
  ];
  let handle: SandboxHandle | undefined;

  beforeAll(async () => {
    await ensureWorkspaceImage(provider, image);
    handle = await provider.create({
      workspaceId,
      image,
      env: { DESKMATES_VNC_PASSWORD: "abcdef12", DESKMATES_VNC_VIEW_PASSWORD: "1234abcd" },
      egressAllowlist: [],
      volumes: {
        "/work": volumes[0] as string,
        "/profile": volumes[1] as string,
        "/home": volumes[2] as string,
      },
      ports: [],
    });
    const deadline = Date.now() + 90_000;
    let last = "";
    while (Date.now() < deadline) {
      const healthy = await provider.exec(handle, {
        cmd: ["deskmates-healthz"],
        timeoutMs: 10_000,
      });
      if (healthy.exitCode === 0) return;
      last = healthy.stderr || healthy.stdout;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`workspace container did not become healthy: ${last.trim()}`);
  }, 180_000);

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    for (const volume of volumes)
      await provider.client
        .request("DELETE", `/volumes/${volume}?force=true`)
        .catch(() => undefined);
  }, 120_000);

  it("attaches a real screenshot after stale target, refresh, stale target", async () => {
    if (!handle) throw new Error("workspace was not created");
    const script = String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { runMcpProxy } from "file:///opt/deskmates/sidecar/dist/mcp-proxy/proxy.js";

const site = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (pathname === "/after") {
    res.end('<!doctype html><title>After</title><main><h1>AFTER</h1><button>Fresh action</button></main>');
    return;
  }
  res.end('<!doctype html><title>Before</title><main><h1>BEFORE</h1><form action="/after"><button>Replace page</button></form></main>');
});
await new Promise((resolve, reject) => {
  site.once("error", reject);
  site.listen(0, "127.0.0.1", resolve);
});
const address = site.address();
if (!address || typeof address === "string") throw new Error("probe server has no port");

const child = spawn("playwright-mcp", [
  "--cdp-endpoint", "http://127.0.0.1:9222", "--caps", "vision", "--snapshot-mode", "none",
], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const upstreamIn = new PassThrough();
const upstreamOut = new PassThrough();
const proxyDone = runMcpProxy({
  upstream: { input: upstreamIn, output: upstreamOut },
  child: { stdin: child.stdin, stdout: child.stdout },
  options: { visionFallback: true },
});
let nextId = 1;
const pending = new Map();
createInterface({ input: upstreamOut }).on("line", (line) => {
  const message = JSON.parse(line);
  const settle = pending.get(String(message.id));
  if (settle) { pending.delete(String(message.id)); settle(message); }
});
function send(message) { upstreamIn.write(JSON.stringify(message) + "\n"); }
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(method + " timed out; stderr=" + stderr));
    }, 30000);
    pending.set(String(id), (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
const tool = (name, args) => rpc("tools/call", { name, arguments: args || {} });
const resultText = (result) => (result.content || [])
  .filter((part) => part.type === "text").map((part) => part.text).join("\n");
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "deskmates-t2-vision", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const navigate = await tool("browser_navigate", { url: "http://localhost:" + address.port + "/before" });
  if (navigate.isError) throw new Error("navigate failed: " + resultText(navigate));
  const before = await tool("browser_snapshot");
  const oldTarget = /button "Replace page" \[ref=([^\]]+)\]/.exec(resultText(before))?.[1];
  if (!oldTarget) throw new Error("replace target missing: " + resultText(before));
  const replace = await tool("browser_click", { target: oldTarget });
  if (replace.isError) throw new Error("replace failed: " + resultText(replace));
  const first = await tool("browser_click", { target: oldTarget });
  const refresh = await tool("browser_snapshot");
  const second = await tool("browser_click", { target: oldTarget });
  const final = await tool("browser_snapshot");
  process.stdout.write(JSON.stringify({
    oldTarget,
    firstError: first.isError === true,
    firstText: resultText(first),
    refreshText: resultText(refresh),
    secondError: second.isError === true,
    secondText: resultText(second),
    images: (second.content || []).filter((part) => part.type === "image")
      .map((part) => ({ mimeType: part.mimeType, bytes: Buffer.from(part.data, "base64").length })),
    finalText: resultText(final),
  }));
} finally {
  upstreamIn.end();
  child.stdin.end();
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.allSettled([
    proxyDone,
    child.exitCode === null ? new Promise((resolve) => child.once("exit", resolve)) : Promise.resolve(),
    new Promise((resolve) => site.close(resolve)),
  ]);
}
`;
    const result = await provider.exec(handle, {
      cmd: ["node", "--input-type=module"],
      cwd: "/work",
      stdin: script,
      timeoutMs: 90_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout) as {
      oldTarget: string;
      firstError: boolean;
      firstText: string;
      refreshText: string;
      secondError: boolean;
      secondText: string;
      images: { mimeType: string; bytes: number }[];
      finalText: string;
    };
    expect(evidence.firstError).toBe(true);
    expect(evidence.firstText).toContain(`Ref ${evidence.oldTarget} not found`);
    expect(evidence.refreshText).toContain("AFTER");
    expect(evidence.secondError).toBe(true);
    expect(evidence.secondText).toContain("Two matching target lookups failed");
    expect(evidence.secondText).toContain("failed action was not retried");
    expect(evidence.images).toEqual([{ mimeType: "image/jpeg", bytes: expect.any(Number) }]);
    expect(evidence.images[0]?.bytes).toBeGreaterThan(100);
    expect(evidence.finalText).toContain("AFTER");
    expect(evidence.finalText).not.toContain("BEFORE");
  }, 120_000);
});
