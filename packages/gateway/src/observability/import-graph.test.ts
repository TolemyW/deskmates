// T0, ADR-0046 decision 10: observability is a measurement surface, not a control. No Gateway
// module outside `src/observability/` imports it, except the wiring that starts it and the status
// route that reports it; so no scheduling, approval, routing or budget decision can read it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The only files outside `src/observability/` that may import from it. */
const ALLOWED = new Set(["index.ts", "api/observability-routes.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("observability flows one way (ADR-0046 decision 10)", () => {
  it("is imported only by the Gateway wiring and the status route", () => {
    const importers = files(SRC)
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((path) => !path.startsWith("observability/"))
      .filter((path) =>
        /from\s+["'][^"']*\/observability\/[^"']*["']/.test(readFileSync(join(SRC, path), "utf8")),
      );
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });

  it("imports nothing from the scheduler, approvals, threads or budget", () => {
    for (const path of files(join(SRC, "observability"))) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(
        /from\s+["']\.\.\/(scheduler|approvals|threads|budget|model-proxy|api)\//,
      );
    }
  });
});
