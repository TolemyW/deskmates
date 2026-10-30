// T0, ADR-0047 decision 1: the release manifest lists exactly the channel plugins this release
// ships, sorted by id, each pinned with its ABI and the version its source exports (the loader
// refuses a mismatch). Extended by each provider change; no e-mail or WeChat plugin before its
// phase.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "write-channel-plugin-manifest.mjs");

/** What each shipped plugin's source declares. */
const SHIPPED = [
  { id: "discord", apiVersion: 2, source: "packages/channels/src/discord/plugin.ts" },
  { id: "slack", apiVersion: 2, source: "packages/channels/src/slack/plugin.ts" },
  { id: "telegram", apiVersion: 2, source: "packages/channels/src/telegram/plugin.ts" },
  { id: "whatsapp", apiVersion: 2, source: "packages/channels/src/whatsapp/plugin.ts" },
];

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("release channel plugin manifest (ADR-0047 decision 1)", () => {
  it("lists exactly the shipped plugins, sorted, with their ABI and pinned files", () => {
    root = mkdtempSync(join(tmpdir(), "channel-manifest-"));
    for (const plugin of SHIPPED) {
      mkdirSync(join(root, plugin.id), { recursive: true });
      writeFileSync(join(root, plugin.id, "plugin.js"), `export const id = "${plugin.id}";\n`);
    }
    execFileSync(process.execPath, [SCRIPT, root]);
    const manifest = JSON.parse(readFileSync(join(root, "channel-plugins.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.plugins.map((p) => p.id)).toEqual(SHIPPED.map((p) => p.id));
    for (const [index, plugin] of SHIPPED.entries()) {
      const entry = manifest.plugins[index];
      expect(entry).toMatchObject({
        apiVersion: plugin.apiVersion,
        entry: `${plugin.id}/plugin.js`,
      });
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.files.map((f) => f.path)).toContain(`${plugin.id}/plugin.js`);
    }
    for (const id of manifest.plugins.map((p) => p.id))
      expect(id).not.toMatch(/mail|wechat|weixin/);
  });

  it("pins the version each plugin's source exports", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const telegram = readFileSync(
      join(REPO, SHIPPED.find((p) => p.id === "telegram").source),
      "utf8",
    );
    const version = /TELEGRAM_PLUGIN_VERSION = "([^"]+)"/.exec(telegram)?.[1];
    expect(version).toBeTruthy();
    expect(script).toContain(
      `{ id: "telegram", version: "${version}", apiVersion: 2, entry: "telegram/plugin.js" }`,
    );
  });
});
