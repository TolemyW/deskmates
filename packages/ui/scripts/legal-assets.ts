import { readFileSync, readdirSync } from "node:fs";
import type { Plugin } from "vite";

/** Ship notices with every static distribution without adding promotional UI. */
export function uiLegalAssets(): Plugin {
  const directory = new URL("../legal/", import.meta.url);
  return {
    name: "deskmates-ui-legal-assets",
    generateBundle() {
      for (const filename of readdirSync(directory)) {
        this.emitFile({
          type: "asset",
          fileName: `third-party/${filename}`,
          source: readFileSync(new URL(filename, directory), "utf8"),
        });
      }
    },
  };
}
