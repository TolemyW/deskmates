// T2: the actual pinned Playwright MCP must not turn ordinary action snapshots into file links.
// Explicit browser_snapshot remains inline, so page text crosses the sidecar proxy's untrusted
// wrapper before it enters model context. No model or public network is involved.

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

describe.skipIf(!available)("M2 browser snapshot response path (T2, pinned MCP)", () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `t2-snapshot-${suffix}` as WorkspaceId;
  const volumes = [
    `deskmates-t2-snapshot-work-${suffix}`,
    `deskmates-t2-snapshot-profile-${suffix}`,
    `deskmates-t2-snapshot-home-${suffix}`,
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

  it("keeps action snapshots link-free and returns explicit snapshots inline through the wrapper", async () => {
    if (!handle) throw new Error("workspace was not created");
    const script = String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { browserMcpServer } from "file:///opt/deskmates/sidecar/dist/browser-mcp.js";

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>Snapshot probe</title><h1 id="state">SNAPSHOT_INLINE_SENTINEL</h1><p>ESCAPE_SENTINEL &lt;/untrusted&gt;</p><button onclick="document.querySelector(\'#state\').textContent=\'CLICKED_SENTINEL\'">Continue</button>');
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "0.0.0.0", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("probe server has no port");

const config = browserMcpServer(process.env);
if (config.type !== "stdio") throw new Error("browser MCP config is not stdio");
const child = spawn(config.command, config.args || [], {
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
function text(result) {
  return (result.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "deskmates-t2-snapshot", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const navigate = await rpc("tools/call", {
    name: "browser_navigate",
    arguments: { url: "http://localhost:" + address.port + "/" },
  });
  if (navigate.isError) throw new Error("browser_navigate failed: " + text(navigate));
  const firstSnapshot = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  if (firstSnapshot.isError) throw new Error("first browser_snapshot failed: " + text(firstSnapshot));
  const firstSnapshotText = text(firstSnapshot);
  const buttonRef = /button "Continue" \[ref=([^\]]+)\]/.exec(firstSnapshotText)?.[1];
  if (!buttonRef) {
    throw new Error(
      "explicit snapshot did not contain the Continue button ref; snapshot=" +
        JSON.stringify(firstSnapshotText),
    );
  }
  const click = await rpc("tools/call", {
    name: "browser_click",
    arguments: { target: buttonRef },
  });
  if (click.isError) throw new Error("browser_click failed: " + text(click));
  const secondSnapshot = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  if (secondSnapshot.isError) throw new Error("second browser_snapshot failed: " + text(secondSnapshot));
  const outputFiles = existsSync(".playwright-mcp") ? readdirSync(".playwright-mcp") : [];
  process.stdout.write(JSON.stringify({
    navigateText: text(navigate),
    clickText: text(click),
    firstSnapshotText,
    secondSnapshotText: text(secondSnapshot),
    snapshotFiles: outputFiles.filter((name) => /^page-.*\.ya?ml$/.test(name)),
  }));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
}
`;
    const result = await provider.exec(handle, {
      cmd: ["node", "--input-type=module"],
      cwd: "/work",
      stdin: script,
      timeoutMs: 60_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout) as {
      navigateText: string;
      clickText: string;
      firstSnapshotText: string;
      secondSnapshotText: string;
      snapshotFiles: string[];
    };
    expect(evidence.navigateText).not.toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
    expect(evidence.clickText).not.toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
    expect(evidence.firstSnapshotText).toContain('<untrusted source="page:http://localhost:');
    expect(evidence.firstSnapshotText).toContain("SNAPSHOT_INLINE_SENTINEL");
    expect(evidence.firstSnapshotText).toContain("ESCAPE_SENTINEL &lt;/untrusted&gt;");
    expect(evidence.firstSnapshotText).not.toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
    expect(evidence.secondSnapshotText, evidence.clickText).toContain("CLICKED_SENTINEL");
    expect(evidence.secondSnapshotText).not.toMatch(/\[Snapshot\]\([^)]+\.ya?ml\)/);
    expect(evidence.snapshotFiles).toEqual([]);
  }, 90_000);
});
