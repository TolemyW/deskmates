// Static (ADR-0017 decision 2, issue #21): like the chat channel adapters, this server imports
// nothing from other workspace packages but contracts, and reaches the Gateway only over HTTP.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_DIR = join(SRC, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const IMPORT = /from\s+["']([^"']+)["']/g;

describe("package boundary", () => {
  it("imports only node builtins, relative modules, contracts and the MCP SDK", () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const spec = match[1] ?? "";
        const allowed =
          spec.startsWith("node:") ||
          spec.startsWith("./") ||
          spec.startsWith("../") ||
          spec === "@deskmates/contracts" ||
          spec.startsWith("@modelcontextprotocol/sdk/") ||
          spec === "vitest";
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("pins its dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({
      "@deskmates/contracts": "*",
      "@modelcontextprotocol/sdk": "1.30.0",
    });
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("starts the binary with a Node shebang so the bin entry runs from a shell", () => {
    expect(readFileSync(join(SRC, "main.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(
      true,
    );
  });
});
