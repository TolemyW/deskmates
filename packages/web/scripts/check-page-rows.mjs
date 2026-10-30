import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.env.ROW_LAYOUT_OUTPUT || "/tmp/deskmates-page-rows";
const cases = [];
for (const feature of (await readdir(`${web}/src/features`)).sort()) {
  if (
    process.env.ROW_LAYOUT_FEATURES &&
    !process.env.ROW_LAYOUT_FEATURES.split(",").includes(feature)
  )
    continue;
  try {
    for (const entry of JSON.parse(
      await readFile(`${web}/src/features/${feature}/row-layout-cases.json`, "utf8"),
    ))
      cases.push({ feature, ...entry });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
if (!cases.length) throw new Error("No row layout fixtures selected");
await mkdir(out, { recursive: true });
const server = await createServer({
  root: web,
  configFile: `${web}/vite.config.ts`,
  server: { host: "127.0.0.1", port: 5198, strictPort: false, hmr: false, watch: null },
});
const failures = [];
const coverage = [];
let detectorVerified = false;
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/demo.html`;
  browser = await chromium.launch();
  for (const { width, theme } of [
    { width: 390, theme: "light" },
    { width: 760, theme: "light" },
    { width: 1280, theme: "light" },
    { width: 1280, theme: "dark" },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: "en",
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await context.addInitScript((theme) => {
      localStorage.setItem("deskmates.view", "tune");
      localStorage.setItem("deskmates.theme", theme);
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(30000);
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === new URL(base).origin &&
      route.request().method() === "GET"
        ? route.continue()
        : route.abort(),
    );
    for (const entry of cases) {
      const state = `${entry.feature}-${entry.id}-${width}-${theme}`;
      try {
        await page.goto(`${base}${entry.route}`);
        await page.reload();
        await page.waitForLoadState("networkidle", { timeout: 4000 });
        for (const step of entry.steps || []) {
          const target = step.selector
            ? page.locator(step.selector)
            : page.getByRole(step.role || "button", { name: step.name, exact: true });
          if (step.action === "fill") await target.nth(step.index || 0).fill(step.value);
          else await target.nth(step.index || 0).click();
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (const animation of document.getAnimations()) {
            try {
              animation.finish();
            } catch {}
          }
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        if (!detectorVerified) {
          await page.evaluate(() => {
            const row = document.createElement("div");
            row.className = "layout-probe-actions";
            row.style.cssText =
              "position:fixed;left:0;top:0;display:flex;gap:8px;align-items:center;width:200px;z-index:99999";
            row.innerHTML =
              '<button style="width:60px;height:40px">A</button><button style="width:60px;height:40px">B</button>';
            document.body.append(row);
          });
          const probe = async () =>
            (await page.evaluate(checkRows)).failures.filter(
              (f) => f.row === "layout-probe-actions",
            );
          if ((await probe()).length) throw new Error("Aligned detector control failed");
          await page
            .locator(".layout-probe-actions button")
            .last()
            .evaluate((el) => {
              el.style.transform = "translateY(6px)";
            });
          if (!(await probe()).some((f) => f.rule === "center"))
            throw new Error("Center regression was not detected");
          await page
            .locator(".layout-probe-actions button")
            .last()
            .evaluate((el) => {
              el.style.transform = "none";
              el.style.height = "50px";
            });
          if (!(await probe()).some((f) => f.rule === "height"))
            throw new Error("Height regression was not detected");
          await page.locator(".layout-probe-actions").evaluate((el) => el.remove());
          detectorVerified = true;
        }
        const result = await page.evaluate(checkRows);
        coverage.push({ state, rows: result.coverage });
        console.log(JSON.stringify({ state, problems: result.failures }));
        if (result.failures.length) {
          failures.push({ state, problems: result.failures });
          await page.screenshot({ path: `${out}/${state}.png` });
        }
      } catch (error) {
        failures.push({ state, error: String(error) });
        console.log(JSON.stringify({ state, error: String(error) }));
        await page.screenshot({ path: `${out}/${state}.png` });
      }
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(
  `${out}/report.json`,
  JSON.stringify({ states: coverage.length, detectorVerified, failures, coverage }, null, 2),
);
console.log(
  JSON.stringify({
    states: coverage.length,
    failures: failures.length,
    report: `${out}/report.json`,
  }),
);
if (failures.length || !detectorVerified) process.exitCode = 1;

function checkRows() {
  const rows = [...document.querySelectorAll("[class],[data-control-row]")].filter(
    (el) =>
      [...el.classList].some((c) => /(?:^|-)(actions|toolbar|controls|filters)$/.test(c)) ||
      el.hasAttribute("data-control-row"),
  );
  const failures = [];
  const coverage = [];
  for (const root of rows) {
    const controls = [
      ...root.querySelectorAll(
        'button,a[data-gb-ui="button"],input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,[role="combobox"]',
      ),
    ]
      .filter(
        (el) =>
          !el.closest("[hidden]") &&
          el.getBoundingClientRect().width &&
          el.getBoundingClientRect().height,
      )
      .filter(
        (el) => !rows.some((inner) => inner !== root && root.contains(inner) && inner.contains(el)),
      );
    if (controls.length < 2) continue;
    const name = [...root.classList].join(".");
    coverage.push({
      row: name,
      controls: controls.map(
        (el) =>
          el.getAttribute("aria-label") || el.textContent.trim() || el.getAttribute("placeholder"),
      ),
    });
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        const x = a.getBoundingClientRect();
        const y = b.getBoundingClientRect();
        const overlap = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
        if (overlap < Math.min(x.height, y.height) / 2) continue;
        const labels = [
          a.getAttribute("aria-label") || a.textContent.trim() || a.tagName,
          b.getAttribute("aria-label") || b.textContent.trim() || b.tagName,
        ];
        const center = Math.abs(x.top + x.height / 2 - y.top - y.height / 2);
        if (center > 1) failures.push({ row: name, rule: "center", labels, delta: center });
        if (
          a.tagName === "BUTTON" &&
          b.tagName === "BUTTON" &&
          !a.closest('[data-gb-ui="select"]') &&
          !b.closest('[data-gb-ui="select"]') &&
          !a.matches('[data-pressed="true"]') &&
          !b.matches('[data-pressed="true"]') &&
          !a.hasAttribute("data-help-tip") &&
          !b.hasAttribute("data-help-tip") &&
          Math.abs(x.height - y.height) > 1
        )
          failures.push({
            row: name,
            rule: "height",
            labels,
            heights: [x.height, y.height],
          });
        if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1)
          failures.push({ row: name, rule: "overlap", labels });
      }
    const box = root.getBoundingClientRect();
    if (root.scrollWidth > root.clientWidth + 1 && getComputedStyle(root).overflowX === "visible")
      failures.push({
        row: name,
        rule: "row-overflow",
        width: box.width,
        scroll: root.scrollWidth,
      });
  }
  return { failures, coverage };
}
