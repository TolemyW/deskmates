import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
const root = new URL("../", import.meta.url).pathname;
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 5199, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch();
const failures = [];
await mkdir("/tmp/deskmates-chat-layout", { recursive: true });
try {
  for (const width of [360, 390, 430, 760, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 932 } });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/demo.html#/threads/thr_000s`,
    );
    await page.locator(".transcript .message.bot .meta").first().waitFor();
    // Stress the rendered product markup with the stable incident's content and state.
    await page.evaluate(() => {
      document.querySelector(".chat-header h2").textContent =
        "Deskmates 首轮用户试用方案 — long group title";
      // Demo workspaces may have no screen. Exercise the real takeover button's footprint too.
      const actions = document.querySelector(".chat-header-actions");
      if (!actions.querySelector(".takeover-controls button")) {
        const controls = document.createElement("span");
        controls.className = "takeover-controls small";
        const button = actions.querySelector("button").cloneNode(false);
        button.textContent = "Take over";
        controls.append(button);
        actions.append(controls);
      }
      const message = document.querySelector(".transcript .message.bot");
      message.classList.add("continued");
      message.querySelector(".author").textContent = "decision-analyst";
      const meta = message.querySelector(".meta");
      let addressed = meta.querySelector(".message-addressed");
      if (!addressed) {
        addressed = document.createElement("span");
        addressed.className = "message-addressed";
        meta.append(addressed);
      }
      addressed.textContent = "To agent-architect, gateway-analyst, assistant";
    });
    await page.evaluate(() => document.fonts.ready);
    const issues = await page.evaluate(() => {
      const errors = [];
      for (const selector of [
        ".chat-header",
        ".chat-header-row",
        ".composer",
        ".transcript .message.bot.continued > .meta",
      ]) {
        const e = document.querySelector(selector);
        const r = e.getBoundingClientRect();
        if (r.right > innerWidth + 1 || r.left < -1) errors.push(`${selector} outside viewport`);
        if (selector.includes(".meta") && (r.width < 200 || r.height > 100))
          errors.push(`message header ${r.width} x ${r.height}`);
      }
      const heading = document.querySelector(".chat-header");
      if (heading.scrollWidth > heading.clientWidth + 1) errors.push("header content overflows");
      if (document.documentElement.scrollWidth > innerWidth + 1) errors.push("page overflows");
      return errors;
    });
    await page.screenshot({ path: `/tmp/deskmates-chat-layout/${width}.png` });
    if (width <= 960) {
      const more = page.getByRole("button", { name: "More chat actions", exact: true });
      await more.click();
      assert.equal(await more.getAttribute("aria-expanded"), "true");
      const actions = page.locator(".chat-header-actions");
      assert.equal(await actions.isVisible(), true);
      const bounds = await actions.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await more.press("Escape");
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      assert.equal(await actions.isVisible(), false);
    }
    failures.push(...issues.map((x) => `${width}: ${x}`));
    await page.close();
  }
  assert.deepEqual(failures, []);
  console.log("Chat layout passed at 360, 390, 430, 760 and 1280px");
} finally {
  await browser.close();
  await server.close();
}
