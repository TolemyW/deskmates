// T0 contract for where styles live (issue #53). Shared styles are in src/*.css; the app shell
// and each feature own src/app/*.css and src/features/<name>/<name>.css, which
// feature-styles.ts discovers by path. The cascade layer order is declared exactly once.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(src, path), "utf8");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [relative(src, path)] : [];
  });
}

const GLOBAL = ["app.css", "design-refresh.css", "resources.css", "typography.css"];
const all = cssFiles(src);
const owned = all.filter((file) => !GLOBAL.includes(file));

it("declares the cascade layer order once, before anything else in app.css", () => {
  const app = read("app.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(app.trimStart().split("\n")[0]).toBe(
    "@layer properties, theme, base, components, utilities;",
  );
  for (const file of all) {
    const statements = read(file).match(/@layer\s+[\w-]+\s*,[^{;]*;/g) ?? [];
    expect(statements.length, file).toBe(file === "app.css" ? 1 : 0);
  }
});

it("loads app.css, then the shell and feature styles, then typography", () => {
  const index = read("styles/index.ts");
  const order = ['"../app.css"', '"./feature-styles.js"', '"../typography.css"'].map((name) =>
    index.indexOf(`import ${name}`),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const features = read("styles/feature-styles.ts");
  expect(features).toContain('import.meta.glob("../app/*.css", { eager: true })');
  expect(features).toContain('import.meta.glob("../features/*/*.css", { eager: true })');
  for (const entry of ["main.tsx", "demo-main.tsx"]) {
    expect(read(entry), entry).toContain('import "./styles/index.js";');
    expect(read(entry), entry).not.toMatch(/import "\.\/[\w-]+\.css"/);
  }
});

it("keeps every owned stylesheet where the globs find it, in the components layer", () => {
  for (const file of owned) {
    expect(file, file).toMatch(/^(app\/[\w-]+\.css|features\/([\w-]+)\/\2\.css)$/);
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css, file).not.toMatch(/@import/);
    for (const layer of css.matchAll(/@layer\s+([^{;]+)\{/g)) {
      expect(layer[1]?.trim(), file).toBe("components");
    }
  }
});
