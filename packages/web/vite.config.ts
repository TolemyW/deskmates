// Vite config for the operator UI. The dev server proxies the Gateway's operator routes (`/api`,
// `/auth` for sign-in, `/analytics` for the Grafana relay, `/hooks`) so the UI runs on WEB_PORT
// same-origin, without CORS, and the session cookie belongs to the page's origin; ports come from
// the repo-root `.env`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { uiLegalAssets } from "../ui/scripts/legal-assets.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The release this UI is built for: `version` and `revision` of the `release-manifest.json` that
 * scripts/stable/stable.sh finds at the root of releases/<tag>/. A working copy has none, and the
 * bundled manual then says it is a development build (issue #28).
 */
export function readWebBuild(root: string = repoRoot): {
  release: string | null;
  revision: string | null;
} {
  try {
    const manifest = JSON.parse(readFileSync(`${root}/release-manifest.json`, "utf8")) as {
      version?: unknown;
      revision?: unknown;
    };
    const release =
      typeof manifest.version === "string" && /^v\d+\.\d+\.\d+$/.test(manifest.version)
        ? manifest.version
        : null;
    const revision =
      release && typeof manifest.revision === "string" && /^[0-9a-f]{7,40}$/.test(manifest.revision)
        ? manifest.revision
        : null;
    return { release, revision };
  } catch {
    return { release: null, revision: null };
  }
}

// `@deskmates/contracts` is resolved to its TypeScript source so the UI builds without `tsc -b`.
const contractsSrc = fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url));

export default defineConfig(({ mode }) => {
  // Empty prefix: read every variable, not only VITE_*. Nothing here is exposed to the client.
  const env = loadEnv(mode, repoRoot, "");
  const operatorPort = env.OPERATOR_PORT || "8081";
  const webPort = Number.parseInt(env.WEB_PORT || "5173", 10);
  const gateway = `http://localhost:${operatorPort}`;
  // DESKMATES_DEMO=1 builds the standalone demo (demo.html on the in-browser mock Gateway) into
  // dist-demo with relative asset paths, so the bundle can be served from any path or opened as
  // files. The default build is the operator UI the Gateway serves.
  const demo = process.env.DESKMATES_DEMO === "1";

  return {
    plugins: [react(), tailwindcss(), uiLegalAssets()],
    define: { __DESKMATES_WEB_BUILD__: JSON.stringify(readWebBuild()) },
    ...(demo ? { base: "./" } : {}),
    resolve: {
      alias: {
        "@deskmates/contracts": contractsSrc,
        "@deskmates/ui/styles.css": fileURLToPath(new URL("../ui/src/styles.css", import.meta.url)),
        "@deskmates/ui": fileURLToPath(new URL("../ui/src/index.ts", import.meta.url)),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: gateway, changeOrigin: false, ws: true },
        // ADR-0022 sign-in. Without it `/auth/session` gets Vite's HTML fallback and the UI
        // reports the Gateway as unreachable.
        "/auth": { target: gateway, changeOrigin: false },
        // ADR-0046 amendment 1: the Gateway's relay to Grafana, for the root's session. Grafana
        // Live is off, so no WebSocket.
        "/analytics": { target: gateway, changeOrigin: false },
        "/hooks": { target: gateway, changeOrigin: false, ws: true },
      },
    },
    build: demo
      ? {
          outDir: "dist-demo",
          emptyOutDir: true,
          rollupOptions: { input: fileURLToPath(new URL("./demo.html", import.meta.url)) },
        }
      : { outDir: "dist", emptyOutDir: true },
  };
});
