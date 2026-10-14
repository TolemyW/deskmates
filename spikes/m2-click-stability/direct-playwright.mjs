import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire("/opt/deskmates/sidecar/package.json");
const { chromium } = require("playwright");

const rounds = Number(process.env.PROBE_ROUNDS ?? 8);
const html = `<!doctype html>
<meta charset="utf-8">
<style>body{font-family:sans-serif}button{margin:40px;width:180px;height:50px}</style>
<button id="action">Click target</button><output id="count">0</output>
<script>
let count=0;
document.querySelector('#action').addEventListener('click',()=>{
  document.querySelector('#count').textContent=String(++count);
});
</script>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(8080, "127.0.0.1", () => resolve());
});

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const initial = context.pages();
const a = await context.newPage();
const b = await context.newPage();
await Promise.all(initial.map((page) => page.close()));

async function rafSample(page) {
  return Promise.race([
    page.evaluate(() =>
      new Promise((resolve) => {
        let frames = 0;
        const started = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - started >= 1000) {
            resolve({ frames, elapsedMs: performance.now() - started, visibility: document.visibilityState });
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ frames: 0, elapsedMs: 2500, timedOut: true }), 2500)),
  ]);
}

const observations = [];
for (let round = 1; round <= rounds; round += 1) {
  await Promise.all([
    a.goto(`http://localhost:8080/?tab=a&round=${round}`),
    b.goto(`http://localhost:8080/?tab=b&round=${round}`),
  ]);
  await b.bringToFront();
  const visibilityBefore = await Promise.all([
    a.evaluate(() => document.visibilityState),
    b.evaluate(() => document.visibilityState),
  ]);
  const rafBefore = await Promise.all([rafSample(a), rafSample(b)]);
  const started = Date.now();
  const clicks = await Promise.allSettled([
    a.locator("#action").click({ timeout: 5000 }),
    b.locator("#action").click({ timeout: 5000 }),
  ]);
  const elapsedMs = Date.now() - started;
  const counts = await Promise.all([
    a.locator("#count").textContent(),
    b.locator("#count").textContent(),
  ]);
  await a.bringToFront();
  let activeRetry;
  try {
    const retryStart = Date.now();
    await a.locator("#action").click({ timeout: 5000 });
    activeRetry = { ok: true, elapsedMs: Date.now() - retryStart };
  } catch (error) {
    activeRetry = { ok: false, error: String(error) };
  }
  observations.push({
    round,
    visibilityBefore,
    rafBefore,
    concurrentElapsedMs: elapsedMs,
    clicks: clicks.map((result) =>
      result.status === "fulfilled"
        ? { ok: true }
        : { ok: false, error: String(result.reason) },
    ),
    counts,
    activeRetry,
  });
}

const processFlags = await (await fetch("http://127.0.0.1:9222/json/version")).json();
console.log(
  JSON.stringify(
    {
      mode: process.env.PROBE_MODE ?? "unknown",
      rounds,
      browser: processFlags.Browser,
      observations,
      summary: {
        inactiveSuccesses: observations.filter((row) => row.clicks[0].ok).length,
        activeSuccesses: observations.filter((row) => row.clicks[1].ok).length,
        activeRetrySuccesses: observations.filter((row) => row.activeRetry.ok).length,
        inactiveTimeouts: observations.filter(
          (row) => !row.clicks[0].ok && row.clicks[0].error.includes("Timeout 5000ms exceeded"),
        ).length,
      },
    },
    null,
    2,
  ),
);

await browser.close();
await new Promise((resolve) => server.close(resolve));
