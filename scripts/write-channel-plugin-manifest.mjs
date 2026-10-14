import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "packages/channels/dist");
const entry = resolve(root, "whatsapp/plugin.js");
const bytes = await readFile(entry);
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
const manifest = {
  version: 1,
  plugins: [
    {
      id: "whatsapp",
      version: "1.0.0",
      apiVersion: 1,
      entry: "whatsapp/plugin.js",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      files,
    },
  ],
};
await writeFile(resolve(root, "channel-plugins.json"), `${JSON.stringify(manifest, null, 2)}\n`);
