import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
const root = new URL("../", import.meta.url).pathname;
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 5201, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch();
const failures = [];
await mkdir("/tmp/deskmates-mobile-density", { recursive: true });
const cases = [];
for (const feature of (await readdir(`${root}src/features`)).sort()) {
  try {
    cases.push(
      JSON.parse(await readFile(`${root}src/features/${feature}/density-layout-case.json`, "utf8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
assert.ok(cases.length > 0, "Density fixtures must exist");
try {
  for (const width of [360, 390, 430, 1280, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 932 } });
    for (const fixture of cases) {
      const { route } = fixture;
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/demo.html#/${route}`);
      await page.locator(fixture.ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(
        (fixture) => ({
          toolbarHeight: fixture.toolbar
            ? document.querySelector(fixture.toolbar)?.getBoundingClientRect().height
            : undefined,
          rows: fixture.rows
            ? [...document.querySelectorAll(fixture.rows)].map((e) => ({
                height: e.getBoundingClientRect().height,
                top: e.getBoundingClientRect().top,
              }))
            : [],
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }),
        fixture,
      );
      if (result.overflow) failures.push(`${route} ${width}: page overflow`);
      if (fixture.rows) {
        assert.ok(result.rows.length >= fixture.minRows, `${route}: expected seeded rows`);
        if (result.rows.some((row) => row.height > fixture.maxRowHeight))
          failures.push(`${route} ${width}: row density budget exceeded`);
        if (fixture.maxFirstTop && result.rows[0].top > fixture.maxFirstTop)
          failures.push(`${route} ${width}: first row too low`);
      }
      if (
        fixture.toolbar &&
        (!result.toolbarHeight || result.toolbarHeight > fixture.maxToolbarHeight)
      )
        failures.push(`${route} ${width}: toolbar density budget exceeded`);
      console.log(width, route, JSON.stringify(result));
      await page.screenshot({
        path: `/tmp/deskmates-mobile-density/${route.replace("/", "-")}-${width}.png`,
      });
    }
    await page.close();
  }
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
  await server.close();
}
