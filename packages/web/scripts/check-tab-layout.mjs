import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
// Automated geometry assertions on the fixture-only demo. No live Gateway or model required.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { inspectControlRows } from "./control-row-contract.mjs";
import { inspectTabLayout } from "./tab-layout-contract.mjs";
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const out = resolve(process.env.TAB_LAYOUT_OUTPUT || "/tmp/deskmates-tab-layout");
const widths = [320, 479, 480, 481, 640, 760, 761, 960];
const locales = ["en", "es", "ja", "zh-CN", "zh-TW"];
const cases = [];
for (const name of (await readdir(`${web}/src/features`)).sort()) {
  if (process.env.TAB_LAYOUT_FEATURES && !process.env.TAB_LAYOUT_FEATURES.split(",").includes(name))
    continue;
  try {
    const entries = JSON.parse(
      await readFile(`${web}/src/features/${name}/tab-layout-cases.json`, "utf8"),
    );
    for (const entry of entries) cases.push({ name, ...entry });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!cases.length) throw new Error("No feature-owned tab layout cases");
await mkdir(out, { recursive: true });
const server = await createServer({
  root: web,
  configFile: `${web}/vite.config.ts`,
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
});
let browser;
const failures = [];
const choiceStyles = new Map();
let checked = 0;
let detectorVerified = false;
let keyboardChecked = 0;
let rowDetectorVerified = false;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/demo.html`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
  for (const locale of locales) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await context.addInitScript((theme) => {
        localStorage.setItem("deskmates.view", "tune");
        localStorage.setItem("deskmates.theme", theme);
      }, theme);
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        failures.push({ locale, theme, rule: "page-error", message: error.message }),
      );
      // Even a broken fixture must not send real provider traffic or server mutations.
      await page.route("**/*", (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== new URL(base).origin || request.method() !== "GET")
          return route.abort();
        return route.continue();
      });
      for (const entry of cases) {
        await page.goto(`${base}${entry.route}`);
        const strip = page.locator(entry.strip).first();
        await strip.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({
          content:
            "*,*::before,*::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
        });
        if ((await page.locator("html").getAttribute("lang")) !== locale)
          throw new Error(`Locale did not load: ${locale}`);
        for (const scale of [1, 2]) {
          await page.evaluate((scale) => {
            document.documentElement.style.fontSize = `${16 * scale}px`;
          }, scale);
          for (const width of widths) {
            await page
              .locator(entry.container)
              .first()
              .evaluate((el, width) => {
                el.style.width = `${width}px`;
                el.style.maxWidth = "none";
              }, width);
            const tabs = strip.locator('[role="tab"]:visible, button[aria-pressed]:visible');
            const count = await tabs.count();
            for (let selected = 0; selected < Math.max(1, count); selected++) {
              if (count && (await tabs.nth(selected).isEnabled())) await tabs.nth(selected).click();
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              await strip.evaluate(async (root) => {
                await Promise.all(
                  root
                    .getAnimations({ subtree: true })
                    .filter(
                      (animation) =>
                        animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
                    )
                    .map((animation) => animation.finished.catch(() => {})),
                );
              });
              const problems = await strip.evaluate(inspectTabLayout);
              const choices = await strip
                .locator(".gb-choice-item:visible")
                .evaluateAll((elements) =>
                  elements.map((el) => {
                    const css = getComputedStyle(el);
                    return {
                      selected: el.getAttribute("aria-pressed"),
                      style: [
                        css.height,
                        css.fontSize,
                        css.lineHeight,
                        css.borderRadius,
                        css.paddingTop,
                        css.paddingBottom,
                        css.backgroundColor,
                        css.color,
                      ].join("|"),
                    };
                  }),
                );
              for (const choice of choices) {
                const key = `${locale}-${theme}-${scale}-${choice.selected}`;
                const expected = choiceStyles.get(key);
                if (expected && expected !== choice.style)
                  problems.push({ rule: "choice-style-drift", expected, actual: choice.style });
                else choiceStyles.set(key, choice.style);
              }

              checked++;
              if (problems.length) {
                const state = `${entry.name}-${entry.id}-${locale}-${theme}-${scale}-${width}-${selected}`;
                failures.push({ state, problems });
                await page.screenshot({ path: `${out}/${state}.png` });
              }
            }
          }
        }
        if (entry.id === "toolbar") {
          const help = page.locator(".files-upload [data-help-tip]");
          await help.hover();
          await page.getByRole("tooltip").waitFor({ state: "visible" });
          await help.press("Escape");
          await page.getByRole("tooltip").waitFor({ state: "hidden" });
          await help.click();
          await page.getByRole("tooltip").waitFor({ state: "visible" });
          await help.press("Escape");
          const filters = strip.locator("[data-control-popover-trigger]");
          await filters.click();
          await page.getByRole("dialog").waitFor({ state: "visible" });
          await page.getByRole("dialog").press("Escape");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
        }
        if (entry.id === "toolbar") {
          for (const width of [390, 600, 720, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            // Same hash navigation retains React state; reload to reset grid and font fixtures.
            await page.reload();
            await page.locator(".files-table tbody tr").first().waitFor();
            await page.evaluate(() => document.fonts.ready);
            const problems = await page.evaluate(() => {
              const failures = [];
              const row = document.querySelector(".files-table tbody tr");
              const cells = row.querySelectorAll("td");
              const mobile = innerWidth <= 720;
              const source = cells[2].getBoundingClientRect();
              const time = cells[3].getBoundingClientRect();
              if (mobile) {
                if (cells[1].getBoundingClientRect().height)
                  failures.push("mobile-type-not-collapsed");
                if (Math.abs(source.top - time.top) > 2)
                  failures.push("mobile-metadata-not-inline");
                if (row.getBoundingClientRect().height > 112) failures.push("mobile-row-too-tall");
              } else if (!cells[1].getBoundingClientRect().height)
                failures.push("desktop-type-hidden");
              if (document.documentElement.scrollWidth > innerWidth + 1)
                failures.push("page-overflow");
              return failures;
            });
            problems.push(...(await page.evaluate(inspectControlRows)));
            if (!rowDetectorVerified && width === 1280 && locale === "en" && theme === "light") {
              await page.locator(".files-apps-entry").evaluate((el) => {
                el.style.marginBottom = "12px";
              });
              const shifted = await page.evaluate(inspectControlRows);
              await page
                .locator(".files-apps-entry")
                .evaluate((el) => el.style.removeProperty("margin-bottom"));
              if (!shifted.some((p) => p.rule === "row-center-alignment"))
                throw new Error("Row shift escaped the detector");
              const action = page.locator(".files-apps-entry [data-row-control]");
              await action.evaluate((el) => {
                el.style.height = `${el.getBoundingClientRect().height + 8}px`;
              });
              const resized = await page.evaluate(inspectControlRows);
              await action.evaluate((el) => el.style.removeProperty("height"));
              if (!resized.some((p) => p.rule === "row-equal-height"))
                throw new Error("Unequal height escaped the detector");
              rowDetectorVerified = true;
            }
            checked++;
            if (problems.length) failures.push({ locale, theme, width, problems });
            await page.screenshot({ path: `${out}/files-${locale}-${theme}-${width}.png` });
            if (width === 390 && locale === "en" && theme === "light") {
              await page.locator(".files-name").first().click();
              await page.locator(".files-detail").waitFor({ state: "visible" });
              await page.getByRole("button", { name: "Back to files", exact: true }).click();
              await page.locator(".files-table").waitFor({ state: "visible" });
            }
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
        const keyboardTabs = strip.getByRole("tab");
        if (await keyboardTabs.count()) {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "16px";
          });
          await page
            .locator(entry.container)
            .first()
            .evaluate((el) => {
              el.style.width = "320px";
            });
          await keyboardTabs.first().focus();
          await keyboardTabs.first().press("End");
          // React Aria reveals keyboard focus in requestAnimationFrame after selection commits.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const last = keyboardTabs.last();
          if ((await last.getAttribute("aria-selected")) !== "true")
            throw new Error(`${entry.name}: End did not select the last tab`);
          const revealed = await last.evaluate((el) => {
            const item = el.getBoundingClientRect();
            const view = el.closest('[data-tab-layout="scroll"]').getBoundingClientRect();
            return item.left >= view.left - 1 && item.right <= view.right + 1;
          });
          if (!revealed) {
            failures.push({ locale, theme, name: entry.name, rule: "keyboard-selection-clipped" });
            await page.screenshot({ path: `${out}/${entry.name}-${locale}-${theme}-keyboard.png` });
          }
          await last.press("Home");
          if ((await keyboardTabs.first().getAttribute("aria-selected")) !== "true")
            throw new Error(`${entry.name}: Home did not select the first tab`);
          keyboardChecked++;
        }
        if (!detectorVerified && entry.name === "contacts" && locale === "en") {
          // Negative control: reintroduce equal-width cells, prove the gate catches the defect.
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "16px";
          });
          await page.locator(entry.container).evaluate((el) => {
            el.style.width = "640px";
          });
          const broken = await page.addStyleTag({
            content:
              ".gb-tab-list {display:grid!important;width:100%!important;grid-template-columns:repeat(4,minmax(0,1fr))!important}.gb-tab-item {min-width:0!important}",
          });
          const detected = await strip.evaluate(inspectTabLayout);
          await broken.evaluate((el) => el.remove());
          if (!detected.some((item) => item.rule === "text-inside-padding"))
            throw new Error("Negative control escaped the layout detector");
          detectorVerified = true;
        }
      }
      await context.close();
    }
  }
} catch (error) {
  failures.push({ rule: "runner-error", message: String(error) });
  const failedPage = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .at(-1);
  if (failedPage) await failedPage.screenshot({ path: `${out}/runner-error.png` }).catch(() => {});
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(
  `${out}/report.json`,
  JSON.stringify(
    { checked, keyboardChecked, detectorVerified, rowDetectorVerified, failures },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      checked,
      keyboardChecked,
      detectorVerified,
      failures: failures.length,
      report: `${out}/report.json`,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
