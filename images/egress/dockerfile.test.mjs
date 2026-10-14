// The egress Dockerfile copies modules one by one. A module the proxy imports but the image lacks
// only fails when the container starts, so check the import graph against the COPY lines here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");

function localImports(name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const m of read(name).matchAll(/from\s+"\.\/([^"]+\.mjs)"/g)) localImports(m[1], seen);
  return seen;
}

describe("images/egress/Dockerfile", () => {
  it("copies every module egress-proxy.mjs imports, directly or transitively", () => {
    const copied = new Set(
      [...read("Dockerfile").matchAll(/^COPY images\/egress\/(\S+\.mjs) /gm)].map((m) => m[1]),
    );
    const needed = [...localImports("egress-proxy.mjs")];
    expect(needed.filter((name) => !copied.has(name))).toEqual([]);
  });
});
