import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle, Workspace } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Stack, addWorkspace } from "./start-stack.js";
import { stopStack } from "./stop-stack.js";

const dirs: string[] = [];
const journalBefore = process.env.DESKMATES_SOAK_JOURNAL;
const ledgerBefore = process.env.DESKMATES_QA_LEDGER_DIR;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Not `= undefined`: process.env would store the string "undefined".
  if (journalBefore === undefined) Reflect.deleteProperty(process.env, "DESKMATES_SOAK_JOURNAL");
  else process.env.DESKMATES_SOAK_JOURNAL = journalBefore;
  if (ledgerBefore === undefined) Reflect.deleteProperty(process.env, "DESKMATES_QA_LEDGER_DIR");
  else process.env.DESKMATES_QA_LEDGER_DIR = ledgerBefore;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-extra-ws-test-"));
  dirs.push(dir);
  return dir;
}

describe("addWorkspace", () => {
  it("journals the workspace before provisioning, then waits healthy and records it on the stack", async () => {
    const journal = join(tempDir(), "journal.ndjson");
    process.env.DESKMATES_SOAK_JOURNAL = journal;
    const steps: string[] = [];
    const specs: { workspaceId: string; volumes: Record<string, string> }[] = [
      { workspaceId: "ws_own", volumes: { profile: "own-profile" } },
    ];
    const handle = { providerRef: "arm-b-container" } as SandboxHandle;
    const stack = {
      extraWorkspaces: [],
      api: async (method: string, path: string, body: unknown) => {
        steps.push(`${method} ${path} ${JSON.stringify(body)}`);
        return { status: 201, json: { workspace: { id: "ws_b", name: "m0-arm-b" } } };
      },
      app: {
        deskmates: {
          ctx: {
            sandboxes: {
              ensure: async (workspace: Workspace) => {
                // An interrupted campaign must find this workspace in the receipt already.
                steps.push(
                  `ensure ${workspace.id} journal=${readFileSync(journal, "utf8").trim()}`,
                );
                specs.push({
                  workspaceId: workspace.id,
                  volumes: { profile: "b-profile", work: "b-work", home: "b-home" },
                });
                return handle;
              },
            },
          },
        },
      },
      provider: {
        specs,
        exec: async (target: SandboxHandle, req: { cmd: string[] }) => {
          steps.push(`exec ${target.providerRef} ${req.cmd.join(" ")}`);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Stack;

    const extra = await addWorkspace(stack, { label: "arm-b", egressAllowlist: ["site.test"] });

    expect(steps).toEqual([
      `POST /api/workspaces ${JSON.stringify({ defaultBot: false, name: "m0-arm-b", egressAllowlist: ["site.test"] })}`,
      `ensure ws_b journal=${JSON.stringify({ workspaceId: "ws_b" })}`,
      "exec arm-b-container deskmates-healthz",
    ]);
    expect(extra.workspace.id).toBe("ws_b");
    expect(extra.handle).toBe(handle);
    expect(extra.volumes).toEqual(["b-profile", "b-work", "b-home"]);
    expect(stack.extraWorkspaces).toEqual([extra]);
  });

  it("fails with the Gateway's answer when the workspace is not created", async () => {
    const stack = {
      extraWorkspaces: [],
      api: async () => ({ status: 400, json: { error: "bad allowlist" } }),
    } as unknown as Stack;
    await expect(addWorkspace(stack, { label: "x", egressAllowlist: [] })).rejects.toThrow(
      /create workspace x: 400 .*bad allowlist/,
    );
    expect(stack.extraWorkspaces).toEqual([]);
  });
});

describe("stopStack", () => {
  it("saves the drained ledger after a restart test closed the original Gateway", async () => {
    const tmp = tempDir();
    const evidence = tempDir();
    process.env.DESKMATES_QA_LEDGER_DIR = evidence;
    const dbPath = join(tmp, "gateway.sqlite");
    const original = new Database(dbPath);
    original.exec("CREATE TABLE usage (tokens INTEGER)");
    original.close();
    const restarted = new Database(dbPath);
    restarted.pragma("journal_mode = WAL");
    const stack = {
      handle: { providerRef: "own" },
      volumes: [],
      tmpDir: tmp,
      dbPath,
      workspace: { id: "ws_restart" },
      extraWorkspaces: [],
      docker: {
        destroy: async () => {},
        removeHostResources: async () => [],
        client: { request: async () => ({ status: 204 }) },
      },
      app: {
        deskmates: {
          ctx: { db: original },
          scheduler: {
            drain: async () => {
              restarted.exec("INSERT INTO usage VALUES (19)");
            },
          },
        },
        close: async () => restarted.close(),
      },
      site: { close: async () => {} },
    } as unknown as Stack;
    try {
      await stopStack(stack);
      const receipt = JSON.parse(
        readFileSync(join(evidence, "ledger-backup-status.jsonl"), "utf8"),
      );
      expect(receipt).toMatchObject({
        status: "saved",
        mode: "reopened_readonly",
        workspaceId: "ws_restart",
      });
      const saved = new Database(join(evidence, receipt.target), { readonly: true });
      try {
        expect(saved.prepare("SELECT tokens FROM usage").pluck().all()).toEqual([19]);
      } finally {
        saved.close();
      }
      expect(existsSync(tmp)).toBe(false);
    } finally {
      if (restarted.open) restarted.close();
    }
  });
  it("destroys every extra workspace and its volumes even when one destroy throws", async () => {
    const tmp = tempDir();
    const destroyed: string[] = [];
    const deletedVolumes: string[] = [];
    const order: string[] = [];
    const problems: string[] = [];
    const handle = (ref: string) => ({ providerRef: ref }) as SandboxHandle;
    const stack = {
      handle: handle("own"),
      volumes: ["own-profile"],
      tmpDir: tmp,
      // The two injected failures are this test's point, not a teardown accident: collected here,
      // they stay off stderr, and the assertion below pins that they are reported.
      onStopProblem: (message: string) => problems.push(message),
      extraWorkspaces: [
        { workspace: { id: "ws_a" }, handle: handle("extra-a"), volumes: ["a-profile", "a-work"] },
        { workspace: { id: "ws_b" }, handle: handle("extra-b"), volumes: ["b-profile"] },
      ],
      docker: {
        destroy: async (h: SandboxHandle) => {
          order.push(`destroy ${h.providerRef}`);
          destroyed.push(h.providerRef);
          if (h.providerRef === "extra-a") throw new Error("container busy");
        },
        // The label sweep after the volumes (ADR-0006 amendment 5 decision 15).
        removeHostResources: async (target: { workspaceId: string }) => {
          order.push(`sweep ${target.workspaceId}`);
          return [];
        },
        client: {
          request: async (method: string, path: string) => {
            order.push(`${method} ${path}`);
            if (path.startsWith("/volumes/a-profile")) throw new Error("volume in use");
            deletedVolumes.push(path);
            return { status: 204 };
          },
        },
      },
      app: {
        deskmates: { scheduler: { drain: async () => order.push("drain") } },
        close: async () => order.push("close"),
      },
      site: { close: async () => order.push("site") },
    } as unknown as Stack;

    await stopStack(stack);

    expect(destroyed).toEqual(["own", "extra-a", "extra-b"]);
    // Containers go first, before the scheduler is drained, so no sidecar exec can hang the drain.
    expect(order.indexOf("destroy extra-b")).toBeLessThan(order.indexOf("drain"));
    expect(deletedVolumes).toEqual([
      "/volumes/own-profile?force=true",
      "/volumes/a-work?force=true",
      "/volumes/b-profile?force=true",
    ]);
    expect(order.filter((step) => step.startsWith("sweep "))).toEqual(["sweep ws_a", "sweep ws_b"]);
    expect(order.indexOf("sweep ws_a")).toBeGreaterThan(
      order.indexOf("DELETE /volumes/b-profile?force=true"),
    );
    expect(existsSync(tmp)).toBe(false);
    // Best-effort means carry on, never say nothing.
    expect(problems).toEqual([
      "[acceptance] stop-stack: destroy container of ws_a failed: Error: container busy",
      "[acceptance] stop-stack: remove volume a-profile failed: Error: volume in use",
    ]);
  });

  it("still tears down a stack that never added a workspace", async () => {
    const destroyed: string[] = [];
    const stack = {
      handle: { providerRef: "own" },
      volumes: [],
      tmpDir: tempDir(),
      extraWorkspaces: [],
      docker: {
        destroy: async (h: SandboxHandle) => destroyed.push(h.providerRef),
        client: { request: async () => ({ status: 204 }) },
      },
      app: { deskmates: { scheduler: { drain: async () => {} } }, close: async () => {} },
      site: { close: async () => {} },
    } as unknown as Stack;
    await stopStack(stack);
    expect(destroyed).toEqual(["own"]);
  });
});
