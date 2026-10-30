// @vitest-environment node
// (The config imports Vite and esbuild, which refuse jsdom's TextEncoder; `npm test -w
// packages/web` runs with --environment jsdom.)
// T0: the dev server must forward every operator route family the UI calls, including the
// ADR-0022 sign-in routes; a missing prefix falls through to Vite's HTML and breaks sign-in.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigEnv, UserConfig } from "vite";
import { expect, it } from "vitest";
import config, { readWebBuild } from "../vite.config.js";

it("proxies /api, /auth, /analytics and /hooks to the operator listener without rewriting Host", () => {
  const resolved = (config as (env: ConfigEnv) => UserConfig)({
    command: "serve",
    mode: "development",
  });
  const proxy = resolved.server?.proxy as Record<string, { target: string; changeOrigin: boolean }>;
  // `/analytics` is the Grafana relay (ADR-0046 amendment 1 decision 16).
  for (const prefix of ["/api", "/auth", "/analytics", "/hooks"]) {
    expect(proxy[prefix], prefix).toBeDefined();
    expect(proxy[prefix]?.target, prefix).toMatch(/^http:\/\/localhost:\d+$/);
    // Same-origin checks compare Origin with Host; the proxy must keep the browser's Host.
    expect(proxy[prefix]?.changeOrigin, prefix).toBe(false);
  }
});

it("defines the release the bundled manual was built for (issue #28)", () => {
  const resolved = (config as (env: ConfigEnv) => UserConfig)({
    command: "build",
    mode: "production",
  });
  const define = resolved.define as Record<string, string>;
  expect(JSON.parse(define.__DESKMATES_WEB_BUILD__ ?? "")).toEqual(readWebBuild());
});

it("reads the release from release-manifest.json and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "deskmates-web-build-"));
  try {
    // A working copy has no manifest: a development build, not a version.
    expect(readWebBuild(root)).toEqual({ release: null, revision: null });
    writeFileSync(
      join(root, "release-manifest.json"),
      JSON.stringify({ schema: 2, version: "v0.4.0", revision: "4a87a5d0123456789abcdef" }),
    );
    expect(readWebBuild(root)).toEqual({ release: "v0.4.0", revision: "4a87a5d0123456789abcdef" });
    writeFileSync(join(root, "release-manifest.json"), JSON.stringify({ version: "main" }));
    expect(readWebBuild(root)).toEqual({ release: null, revision: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
