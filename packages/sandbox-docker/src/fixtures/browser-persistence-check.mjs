// Piped to the workspace's preinstalled Node/Playwright. No model or external network.
import { createServer } from "node:http";
import { createRequire } from "node:module";
const { chromium } = createRequire("/opt/deskmates/package.json")("playwright");
const [operation, nonce] = process.argv.slice(2);
if (!["write", "read"].includes(operation) || !/^[a-f0-9]{16}$/.test(nonce))
  throw Error("invalid persistence check");
const origin = "http://localhost:8765";
const key = `persist-${nonce}`;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>synthetic persistence fixture</title>");
});
await new Promise((resolve) => server.listen(8765, "127.0.0.1", resolve));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(origin);
  if (operation === "write") {
    await context.addCookies([
      {
        name: key,
        value: nonce,
        url: origin,
        expires: Math.floor(Date.now() / 1000) + 3600,
        sameSite: "Lax",
      },
    ]);
    await page.evaluate(({ key, nonce }) => localStorage.setItem(key, nonce), { key, nonce });
  }
  const value = await page.evaluate((key) => localStorage.getItem(key), key);
  const cookie = (await context.cookies(origin)).find((row) => row.name === key)?.value ?? null;
  console.log(JSON.stringify({ operation, cookie, localStorage: value }));
  await page.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
