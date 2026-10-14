// The provider runs workspaces from images someone else prepared; it never acquires one. The
// reusable suite's execute stage relies on this: it refuses `docker build` and `docker pull` on
// the CLI, and the Gateway reaches the daemon through this package's API client instead, so
// the API side has to hold the same line. A missing image must stay a typed `image_missing`
// error, never a pull or a build.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL(".", import.meta.url).pathname;

/** Docker Engine API endpoints that bring an image into the daemon. */
const ACQUIRING_ENDPOINTS = [
  "/images/create", // pull (and import from a URL)
  "/build", // build from a context
  "/images/load", // load a tarball
  "/session", // BuildKit session, used only by builds
];

function productionSources(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(SRC, name));
}

describe("the provider never pulls, builds or loads an image", () => {
  it("finds its production sources", () => {
    expect(productionSources().map((p) => p.slice(SRC.length))).toContain("docker-provider.ts");
  });

  for (const endpoint of ACQUIRING_ENDPOINTS) {
    it(`no production source names ${endpoint}`, () => {
      const offenders = productionSources().filter((path) => {
        const text = readFileSync(path, "utf8");
        // A path literal in any quoting, including the start of a template string.
        return ['"', "'", "`"].some((quote) => text.includes(`${quote}${endpoint}`));
      });
      expect(offenders).toEqual([]);
    });
  }
});
