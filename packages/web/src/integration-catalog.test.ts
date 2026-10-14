import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { FEATURED_SERVICES, integrationLogoUrl } from "./integration-catalog.js";

interface LogoManifest {
  license: string;
  source: string;
  icons: Record<string, string>;
}

it("has a source and license manifest entry for every bundled integration logo", () => {
  const root = new URL("../public/integration-logos/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as LogoManifest;
  expect(manifest.license).toBeTruthy();
  expect(manifest.source).toMatch(/^https:\/\//);
  const bundled = readdirSync(root)
    .filter((file) => file.endsWith(".svg"))
    .sort();
  expect(Object.keys(manifest.icons).sort()).toEqual(bundled);
  for (const file of Object.keys(manifest.icons)) {
    expect(existsSync(new URL(file, root)), file).toBe(true);
  }
  for (const service of FEATURED_SERVICES) {
    const url = integrationLogoUrl(service);
    if (!url) continue; // The explicit letter-tile fallback needs no asset or manifest row.
    const file = url.slice(url.lastIndexOf("/") + 1);
    expect(manifest.icons[file], service).toBeTruthy();
  }
});
