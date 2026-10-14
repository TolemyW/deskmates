import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const rounds = Number(process.env.PROBE_ROUNDS ?? 8);
const mode = process.env.PROBE_MODE ?? "concurrent-natural";
const concurrencyPattern = process.env.PROBE_CONCURRENCY_PATTERN ?? "natural";
const outputDir = process.env.PROBE_OUTPUT_DIR ?? "/probe-output";
const idleMs = Number(process.env.PROBE_INTER_ROUND_IDLE_MS ?? 10_000);
if (!Number.isInteger(rounds) || rounds < 8) throw new Error("PROBE_ROUNDS must be an integer >= 8");
if (!Number.isInteger(idleMs) || idleMs < 0) {
  throw new Error("PROBE_INTER_ROUND_IDLE_MS must be a non-negative integer");
}
if (concurrencyPattern !== "natural" && concurrencyPattern !== "steal") {
  throw new Error("PROBE_CONCURRENCY_PATTERN must be natural or steal");
}
await mkdir(outputDir, { recursive: true });
const probeSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");

const rows = Array.from(
  { length: 180 },
  (_, index) => `<li><strong>Ticket ${1000 + index}</strong><span>capture provenance row ${index}</span></li>`,
).join("");
const html = `<!doctype html>
<meta charset="utf-8"><title>Deskmates capture probe</title>
<style>
body{font:14px system-ui;margin:0;background:#f5f7fb;color:#182238}
header{position:sticky;top:0;background:#182238;color:white;padding:14px 22px}
main{padding:18px 22px}.identity{font:700 18px monospace}ul{display:grid;grid-template-columns:1fr 1fr;gap:6px;list-style:none;padding:0}
li{display:flex;justify-content:space-between;background:white;border:1px solid #ccd4e0;border-radius:5px;padding:7px 10px}
</style>
<header>target=<span id="target"></span> round=<span id="round">0</span> counter=<span id="counter">0</span></header>
<main><p class="identity">Fixed target content for screenshot attribution</p><ul>${rows}</ul></main>
<script>
const query=new URLSearchParams(location.search);document.querySelector('#target').textContent=query.get('target');
globalThis.setProbeRound=(value)=>{const round=document.querySelector('#round');const counter=document.querySelector('#counter');round.textContent=String(value);counter.textContent=String(Number(counter.textContent)+1);return {round:round.textContent,counter:counter.textContent}};
</script>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(8082, "127.0.0.1", resolve);
});

const children = [];
function textOf(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
function resultJson(result) {
  const match = /^### Result\n([^\n]+)(?:\n|$)/m.exec(textOf(result));
  if (!match?.[1]) throw new Error(`missing run-code result: ${textOf(result).slice(0, 500)}`);
  return JSON.parse(match[1]);
}
function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function mcpClient(label) {
  const child = spawn(
    "playwright-mcp",
    [
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
      "--caps",
      "vision",
      "--snapshot-mode",
      "none",
      "--timeout-action",
      "5000",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let serial = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `${label}-${++serial}`;
      // This only detects a dead MCP process. The tested Playwright action timeout remains 5000 ms.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP transport did not answer ${method} within 7000 ms`));
      }, 7000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: label, version: "1" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  return {
    label,
    stderr,
    tool: (name, args = {}) => call("tools/call", { name, arguments: args }),
  };
}

const focusCode = `async (page) => {
  const key = Symbol.for('deskmates.captureProbe.focusSession.v1');
  let session = page[key];
  if (!session) { session = await page.context().newCDPSession(page); page[key] = session; }
  const { targetInfo } = await session.send('Target.getTargetInfo');
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { targetId: targetInfo.targetId, url: page.url(), visibility: await page.evaluate(() => document.visibilityState), hasFocus: await page.evaluate(() => document.hasFocus()) };
}`;
function identityCode(expectedTargetId, expectedLabel, expectedUrl, round, bring) {
  return `async (page) => {
    const session = await page.context().newCDPSession(page);
    try {
      const before = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
      if (before !== ${JSON.stringify(expectedTargetId)}) throw new Error('target changed before screenshot');
      if (${bring}) await page.bringToFront();
      const after = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
      const state = await page.evaluate(() => ({ label: document.querySelector('#target')?.textContent, round: document.querySelector('#round')?.textContent, counter: document.querySelector('#counter')?.textContent, visibility: document.visibilityState, hasFocus: document.hasFocus() }));
      if (after !== before || page.url() !== ${JSON.stringify(expectedUrl)} || state.label !== ${JSON.stringify(expectedLabel)} || state.round !== ${JSON.stringify(String(round))} || state.counter !== ${JSON.stringify(String(round))}) throw new Error('page identity/content changed around screenshot');
      return { targetId: after, url: page.url(), ...state, broughtToFront: ${bring} };
    } finally { await session.detach(); }
  }`;
}
function updateCode(expectedTargetId, label, round) {
  return `async (page) => {
    const session = await page.context().newCDPSession(page);
    try {
      const id = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
      if (id !== ${JSON.stringify(expectedTargetId)}) throw new Error('target changed before counter update');
      const state = await page.evaluate((value) => globalThis.setProbeRound(value), ${round});
      return { targetId: id, label: ${JSON.stringify(label)}, ...state };
    } finally { await session.detach(); }
  }`;
}

async function inspect(client, target, round, bring = false) {
  return resultJson(
    await client.tool("browser_run_code_unsafe", {
      code: identityCode(target.targetId, target.label, target.expectedUrl, round, bring),
    }),
  );
}
const clockOrigin = process.hrtime.bigint();
function mark() {
  return {
    at: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() - clockOrigin) / 1_000_000,
  };
}
async function screenshot(client, target, round, variant, verifiedPre) {
  const routineStarted = mark();
  let pre = verifiedPre;
  let post;
  let preparationError;
  if (!pre) {
    try {
      pre = await inspect(client, target, round, variant === "bring-to-front");
    } catch (error) {
      preparationError = safeError(error);
    }
  }
  const preparationCompleted = mark();
  const screenshotStarted = mark();
  const started = process.hrtime.bigint();
  let response;
  let transportError;
  try {
    if (preparationError) throw new Error(`pre-screenshot identity failed: ${preparationError}`);
    response = await client.tool("browser_take_screenshot", {
      type: "jpeg",
      fullPage: false,
      scale: "css",
    });
  } catch (error) {
    transportError = safeError(error);
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const screenshotEnded = mark();
  let postError;
  try {
    post = await inspect(client, target, round, false);
  } catch (error) {
    postError = safeError(error);
  }
  const image = response?.content?.find((item) => item.type === "image");
  let provenance;
  if (image?.data && image.mimeType) {
    const bytes = Buffer.from(image.data, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = `${mode}-round-${String(round).padStart(2, "0")}-${target.label}.jpeg`;
    await writeFile(`${outputDir}/${filename}`, bytes);
    provenance = { filename, bytes: bytes.length, sha256, mimeType: image.mimeType };
  }
  return {
    label: target.label,
    expectedTargetId: target.targetId,
    expectedUrl: target.expectedUrl,
    variant,
    routineStarted,
    preparationCompleted,
    screenshotStarted,
    screenshotEnded,
    routineEnded: mark(),
    pre,
    post,
    durationMs,
    isError:
      response?.isError === true ||
      transportError !== undefined ||
      preparationError !== undefined ||
      postError !== undefined,
    text: textOf(response).slice(0, 1000),
    ...(transportError ? { transportError } : {}),
    ...(preparationError ? { preparationError } : {}),
    ...(postError ? { postError } : {}),
    ...(provenance ? { image: provenance } : {}),
  };
}

const observations = [];
let clients;
let targets = [];
let browserVersion;
const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function persist(error) {
  const result = {
    mode,
    rounds,
    idleMs,
    concurrencyPattern,
    startedAt,
    finishedAt: new Date().toISOString(),
    image: {
      name: process.env.PROBE_IMAGE_NAME ?? "unknown",
      id: process.env.PROBE_IMAGE_ID ?? "unknown",
    },
    source: {
      revision: process.env.PROBE_SOURCE_REVISION ?? "unknown",
      probeSha256,
      bundleSha256: process.env.PROBE_BUNDLE_SHA256 ?? "unknown",
    },
    browserVersion,
    mcpVersion: (() => {
      const version = spawnSync("playwright-mcp", ["--version"], { encoding: "utf8" });
      return (version.stdout || version.stderr).trim();
    })(),
    targets,
    observations,
    ...(error ? { failedRound: observations.length + 1 } : {}),
    summary: {
      completedRounds: observations.length,
      aSuccesses: observations.filter((row) => row.a.image && !row.a.isError).length,
      bSuccesses: observations.filter((row) => row.b.image && !row.b.isError).length,
      aTotalMs: observations.reduce((sum, row) => sum + row.a.durationMs, 0),
      bTotalMs: observations.reduce((sum, row) => sum + row.b.durationMs, 0),
      aAtFiveSecondBoundary: observations.filter((row) => row.a.durationMs >= 4900).length,
      bAtFiveSecondBoundary: observations.filter((row) => row.b.durationMs >= 4900).length,
      overlappingScreenshotRpcs: observations.filter(
        (row) =>
          row.a.screenshotStarted.monotonicMs < row.b.screenshotEnded.monotonicMs &&
          row.b.screenshotStarted.monotonicMs < row.a.screenshotEnded.monotonicMs,
      ).length,
      maximumStartSkewMs: Math.max(
        0,
        ...observations.map((row) =>
          Math.abs(
            row.a.screenshotStarted.monotonicMs - row.b.screenshotStarted.monotonicMs,
          ),
        ),
      ),
    },
    mcpStderr: Object.fromEntries(
      (clients ?? []).map((client) => [client.label, client.stderr.join("").slice(-4000)]),
    ),
    ...(error ? { error: safeError(error) } : {}),
  };
  await writeFile(`${outputDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
try {
  clients = await Promise.all([mcpClient("capture-a"), mcpClient("capture-b")]);
  const [a, b] = clients;
  await a.tool("browser_tabs", { action: "new" });
  await b.tool("browser_tabs", { action: "new" });
  await Promise.all([
    a.tool("browser_navigate", { url: "http://localhost:8082/?target=a" }),
    b.tool("browser_navigate", { url: "http://localhost:8082/?target=b" }),
  ]);
  targets = await Promise.all(
    clients.map(async (client, index) => ({
      label: index === 0 ? "a" : "b",
      expectedUrl: `http://localhost:8082/?target=${index === 0 ? "a" : "b"}`,
      ...resultJson(await client.tool("browser_run_code_unsafe", { code: focusCode })),
    })),
  );
  if (targets[0].targetId === targets[1].targetId) throw new Error("MCP clients share one target");
  browserVersion = await (await fetch("http://127.0.0.1:9222/json/version")).json();

  for (let round = 1; round <= rounds; round += 1) {
    // Keep A genuinely backgrounded for the same order of time as a production model turn.
    // Round/counter still have their preceding values during this recorded idle.
    await inspect(b, targets[1], round - 1, true);
    await sleep(idleMs);
    await Promise.all(
      clients.map((client, index) =>
        client.tool("browser_run_code_unsafe", {
          code: updateCode(targets[index].targetId, targets[index].label, round),
        }),
      ),
    );
    let schedule;
    let shots;
    if (concurrencyPattern === "natural") {
      // Both independent MCP sessions start their verified bring+capture routine on the same
      // host turn. Whichever foreground transition wins is intentionally uncontrolled.
      const released = mark();
      shots = await Promise.all([
        screenshot(a, targets[0], round, "bring-to-front"),
        screenshot(b, targets[1], round, "bring-to-front"),
      ]);
      schedule = { pattern: "natural", released };
    } else {
      // Deterministic bounded pressure: alternate the winner. The loser brings its verified page
      // forward first, then the winner steals foreground. Both screenshot RPCs are released on
      // the same host turn without another foreground change or any global lock.
      const winnerIndex = round % 2 === 1 ? 1 : 0;
      const loserIndex = 1 - winnerIndex;
      const sequence = [];
      for (const index of [loserIndex, winnerIndex]) {
        const started = mark();
        const verified = await inspect(clients[index], targets[index], round, true);
        sequence.push({ label: targets[index].label, started, completed: mark(), verified });
      }
      const verifiedPre = await Promise.all(
        clients.map((client, index) => inspect(client, targets[index], round, false)),
      );
      const postStealDelayMs = round % 2 === 0 ? 200 : 0;
      if (postStealDelayMs > 0) await sleep(postStealDelayMs);
      const released = mark();
      shots = await Promise.all([
        screenshot(a, targets[0], round, "preverified-after-steal", verifiedPre[0]),
        screenshot(b, targets[1], round, "preverified-after-steal", verifiedPre[1]),
      ]);
      schedule = {
        pattern: "steal",
        winner: targets[winnerIndex].label,
        loser: targets[loserIndex].label,
        sequence,
        postStealDelayMs,
        released,
      };
    }
    observations.push({ round, schedule, a: shots[0], b: shots[1] });
  }

  const result = await persist();
  console.log(JSON.stringify(result));
} catch (error) {
  const partial = await persist(error);
  console.error(JSON.stringify({ error: partial.error, completedRounds: observations.length }));
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
}
