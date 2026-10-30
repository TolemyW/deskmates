// T0, issue #25: keep the standalone UI demo and screenshot harness on the same supported
// bootstrap and appearance controls as the product UI. These tools are deliberately outside the
// browser bundle, so this contract test catches stale command names and selectors before a manual
// visual review starts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("operator UI tooling", () => {
  it("seeds the demo through the current root bootstrap API", () => {
    const demo = source("scripts/ui-demo.ts");
    expect(demo).toContain("bootstrapRoot(");
    expect(demo).not.toContain("bootstrapOwner(");
  });

  it("uses the stable theme selector exposed by the shared Preferences dialog", () => {
    const settings = source("packages/web/src/features/account/preferences.tsx");
    const screenshots = source("scripts/ui-screenshots.mjs");
    expect(settings).toContain('className="preference-select theme-preference-selector"');
    expect(screenshots).toContain('name: "Preferences"');
    expect(screenshots).toContain('locator(".theme-preference-selector").selectOption("dark")');
    expect(screenshots).toContain('name: "Close preferences"');
  });

  it("includes scripts in the root TypeScript build", () => {
    const root = JSON.parse(source("package.json"));
    const config = JSON.parse(source("scripts/tsconfig.json"));
    expect(root.scripts.typecheck).toContain("tsc -b acceptance scripts");
    expect(config.include).toEqual(["**/*.ts"]);
  });
});
