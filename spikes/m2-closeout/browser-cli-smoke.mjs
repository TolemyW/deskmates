// T2 driver. Only short-lived run tokens arrive on stdin; no operator credential enters the VM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { executeBrowserCliWorkflow } from "file:///opt/deskmates/sidecar/dist/browser-cli-workflow.js";
import { GatewayClient } from "file:///opt/deskmates/sidecar/dist/gateway-client.js";
import { installManagedFetchProxy } from "file:///opt/deskmates/sidecar/dist/managed-proxy.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const config = JSON.parse(Buffer.concat(chunks).toString());
installManagedFetchProxy(process.env);
const children = [];
const readState = async (run) => JSON.parse(await readFile(run.statePath, "utf8"));
const resultText = (result) =>
  (result.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

async function connect(run) {
  const child = spawn(
    "deskmates-sidecar",
    ["mcp-proxy", "--", "playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9222", "--caps", "vision"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DESKMATES_BROWSER_COORDINATION: JSON.stringify(run) },
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    clearTimeout(wait.timer);
    message.error ? wait.reject(new Error(JSON.stringify(message.error))) : wait.resolve(message.result);
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out; stderr=" + stderr));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "deskmates-t2-native-cli", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { tool: (name, args = {}) => rpc("tools/call", { name, arguments: args }) };
}

try {
  const [run, peer] = config.runs;
  const [a, b] = await Promise.all(config.runs.map(connect));
  for (const [client, suffix] of [[a, "run"], [b, "peer"]]) {
    const result = await client.tool("browser_navigate", { url: config.site + "/login?cli=" + suffix });
    assert(!result.isError, resultText(result));
  }
  const [runState, peerState] = await Promise.all([readState(run), readState(peer)]);
  assert(runState.tabId && peerState.tabId);
  assert.notEqual(runState.tabId, peerState.tabId);

  const gateway = new GatewayClient(fetch, run.gatewayBaseUrl, run.runId, run.token);
  const screenshots = [];
  const outcome = await executeBrowserCliWorkflow(
    {
      expectedOrigin: config.site,
      steps: [{ action: "fill", locator: "#email", value: "native-cli-run@example.com" }],
    },
    {
      runId: run.runId,
      cdpEndpoint: "http://127.0.0.1:9222",
      coordination: { ...run, browserExecutionMode: "vision-cli-v2" },
    },
    {
      client: gateway,
      readBrowserState: () => readState(run),
      onScreenshot: (capture) => screenshots.push(capture),
    },
  );
  assert(outcome.ok, outcome.text);
  assert.equal(outcome.mayHaveCompleted, false);
  assert.equal(screenshots.length, 1, "one final CLI screenshot");
  const shot = screenshots[0];
  assert.equal(shot.tabId, runState.tabId, "capture belongs to exact run tab");
  assert.equal(shot.mimeType, "image/jpeg");
  assert(shot.bytes > 100 && shot.bytes <= 300000);
  assert.equal(Buffer.from(shot.base64, "base64").length, shot.bytes);

  // These reads use the original MCP connections after CLI detach. A detached CLI must leave the
  // shared Chromium and both independently selected run targets usable.
  const values = [];
  for (const client of [a, b]) {
    const observed = await client.tool("browser_run_code_unsafe", {
      code: "async(page) => ({ email: await page.locator('#email').inputValue(), url: page.url() })",
    });
    assert(!observed.isError, resultText(observed));
    values.push(resultText(observed));
  }
  assert(values[0].includes("native-cli-run@example.com"), values[0]);
  assert(!values[1].includes("native-cli-run@example.com"), values[1]);
  assert(values[0].includes("cli=run"), values[0]);
  assert(values[1].includes("cli=peer"), values[1]);
  assert.equal((await readState(run)).tabId, runState.tabId);
  assert.equal((await readState(peer)).tabId, peerState.tabId);
  console.log(JSON.stringify({
    passed: true,
    distinctTargets: true,
    exactRunFill: true,
    peerUnchanged: true,
    screenshotTabId: shot.tabId,
    screenshotBytes: shot.bytes,
    browserSurvivedDetach: true,
  }));
} finally {
  for (const child of children) child.kill("SIGTERM");
}
