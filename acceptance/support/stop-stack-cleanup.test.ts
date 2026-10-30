// T0: ADR-0006 amendment 5 decision 15. stopStack removes every resource labelled with each
// workspace the stack created, including one `addWorkspace` created but never provisioned; a
// failed start is taken down by `abandonStart`; `DESKMATES_T2_KEEP_WORKSPACE=1` keeps them all
// and says so. The real-daemon side is host-resources.container.test.ts.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostResourceTarget, SandboxHandle } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Stack } from "./start-stack.js";
import { KEEP_WORKSPACE_ENV, abandonStart, stopStack } from "./stop-stack.js";

const keepBefore = process.env[KEEP_WORKSPACE_ENV];
afterEach(() => {
  if (keepBefore === undefined) Reflect.deleteProperty(process.env, KEEP_WORKSPACE_ENV);
  else process.env[KEEP_WORKSPACE_ENV] = keepBefore;
});

function fakeStack(log: string[], problems: string[]): Stack {
  return {
    handle: { providerRef: "own" } as SandboxHandle,
    volumes: ["deskmates-ws_own-work"],
    tmpDir: mkdtempSync(join(tmpdir(), "deskmates-stop-cleanup-")),
    workspace: { id: "ws_own" },
    // `addWorkspace` recorded ws_half, whose sandbox never came up: no handle, no volumes known.
    createdWorkspaceIds: ["ws_own", "ws_half"],
    extraWorkspaces: [],
    onStopProblem: (message: string) => problems.push(message),
    docker: {
      destroy: async (h: SandboxHandle) => log.push(`destroy ${h.providerRef}`),
      removeHostResources: async (target: HostResourceTarget) => {
        log.push(`sweep ${target.kind === "workspace" ? target.workspaceId : target.name}`);
        return [];
      },
      client: {
        request: async (method: string, path: string) => {
          log.push(`${method} ${path}`);
          return { status: 204 };
        },
      },
    },
    app: { deskmates: { scheduler: { drain: async () => {} } }, close: async () => {} },
    site: { close: async () => {} },
  } as unknown as Stack;
}

describe("stopStack cleans up after itself", () => {
  it("removes every workspace the stack created by its labels, a half-made one included", async () => {
    const log: string[] = [];
    const problems: string[] = [];
    const stack = fakeStack(log, problems);
    await stopStack(stack);
    expect(log).toEqual([
      "destroy own",
      "DELETE /volumes/deskmates-ws_own-work?force=true",
      "sweep ws_own",
      "sweep ws_half",
    ]);
    expect(problems).toEqual([]);
    expect(existsSync(stack.tmpDir)).toBe(false);
  });

  it(`keeps every workspace with ${KEEP_WORKSPACE_ENV}=1 and says which`, async () => {
    process.env[KEEP_WORKSPACE_ENV] = "1";
    const log: string[] = [];
    const problems: string[] = [];
    await stopStack(fakeStack(log, problems));
    expect(log).toEqual([]);
    expect(problems).toEqual([
      expect.stringContaining(`${KEEP_WORKSPACE_ENV}=1: kept workspace ws_own, ws_half`),
    ]);
  });

  it("takes a failed start down: Gateway, site, the workspace it created, the temp dir", async () => {
    const log: string[] = [];
    const tmpDir = mkdtempSync(join(tmpdir(), "deskmates-abandon-"));
    await abandonStart(
      {
        workspaceIds: ["ws_failed"],
        tmpDir,
        app: { close: async () => log.push("close gateway") },
        site: { close: async () => log.push("close site") },
        docker: {
          removeHostResources: async (target: HostResourceTarget) => {
            log.push(`sweep ${target.kind === "workspace" ? target.workspaceId : target.name}`);
            return [];
          },
        },
      },
      (message) => log.push(message),
    );
    expect(log).toEqual(["close gateway", "close site", "sweep ws_failed"]);
    expect(existsSync(tmpDir)).toBe(false);
  });
});
