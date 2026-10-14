// Static (ADR-0017 decision 2): the adapter imports nothing from other workspace packages but
// contracts; only the linked-device runtime and its release plugin entry own the ADR-0019 vendor
// dependencies.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_DIR = join(SRC, "..");
const GATEWAY_SRC = join(PACKAGE_DIR, "..", "gateway", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const IMPORT = /from\s+["']([^"']+)["']/g;

describe("package boundary", () => {
  it("imports only node builtins, relative modules and @deskmates/contracts", () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const spec = match[1] ?? "";
        const allowed =
          spec.startsWith("node:") ||
          spec.startsWith("./") ||
          spec.startsWith("../") ||
          spec === "@deskmates/contracts" ||
          spec === "vitest" ||
          (file.endsWith("/whatsapp/plugin.ts") && spec === "qrcode") ||
          ((file.includes("/whatsapp-web/") || file.endsWith("/whatsapp-web-main.ts")) &&
            ["@whiskeysockets/baileys", "pino", "qrcode", "https-proxy-agent"].includes(spec));
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("pins QR dependencies without importing another workspace package", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({
      "@deskmates/contracts": "*",
      "@whiskeysockets/baileys": "7.0.0-rc14",
      pino: "9.6.0",
      qrcode: "1.5.4",
      "https-proxy-agent": "7.0.6",
    });
    expect(pkg.devDependencies).toEqual({ "@types/qrcode": "1.5.5" });
  });

  it("starts the binary with a Node shebang so the bin entry runs from a shell", () => {
    const entry = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(entry.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("leaves the Gateway's production code free of WhatsApp", () => {
    for (const file of walk(GATEWAY_SRC).filter((f) => !f.endsWith(".test.ts"))) {
      expect(readFileSync(file, "utf8").toLowerCase(), file).not.toContain("whatsapp");
    }
  });
});
