// Operator-only test driver for deskbench X04. It runs inside the workspace container and
// attaches to the same Chromium/noVNC screen as the bots. The seeded code is passed by the
// acceptance harness; it never enters a bot prompt, SOUL, tool result, or model request.

import { createRequire } from "node:module";

const require = createRequire("/opt/deskmates/sidecar/package.json");
const { chromium } = require("playwright");

const [code, cdpUrl, siteOrigin] = process.argv.slice(2);
if (!code || !cdpUrl || !siteOrigin) {
  console.error("usage: node solve-mfa.mjs <code> <cdpUrl> <siteOrigin>");
  process.exit(2);
}

const origin = new URL(siteOrigin).origin;
const isMfa = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === "/mfa";
  } catch {
    return false;
  }
};

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const matches = pages.filter((page) => isMfa(page.url()));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${origin}/mfa tab, found ${matches.length}: ${pages
        .map((page) => page.url())
        .join(", ")}`,
    );
  }
  const page = matches[0];
  await page.bringToFront();
  await page.locator("#code").fill(code);
  await page.locator("#mfa-submit").click();
  await page.waitForURL("**/dashboard");
  console.log(`RESULT ${page.url()}`);
} finally {
  await browser.close();
}
