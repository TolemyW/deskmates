// T2: snapshot refs belong to the page snapshot that produced them. The pinned MCP must reject an
// old ref after navigation in both automatic snapshot modes, while an unscoped explicit snapshot
// refreshes the tree and makes its new refs usable. No model or public network is involved.

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
const HEALTH_TIMEOUT_MS = 90_000;

async function waitHealthy(handle: SandboxHandle): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const result = await provider.exec(handle, { cmd: ["deskmates-healthz"], timeoutMs: 10_000 });
    if (result.exitCode === 0) return;
    last = result.stderr || result.stdout;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`workspace container did not become healthy: ${last.trim()}`);
}

describe.skipIf(!available)("M2 snapshot reference lifetime (T2, pinned MCP)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-ref-${suffix}` as WorkspaceId;
  const volumes = [
    `deskmates-t2-ref-work-${suffix}`,
    `deskmates-t2-ref-profile-${suffix}`,
    `deskmates-t2-ref-home-${suffix}`,
  ];
  let handle: SandboxHandle | undefined;

  beforeAll(async () => {
    await ensureWorkspaceImage(provider, image);
    handle = await provider.create({
      workspaceId,
      image,
      env: { DESKMATES_VNC_PASSWORD: "deadbeef", DESKMATES_VNC_VIEW_PASSWORD: "cafe1234" },
      egressAllowlist: [],
      volumes: {
        "/work": volumes[0] as string,
        "/profile": volumes[1] as string,
        "/home": volumes[2] as string,
      },
      ports: [],
    });
    await waitHealthy(handle);
  }, 180_000);

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
    for (const volume of volumes) {
      await provider.client
        .request("DELETE", `/volumes/${volume}?force=true`)
        .catch(() => undefined);
    }
  }, 120_000);

  it("rejects a pre-navigation ref and accepts a refreshed ref in none and full modes", async () => {
    if (!handle) throw new Error("workspace was not created");
    const script = String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { browserMcpServer } from "file:///opt/deskmates/sidecar/dist/browser-mcp.js";

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const mode = url.searchParams.get("mode") || "unknown";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url.pathname === "/after") {
    res.end('<!doctype html><title>After</title><main><h1>AFTER_' + mode + '</h1><button>Fresh action</button></main>');
    return;
  }
  res.end('<!doctype html><title>Before</title><main><h1>BEFORE_' + mode + '</h1><form action="/after"><input type="hidden" name="mode" value="' + mode + '"><button>Replace page</button></form></main>');
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "0.0.0.0", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("probe server has no port");

function resultText(result) {
  return (result.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function run(mode) {
  const config = browserMcpServer(process.env);
  if (config.type !== "stdio") throw new Error("browser MCP config is not stdio");
  const args = [...(config.args || [])];
  const modeIndex = args.indexOf("--snapshot-mode");
  if (modeIndex < 0 || modeIndex + 1 >= args.length) throw new Error("snapshot mode is not configured");
  args[modeIndex + 1] = mode;
  const child = spawn(config.command, args, {
    env: { ...process.env, ...(config.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const settle = pending.get(String(message.id));
      if (settle) { pending.delete(String(message.id)); settle(message); }
    }
  });
  function send(message) { child.stdin.write(JSON.stringify(message) + "\n"); }
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
  const tool = (name, arguments_) => rpc("tools/call", { name, arguments: arguments_ || {} });
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "deskmates-t2-ref-" + mode, version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const navigate = await tool("browser_navigate", {
      url: "http://localhost:" + address.port + "/before?mode=" + mode,
    });
    if (navigate.isError) throw new Error("navigate failed: " + resultText(navigate));
    const before = await tool("browser_snapshot");
    if (before.isError) throw new Error("before snapshot failed: " + resultText(before));
    const beforeText = resultText(before);
    const oldMainRef = /main \[ref=([^\]]+)\]/.exec(beforeText)?.[1];
    const replaceRef = /button "Replace page" \[ref=([^\]]+)\]/.exec(beforeText)?.[1];
    if (!oldMainRef || !replaceRef) throw new Error("before refs missing: " + beforeText);
    const click = await tool("browser_click", { target: replaceRef });
    if (click.isError) throw new Error("navigation click failed: " + resultText(click));
    const stale = await tool("browser_snapshot", { target: oldMainRef });
    const refreshed = await tool("browser_snapshot");
    if (refreshed.isError) throw new Error("refresh snapshot failed: " + resultText(refreshed));
    const refreshedText = resultText(refreshed);
    const newMainRef = /main \[ref=([^\]]+)\]/.exec(refreshedText)?.[1];
    if (!newMainRef) throw new Error("refreshed main ref missing: " + refreshedText);
    const scopedFresh = await tool("browser_snapshot", { target: newMainRef });
    if (scopedFresh.isError) throw new Error("fresh scoped snapshot failed: " + resultText(scopedFresh));
    return {
      mode,
      oldMainRef,
      newMainRef,
      clickText: resultText(click),
      staleIsError: stale.isError === true,
      staleText: resultText(stale),
      refreshedText,
      scopedFreshText: resultText(scopedFresh),
    };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

try {
  const evidence = [];
  for (const mode of ["none", "full"]) evidence.push(await run(mode));
  process.stdout.write(JSON.stringify(evidence));
} finally {
  await new Promise((resolve) => server.close(resolve));
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
      mode: "none" | "full";
      oldMainRef: string;
      newMainRef: string;
      clickText: string;
      staleIsError: boolean;
      staleText: string;
      refreshedText: string;
      scopedFreshText: string;
    }[];
    expect(evidence.map((entry) => entry.mode)).toEqual(["none", "full"]);
    for (const entry of evidence) {
      expect(entry.staleIsError).toBe(true);
      expect(entry.staleText).toContain(`Ref ${entry.oldMainRef} not found`);
      expect(entry.newMainRef).not.toBe(entry.oldMainRef);
      expect(entry.refreshedText).toContain(`AFTER_${entry.mode}`);
      expect(entry.scopedFreshText).toContain(`AFTER_${entry.mode}`);
    }
    expect(evidence[0]?.clickText).not.toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
    expect(evidence[1]?.clickText).toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
  }, 120_000);
});
