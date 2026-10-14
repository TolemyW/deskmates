// Runs INSIDE the workspace container, never in the test process: `solveHumanCheck` in
// takeover.ts copies this file into /work through `provider.exec` and runs it with `node`.
//
// It stands in for the person who has taken the browser over through noVNC. A test cannot drive
// a noVNC canvas, so the human's keystrokes are made by a program on the same screen instead: it
// attaches to the workspace's one Chromium over CDP (the same endpoint the Playwright MCP uses),
// finds the tab sitting on /verify, types the code and submits. Everything the human half of the
// takeover is *about* — the lock, the refusal the bot sees, the hand back — is real; only the
// fingers are simulated.
//
// Usage: node human-solve.mjs <code> <cdpUrl> <siteOrigin>
// Prints `RESULT <url>` — the URL the verification form landed on.

import { createRequire } from "node:module";

// Playwright is preinstalled globally in the image and linked into /opt/deskmates/node_modules
// (images/workspace/Dockerfile). Resolve from there rather than from /work, which has no
// node_modules of its own, and never download anything.
const require = createRequire("/opt/deskmates/sidecar/package.json");
const { chromium } = require("playwright");

const [code, cdpUrl, siteOrigin] = process.argv.slice(2);
if (!code || !cdpUrl || !siteOrigin) {
  console.error("usage: node human-solve.mjs <code> <cdpUrl> <siteOrigin>");
  process.exit(2);
}

const isVerify = (url) => {
  try {
    return new URL(url).pathname === "/verify";
  } catch {
    return false;
  }
};

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (pages.length === 0) throw new Error("the workspace browser has no page open");
  let page = pages.find((p) => isVerify(p.url()));
  if (!page) {
    // The bot may have left the tab elsewhere; the human walks to the page themselves.
    page = pages[0];
    await page.goto(`${siteOrigin.replace(/\/+$/, "")}/verify`, { waitUntil: "load" });
  }
  await page.bringToFront();
  await page.locator("#verify-code").fill(code);
  await page.locator("#verify-submit").click();
  await page.waitForLoadState("load");
  console.log(`RESULT ${page.url()}`);
} finally {
  // Disconnects this CDP client; the workspace's Chromium keeps running for the bot.
  await browser.close();
}
