// Production wiring of `SidecarDeps`: the real Agent SDK, global fetch, node:fs and the clock.
// This is the only module in the repository that imports the SDK's runtime (ADR-0002 decision 1).

import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SidecarDeps, SidecarFs } from "./deps.js";
import { readResourceObservation } from "./resource-observation.js";
import { saveToolEvidence } from "./tool-evidence-store.js";

export const realFs: SidecarFs = {
  readFile: (path) => readFile(path, "utf8"),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  appendFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, "utf8");
  },
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rm: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
};

export function createRealDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SidecarDeps {
  return {
    saveToolEvidence,
    observeResources: () =>
      readResourceObservation(
        (path) => readFile(path, "utf8"),
        () => process.memoryUsage().rss,
      ),
    spawnPty: async ({ command, cwd, cols, rows }) => {
      const pty = await import("node-pty");
      const terminalEnv: Record<string, string> = { TERM: "xterm-256color" };
      for (const key of ["PATH", "HOME", "LANG", "TZ", "DISPLAY", "USER", "SHELL"]) {
        const value = env[key];
        if (value !== undefined) terminalEnv[key] = value;
      }
      const child = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd,
        cols,
        rows,
        name: "xterm-256color",
        env: terminalEnv,
      });
      return {
        write: (data) => child.write(data),
        resize: (c, r) => child.resize(c, r),
        onData: (callback) => child.onData(callback),
        onExit: (callback) => child.onExit(callback),
        kill: () => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
          try {
            child.kill("SIGKILL");
          } catch {
            /* Already exited. */
          }
        },
      };
    },
    query: (params) => query(params),
    tool,
    createSdkMcpServer,
    fetch: (input, init) => globalThis.fetch(input, init),
    fs: realFs,
    now: () => new Date(),
    uptimeSeconds: () => process.uptime(),
    env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
