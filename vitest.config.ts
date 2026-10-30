// Root Vitest config shared by every tier. Tier selection stays in the package.json scripts
// (`--exclude` for T0/T1, a filename filter for T2/T3); this fixes resolution and what to skip.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages are resolved to their TypeScript sources so tests run without a prior
// `tsc -b` (package.json `main` points at dist/).
const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** `@deskmates/sidecar/<module>.js` -> the source file, matching `evals/tsconfig.json`'s paths. */
const SIDECAR_SRC = fileURLToPath(new URL("./packages/sidecar/src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // evals/replay.ts reaches into the sidecar by module path rather than through its entry
      // point, which would pull in real-deps.ts and with it the real Agent SDK runtime.
      { find: /^@deskmates\/sidecar\/(.*)\.js$/, replacement: `${SIDECAR_SRC}$1.ts` },
      { find: "@deskmates/contracts", replacement: src("contracts") },
      { find: "@deskmates/ui", replacement: src("ui") },
      { find: "@deskmates/testkit", replacement: src("testkit") },
      // acceptance/ wires real packages together; T2/T3 only, never imported by packages/.
      { find: "@deskmates/gateway", replacement: src("gateway") },
      { find: "@deskmates/sandbox-docker", replacement: src("sandbox-docker") },
      { find: "@deskmates/golden-site", replacement: src("golden-site") },
    ],
  },
  test: {
    setupFiles: [fileURLToPath(new URL("./packages/ui/test-setup.ts", import.meta.url))],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-studio/**",
      // Agent worktrees are checkouts of in-progress branches, not part of this tree.
      ".claude/**",
      // Local scratch can contain old checkouts; it is not repository source.
      "tmp/**",
      "spikes/**",
    ],
  },
});
