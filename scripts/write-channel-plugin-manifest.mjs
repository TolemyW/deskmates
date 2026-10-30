import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { wechatPluginEntries } from "./wechat-release-gate.mjs";

// Every release-bundled channel plugin (ADR-0017 amendment 1 P2), sorted by id. An ABI-2 provider
// (ADR-0047) adds one line here when it ships; its runtime and third-party dependencies still load
// only when a connection of it is used.
const RELEASE_PLUGINS = [
  { id: "discord", version: "1.0.0", apiVersion: 2, entry: "discord/plugin.js" },
  { id: "slack", version: "1.0.0", apiVersion: 2, entry: "slack/plugin.js" },
  { id: "telegram", version: "1.0.0", apiVersion: 2, entry: "telegram/plugin.js" },
  ...wechatPluginEntries({
    development: process.argv.includes("--development-wechat"),
    required: process.argv.includes("--include-wechat"),
  }),
  { id: "whatsapp", version: "2.0.0", apiVersion: 2, entry: "whatsapp/plugin.js" },
];

const root = resolve(process.argv[2] ?? "packages/channels/dist");
const files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.isFile() && path.endsWith(".js")) {
      const content = await readFile(path);
      files.push({
        path: relative(root, path),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
}
await walk(root);
files.sort((a, b) => a.path.localeCompare(b.path));
const plugins = [];
for (const plugin of RELEASE_PLUGINS) {
  const bytes = await readFile(resolve(root, plugin.entry));
  plugins.push({ ...plugin, sha256: createHash("sha256").update(bytes).digest("hex"), files });
}
await writeFile(
  resolve(
    root,
    process.argv.includes("--development-wechat")
      ? "channel-plugins.development.json"
      : "channel-plugins.json",
  ),
  `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`,
);
