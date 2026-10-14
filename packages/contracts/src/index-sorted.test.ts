// T0: the contracts barrel lists its re-exports sorted by module path, so a new module adds
// one line in its sorted place instead of appending to the bottom (issue #53).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BARREL = new URL("./index.ts", import.meta.url);

function exportedModulePaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/^export\s[^;]*?from\s+"([^"]+)";/gms)) {
    paths.push(match[1] as string);
  }
  return paths;
}

describe("contracts barrel", () => {
  it("re-exports every module sorted by module path", () => {
    const paths = exportedModulePaths(readFileSync(BARREL, "utf8"));
    expect(paths.length).toBeGreaterThan(0);
    // Plain code-unit order, so "./run-context.js" sorts before "./run.js".
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(
      paths,
      "packages/contracts/src/index.ts: keep the export lines sorted by module path " +
        "(plain string order); move the new line to its sorted place.",
    ).toEqual(sorted);
  });

  it("re-exports each module once", () => {
    const paths = exportedModulePaths(readFileSync(BARREL, "utf8"));
    expect(new Set(paths).size, "packages/contracts/src/index.ts: duplicate export line").toBe(
      paths.length,
    );
  });
});
