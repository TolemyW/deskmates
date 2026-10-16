// T0. Images preinstall everything (AGENTS.md): the sidecar runs from /opt/deskmates/sidecar/dist
// inside the workspace image and resolves its runtime dependencies through
// /opt/deskmates/node_modules, where images/workspace/Dockerfile links each one from the base
// image's global install (ESM ignores NODE_PATH). A dependency added to the sidecar without a
// link fails only when a run starts in the real image (v0.7.0 shipped without `openai` and no
// sidecar could start), so this checks the Dockerfile against the sidecar's package.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const dockerfile = readFileSync(new URL("images/workspace/Dockerfile", root), "utf8");
const sidecar = JSON.parse(
  readFileSync(new URL("packages/sidecar/package.json", root), "utf8"),
) as { dependencies: Record<string, string> };

describe("workspace image links every sidecar runtime dependency", () => {
  for (const name of Object.keys(sidecar.dependencies).sort()) {
    it(`links ${name} into /opt/deskmates/node_modules`, () => {
      expect(dockerfile, `${name} is a sidecar dependency with no link`).toMatch(
        new RegExp(`ln -s \\S+ /opt/deskmates/node_modules/${name.replace("/", "\\/")}(\\s|$)`),
      );
      expect(dockerfile, `${name} link is not checked after it is made`).toContain(
        `test -f /opt/deskmates/node_modules/${name}/package.json`,
      );
    });
  }
});
