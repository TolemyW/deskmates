// T0 static checks (ADR-0013 verification rows 1 and 2). No package depends on the integration
// runtime; only `packages/gateway/src/integrations/` names its routes or its tool names (the
// testkit fake, which stands in for the runtime, is the one other place allowed to).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));

/** Strings only the runtime adapter may contain: the meta-tool names and the runtime's routes. */
const RUNTIME_MARKERS = [
  "list_apps",
  "list_connections",
  "search_actions",
  "get_action_guide",
  "execute_action",
  "/api/runtime-tokens",
  "/api/oauth/",
  "/v1/providers/",
];

/**
 * The integrations module and the fake that stands in for the runtime. Within the module,
 * `runtime-adapter.ts` is the file that calls them; the rest reaches the runtime by method, and
 * its tests inspect what the fake received.
 */
const ALLOWED = ["gateway/src/integrations/", "testkit/src/fake-integration-runtime/"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe("integration runtime boundary", () => {
  it("no package.json in packages/ names the runtime", () => {
    for (const pkg of readdirSync(PACKAGES)) {
      let text: string;
      try {
        text = readFileSync(join(PACKAGES, pkg, "package.json"), "utf8");
      } catch {
        continue;
      }
      expect(text, pkg).not.toMatch(/open-connector|oomol/i);
    }
  });

  it("only the integrations module references the runtime's routes and tool names", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      let src: string;
      try {
        src = join(PACKAGES, pkg, "src");
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        const rel = relative(PACKAGES, file).split("\\").join("/");
        if (ALLOWED.some((a) => rel.startsWith(a))) continue;
        const text = readFileSync(file, "utf8");
        for (const marker of RUNTIME_MARKERS) {
          if (text.includes(marker)) offenders.push(`${rel}: ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
