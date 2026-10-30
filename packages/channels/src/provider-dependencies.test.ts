// T0, ADR-0047 decision 15: every third-party dependency of a provider plugin is declared, pinned
// and dynamically imported in `provider-dependencies.ts`, and nowhere else. WhatsApp's existing
// packages are grandfathered until its own ABI-2 change (the package-boundary test pins them).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_DEPENDENCIES,
  type ProviderDependency,
  loadProviderDependency,
} from "./provider-dependencies.js";

const SRC = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_DIR = join(SRC, "..");
const REGISTRY = "provider-dependencies.ts";

/** WhatsApp's packages from before the rule, and the directories allowed to import them. */
const GRANDFATHERED = new Set(["@whiskeysockets/baileys", "https-proxy-agent", "pino", "qrcode"]);
const GRANDFATHERED_FILE = /^(whatsapp\/|whatsapp-web\/|whatsapp-web-main\.ts$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function thirdParty(spec: string): boolean {
  return !(
    spec.startsWith("node:") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec === "@deskmates/contracts"
  );
}

/** Runtime imports: `import x from`, `export ... from` and `import("...")`; never `import type`. */
function runtimeImports(text: string): string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(
    /^\s*(import|export)\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm,
  ))
    specs.push(match[2] ?? "");
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(match[1] ?? "");
  for (const match of text.matchAll(/(?<!typeof\s)\bimport\(\s*["']([^"']+)["']\s*\)/g))
    specs.push(match[1] ?? "");
  return specs;
}

const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("provider dependency registry (ADR-0047 decision 15)", () => {
  it("declares every non-WhatsApp dependency exactly once, pinned to an exact version", () => {
    const declared = PROVIDER_DEPENDENCIES.map((d) => d.packageName);
    expect(new Set(declared).size).toBe(declared.length);
    const deps = Object.keys(pkg.dependencies).filter(
      (name) =>
        name !== "@deskmates/contracts" && (!GRANDFATHERED.has(name) || declared.includes(name)),
    );
    expect(deps.sort()).toEqual([...declared].sort());
    for (const entry of PROVIDER_DEPENDENCIES) {
      expect(pkg.dependencies[entry.packageName], entry.packageName).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.reason.trim().length, entry.packageName).toBeGreaterThan(0);
    }
  });

  it("keeps the registry sorted by provider, then package", () => {
    const keys = PROVIDER_DEPENDENCIES.map((d) => `${d.provider}\n${d.packageName}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("imports a third-party package only from the registry, and there only dynamically", () => {
    for (const file of walk(SRC)) {
      const path = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      for (const spec of runtimeImports(text).filter(thirdParty)) {
        const allowed =
          (path === REGISTRY && text.includes(`import("${spec}")`)) ||
          (GRANDFATHERED.has(spec) && GRANDFATHERED_FILE.test(path));
        expect(allowed, `${path} imports ${spec}`).toBe(true);
      }
    }
    // The registry itself has no static third-party import.
    const registry = readFileSync(join(SRC, REGISTRY), "utf8");
    expect(
      [...registry.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)]
        .map((m) => m[1] ?? "")
        .filter(thirdParty),
    ).toEqual([]);
  });

  it("loads a declared dependency once and refuses an undeclared one", async () => {
    let calls = 0;
    const registry: ProviderDependency[] = [
      {
        provider: "fakechat",
        packageName: "fake-sdk",
        reason: "test",
        load: async () => {
          calls += 1;
          return { version: "1" };
        },
      },
    ];
    const first = await loadProviderDependency<{ version: string }>(
      "fakechat",
      "fake-sdk",
      registry,
    );
    const second = await loadProviderDependency("fakechat", "fake-sdk", registry);
    expect(first).toEqual({ version: "1" });
    expect(second).toBe(first);
    expect(calls).toBe(1);
    await expect(loadProviderDependency("otherchat", "fake-sdk", registry)).rejects.toThrow(
      /not a declared dependency of the otherchat channel/,
    );
  });
});
