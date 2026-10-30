// Local demo-only visual checks for the System pages. Reuses the fingerprint renderer,
// extending its screen set without adding a shared screen registry entry.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node spikes/operate-ui/verify.mjs /tmp/operate-ui
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
const webDir = join(root, "packages/web");
const out = resolve(process.argv[2] ?? "/tmp/deskmates-operate-ui");
const generated = join(mkdtempSync(join(tmpdir(), "operate-ui-")), "capture.mjs");
let source = readFileSync(join(webDir, "scripts/ui-fingerprint.mjs"), "utf8");
source = source.replace(
  'const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
  `const webDir = ${JSON.stringify(webDir)};`,
);
source = source.replace(
  '{ name: "1440", width: 1440, height: 900 }',
  '{ name: "1224", width: 1224, height: 1080 }',
);
source = source.replace(
  '{ name: "1024", width: 1024, height: 768 }',
  '{ name: "920", width: 920, height: 1080 }',
);
source = source.replace('const THEMES = ["light", "dark"];', 'const THEMES = ["light"];');
source = source.replace(
  "page.screenshot({ fullPage: true,",
  "page.screenshot({ timeout: 120000, fullPage: true,",
);
const start = source.indexOf("function screens(found) {");
const end = source.indexOf("\nasync function captureState", start);
source = source.slice(0, start) + screens.toString() + "\n" + source.slice(end);
writeFileSync(generated, source);
const result = spawnSync(
  process.execPath,
  [generated, "capture", out, "--jobs", "3", ...process.argv.slice(3)],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const failures = [];
for (const name of readdirSync(join(out, "states"))) {
  const state = JSON.parse(gunzipSync(readFileSync(join(out, "states", name))));
  if (state.errors.length || !state.stable)
    failures.push({ name, errors: state.errors, stable: state.stable });
}
if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
writeFileSync(
  join(out, "verification.json"),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      fixtures: "synthetic host inventory and channel manifest; no real credentials or model calls",
      states: readdirSync(join(out, "states")).sort(),
      failures,
    },
    null,
    2,
  ),
);
console.log("All System pages and dialogs rendered without browser errors.");

function screens() {
  const assertFrame = async (page) => {
    const frame = await page.locator("main.content > .page-container").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const heading = element.querySelector("h1").getBoundingClientRect();
      return {
        inset: heading.x - box.x,
        expected: parseFloat(style.paddingLeft),
        bodyOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    if (Math.abs(frame.inset - frame.expected) > 1 || frame.bodyOverflow)
      throw new Error(`Invalid page frame: ${JSON.stringify(frame)}`);
  };
  const network = async (page) => {
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, init) => {
        if (String(input).endsWith("/api/runtime/resources")) {
          const id = "ws_09d9c7f1755748a98153043cba296e59";
          return Promise.resolve(
            Response.json({
              checked: true,
              checkedAt: "2026-10-19T00:00:00Z",
              healthy: 1,
              findings: [
                {
                  id: "synthetic-orphan",
                  flag: "orphan",
                  workspaceId: id,
                  sizeBytes: 0,
                  resources: [
                    {
                      kind: "volume",
                      name: `deskmates-${id}-work`,
                      id: "synthetic-volume",
                      workspaceId: id,
                    },
                  ],
                  createdAt: "2026-10-16T13:29:22Z",
                  detail: "Synthetic orphan resource for a long identifier layout check",
                },
              ],
            }),
          );
        }
        return original(input, init);
      };
    });
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    await page.getByText(/volume deskmates-ws_09d9/).waitFor();
    const width = await page
      .locator(".network-host .network-table td")
      .first()
      .evaluate((cell) => cell.getBoundingClientRect().width);
    if (width < 250) throw new Error(`Resource column collapsed to ${width}px`);
    await page.getByRole("checkbox", { name: /VendorDB test environment/ }).check();
    const dateWidth = await page
      .locator(".network-expiry input")
      .evaluate((el) => el.getBoundingClientRect().width);
    const direction = await page
      .locator(".network-expiry")
      .evaluate((el) => getComputedStyle(el).flexDirection);
    if (direction !== "row") throw new Error(`Date label inherited ${direction} layout`);
    if (dateWidth > 260) throw new Error(`Date input stretched to ${dateWidth}px`);
    await assertFrame(page);
  };
  return [
    { name: "computer", hash: "#/computer", action: assertFrame },
    { name: "costs", hash: "#/costs", action: assertFrame },
    { name: "integrations", hash: "#/integrations", action: assertFrame },
    { name: "network", hash: "#/network", action: network },
    { name: "vault", hash: "#/vault", action: assertFrame },
    {
      name: "vault-add",
      hash: "#/vault",
      action: async (page) => {
        await page.getByRole("button", { name: "Add a credential", exact: true }).click();
        await page.getByRole("dialog").waitFor();
      },
    },
    {
      name: "channel-setup",
      hash: "#/integrations",
      action: async (page) => {
        // The demo deliberately has no runtime channel. Supply a synthetic manifest,
        // then remount the page; no real credentials or provider requests are involved.
        await page.evaluate(() => {
          const original = window.fetch;
          window.fetch = (input, init) => {
            const path = String(input);
            if (path.endsWith("/api/channels"))
              return Promise.resolve(
                Response.json({
                  plugins: [
                    {
                      manifest: {
                        apiVersion: 1,
                        id: "discord",
                        version: "1.0.0",
                        displayName: "Discord",
                        description: "Synthetic chat channel for local layout verification",
                        capabilities: { directMessages: true, groups: false, testMessage: false },
                        methods: [
                          {
                            id: "token",
                            label: "Bot token",
                            description: "Connect a bot",
                            fields: [
                              {
                                key: "token",
                                label: "Bot token",
                                kind: "password",
                                secret: true,
                                required: true,
                              },
                            ],
                          },
                        ],
                        statusVocabulary: ["connected"],
                      },
                    },
                  ],
                  failures: [],
                }),
              );
            if (/\/api\/workspaces\/[^/]+\/channels$/.test(path))
              return Promise.resolve(Response.json({ connections: [] }));
            return original(input, init);
          };
        });
        await page.evaluate(() => {
          window.location.hash = "#/computer";
        });
        await page.getByRole("heading", { name: "Computer", exact: true }).waitFor();
        await page.evaluate(() => {
          window.location.hash = "#/integrations";
        });
        await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor();
        await page.getByRole("button", { name: /^Discord/ }).click();
        await page.getByRole("dialog").waitFor();
      },
    },
  ];
}
