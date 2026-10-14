// Screenshots of every operator screen against the UI demo Gateway (scripts/ui-demo.ts) and the
// Vite dev server. Review work on the UI with pictures, not only with unit tests.
//
//   node scripts/ui-screenshots.mjs <out dir> [prefix]
//
// Environment: WEB_URL (default http://127.0.0.1:5173), API_URL (default http://127.0.0.1:8099),
// TOKEN (default: the demo operator credential, for the API reads below), LOGIN / PASSWORD (default:
// the UI demo's sign-in), PLAYWRIGHT_MODULE (a path to a `playwright` package when
// none resolves from this repository; the workspace image and CI runners have one).

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = require(playwrightModule);

const out = process.argv[2] ?? "ui-screenshots";
const prefix = process.argv[3] ?? "";
const base = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const api = process.env.API_URL ?? "http://127.0.0.1:8099";
const token = process.env.TOKEN ?? "operator-test-token-at-least-32-bytes-long";
const login = process.env.LOGIN ?? "demo";
const password = process.env.PASSWORD ?? "demo-password-not-secret";
mkdirSync(out, { recursive: true });

const launch = {};
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => console.log("pageerror:", error.message));

const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${prefix}${name}.png` });
  console.log("shot", name);
};

await page.goto(`${base}/#/threads`);
await page.waitForSelector("#login-name", { timeout: 20000 });
await shot("00-login");
await page.fill("#login-name", login);
await page.fill("#login-password", password);
await page.click("button[type=submit]");
await page.waitForSelector("nav", { timeout: 20000 });
await shot("01-home");

const links = await page.$$eval(".thread-list a", (anchors) =>
  anchors.map((a) => a.getAttribute("href")),
);
for (const [i, href] of links.entries()) {
  await page.goto(`${base}/${href}`);
  await page.waitForTimeout(1500);
  await shot(`02-thread-${i}`);
}

const runs = await (
  await fetch(`${api}/api/runs`, { headers: { authorization: `Bearer ${token}` } })
).json();
const list = runs.runs ?? runs;
const run = list.find((r) => r.status === "succeeded") ?? list[0];
if (run) {
  await page.goto(`${base}/#/runs/${run.id}`);
  await page.waitForTimeout(1500);
  await shot("03-run");
}

for (const [i, route] of [
  "approvals",
  "contacts",
  "workspace",
  "workspace/facts",
  "workspace/settings",
  "costs",
  "integrations",
].entries()) {
  await page.goto(`${base}/#/${route}`);
  await page.waitForTimeout(1200);
  await shot(`1${i}-${route.replace("/", "-")}`);
}
await page.goto(`${base}/#/contacts`);
await page.waitForTimeout(1200);
const contactHref = await page
  .$eval(".contact-list a.contact-row", (a) => a.getAttribute("href"))
  .catch(() => null);
if (contactHref) {
  await page.goto(`${base}/${contactHref}`);
  await page.waitForTimeout(1200);
  await shot("19-contact-profile");
}

await page.goto(`${base}/${links[0] ?? "#/threads"}`);
await page.waitForTimeout(800);
await page.click("button[aria-label='Switch to dark theme']");
await page.waitForTimeout(500);
await shot("21-dark-thread");
if (run) {
  await page.goto(`${base}/#/runs/${run.id}`);
  await page.waitForTimeout(1200);
  await shot("22-dark-run");
}
await page.click("button[aria-label='Switch to light theme']");

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/${links[0] ?? "#/threads"}`);
await page.waitForTimeout(1200);
await shot("30-mobile-thread");
await browser.close();
