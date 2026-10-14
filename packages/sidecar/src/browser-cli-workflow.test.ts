import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { RunId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserCliWorkflowDeps,
  type BrowserCliWorkflowInput,
  type CliInvocationResult,
  buildBrowserCliProgram,
  buildBrowserCliScreenshotProgram,
  executeBrowserCliWorkflow,
  validateBrowserCliWorkflow,
} from "./browser-cli-workflow.js";

const runId = "run-1" as RunId;
const tabId = "target-abc";
const origin = "https://shop.example.com";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function invocation(exitCode: number, stdout = "", stderr = ""): CliInvocationResult {
  return { exitCode, stdout, stderr };
}

function harness(results: CliInvocationResult[]) {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  let lockCalls = 0;
  const deps: BrowserCliWorkflowDeps = {
    client: {
      getEgressAllowlist: async () => ({
        type: "egress_allowlist" as const,
        egressAllowlist: ["shop.example.com"],
        updatedAt: "2026-09-23T00:00:00.000Z",
      }),
      browserLock: async () => {
        lockCalls += 1;
        return { type: "browser_lock_result" as const, runId, granted: true, epoch: 7 };
      },
      browserOrigin: async () => ({
        type: "browser_origin_result" as const,
        runId,
        granted: true,
      }),
    },
    readBrowserState: async () => ({
      version: 1,
      runId,
      tabId,
      tabs: [{ id: tabId, url: `${origin}/orders`, current: true }],
    }),
    invoke: async (_command, args) => {
      mutableCalls.push([...args]);
      return results.shift() ?? invocation(0);
    },
  };
  return { deps, calls, lockCalls: () => lockCalls };
}

const context = {
  runId,
  cdpEndpoint: "http://127.0.0.1:9222",
  coordination: {
    runId,
    gatewayBaseUrl: "http://gateway",
    token: "secret",
    statePath: "/tmp/browser.json",
    browserExecutionMode: "vision-cli-v2" as const,
  },
};

describe("governed browser CLI workflows", () => {
  it("accepts the exact managed host origin but still requires its live allowlist entry", async () => {
    const expectedOrigin = "http://host.docker.internal:18765";
    const input = { expectedOrigin, steps: [{ action: "snapshot" as const }] };
    expect(validateBrowserCliWorkflow(input)).toEqual(input);
    const h = harness([]);
    await expect(executeBrowserCliWorkflow(input, context, h.deps)).rejects.toThrow(
      "live egress allowlist",
    );
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    "http://host.docker.internal.:18765",
    "http://other.internal:18765",
    "http://child.host.docker.internal:18765",
    "http://127.0.0.1:18765",
    "http://[::1]:18765",
    "http://user@host.docker.internal:18765",
    "http://host.docker.internal:18765/path",
  ])("rejects host exception lookalikes and malformed origins: %s", (expectedOrigin) => {
    expect(() =>
      validateBrowserCliWorkflow({ expectedOrigin, steps: [{ action: "snapshot" }] }),
    ).toThrow("expectedOrigin");
  });

  it("invokes the installed CLI with attach, a fixed host program, and detach", async () => {
    const receipt = JSON.stringify({
      deskmatesWorkflow: 1,
      targetId: tabId,
      url: `${origin}/done`,
      observations: ["- heading Orders"],
    });
    const h = harness([
      invocation(0, "attached"),
      invocation(0, receipt),
      invocation(0, receipt),
      invocation(0, receipt),
      invocation(0),
    ]);
    const result = await executeBrowserCliWorkflow(
      {
        expectedOrigin: origin,
        steps: [
          { action: "fill", locator: "#query", value: "open orders" },
          { action: "click", locator: "button[type=submit]" },
          { action: "snapshot" },
        ],
      },
      context,
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain('<untrusted source="page:https://shop.example.com">');
    expect(h.calls[0]).toEqual(["-s=deskmates-run-1", "attach", "--cdp=http://127.0.0.1:9222"]);
    expect(h.calls[1]?.slice(0, 3)).toEqual(["-s=deskmates-run-1", "--raw", "run-code"]);
    expect(h.calls[4]).toEqual(["-s=deskmates-run-1", "detach"]);
    expect(h.lockCalls()).toBe(7);
  });

  it("returns an uncertain outcome and never retries when the completion receipt is missing", async () => {
    const h = harness([
      invocation(0, "attached"),
      invocation(1, "page output that must not be trusted as completion"),
      invocation(0),
    ]);
    const result = await executeBrowserCliWorkflow(
      { expectedOrigin: origin, steps: [{ action: "click", locator: "#charge" }] },
      context,
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, mayHaveCompleted: true });
    expect(result.text).toContain("may have completed");
    expect(h.calls).toHaveLength(3);
    expect(h.calls.filter((args) => args.includes("run-code"))).toHaveLength(1);
  });

  it("stops the batch after a takeover epoch change and dispatches no later step", async () => {
    const receipt = JSON.stringify({
      deskmatesWorkflow: 1,
      targetId: tabId,
      url: `${origin}/orders`,
      observations: [],
    });
    const h = harness([invocation(0, "attached"), invocation(0, receipt), invocation(0)]);
    let lock = 0;
    h.deps.client.browserLock = async () => ({
      type: "browser_lock_result" as const,
      runId,
      granted: true,
      epoch: ++lock >= 3 ? 8 : 7,
    });
    const result = await executeBrowserCliWorkflow(
      {
        expectedOrigin: origin,
        steps: [
          { action: "click", locator: "#first" },
          { action: "click", locator: "#must-not-run" },
        ],
      },
      context,
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, mayHaveCompleted: true });
    expect(h.calls.filter((args) => args.includes("run-code"))).toHaveLength(1);
  });

  it("treats a transport failure after dispatch as uncertain and gives no retry invitation", async () => {
    const h = harness([]);
    let calls = 0;
    h.deps.invoke = async (_command, args) => {
      calls += 1;
      if (args.includes("attach") || args.includes("detach")) return invocation(0, "attached");
      throw new Error("CLI transport lost");
    };
    const result = await executeBrowserCliWorkflow(
      { expectedOrigin: origin, steps: [{ action: "click", locator: "#charge" }] },
      context,
      h.deps,
    );
    expect(result).toMatchObject({ ok: false, mayHaveCompleted: true });
    expect(result.text).toContain("do not retry");
    expect(result.text).toContain("CLI transport lost");
    expect(calls).toBe(3);
  });

  it("emits one bounded final screenshot without putting its base64 in model text", async () => {
    const actionReceipt = JSON.stringify({
      deskmatesWorkflow: 1,
      targetId: tabId,
      url: `${origin}/orders`,
      observations: [],
    });
    const base64 = Buffer.from("jpeg bytes").toString("base64");
    const screenshot = JSON.stringify({
      deskmatesScreenshot: 1,
      targetId: tabId,
      url: `${origin}/orders`,
      mimeType: "image/jpeg",
      base64,
    });
    const h = harness([
      invocation(0, "attached"),
      invocation(0, actionReceipt),
      invocation(0, screenshot),
      invocation(0),
    ]);
    const captures: { base64: string; bytes: number; tabId: string }[] = [];
    h.deps.onScreenshot = async (capture) => {
      captures.push(capture);
    };
    const result = await executeBrowserCliWorkflow(
      { expectedOrigin: origin, steps: [{ action: "click", locator: "#save" }] },
      context,
      h.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain(base64);
    expect(captures).toMatchObject([
      { base64, bytes: Buffer.from(base64, "base64").length, tabId },
    ]);
    expect(h.calls.filter((args) => args.includes("run-code"))).toHaveLength(2);
  });

  it("rejects cross-origin navigation before invoking the CLI", async () => {
    const h = harness([]);
    await expect(
      executeBrowserCliWorkflow(
        {
          expectedOrigin: origin,
          steps: [{ action: "goto", url: "https://other.example.com/checkout" }],
        },
        context,
        h.deps,
      ),
    ).rejects.toThrow("stay on the reviewed");
    expect(h.calls).toHaveLength(0);
  });

  it("binds a saved manifest to both its hash and the fully reviewed input", async () => {
    const scripts = await mkdtemp(path.join(tmpdir(), "deskmates-scripts-"));
    directories.push(scripts);
    const workflow: BrowserCliWorkflowInput = {
      expectedOrigin: origin,
      steps: [{ action: "click", locator: "#save" }],
    };
    const bytes = JSON.stringify({ version: 1, ...workflow });
    const scriptPath = path.join(scripts, "save-order.json");
    await writeFile(scriptPath, bytes);
    const h = harness([]);
    await expect(
      executeBrowserCliWorkflow(
        {
          ...workflow,
          steps: [{ action: "click", locator: "#delete" }],
          savedScript: {
            path: scriptPath,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
        { ...context, scriptsDirectory: scripts },
        h.deps,
      ),
    ).rejects.toThrow("does not exactly match");
    expect(h.calls).toHaveLength(0);
  });

  it("does not accept arbitrary JavaScript as a workflow step", () => {
    expect(() =>
      validateBrowserCliWorkflow({
        expectedOrigin: origin,
        steps: [{ action: "eval", code: "fetch('https://evil.test')" }],
      }),
    ).toThrow("invalid step");
    const program = buildBrowserCliProgram(
      { expectedOrigin: origin, steps: [{ action: "click", locator: "#save" }] },
      tabId,
    );
    expect(program).toContain("Target.getTargetInfo");
    expect(program).toContain("Deskmates exact run target");
  });

  it("runs host-authored workflow and screenshot code without URL in the CLI sandbox", async () => {
    const fills: string[] = [];
    const page = {
      context: () => ({
        pages: () => [page],
        newCDPSession: async () => ({
          send: async () => ({ targetInfo: { targetId: tabId } }),
          detach: async () => {},
        }),
      }),
      url: () => `${origin}/login`,
      evaluate: async () => origin,
      locator: () => ({ fill: async (value: string) => fills.push(value) }),
      screenshot: async () => Buffer.from("test jpeg"),
    };
    const workflow = runInNewContext(
      buildBrowserCliProgram(
        { expectedOrigin: origin, steps: [{ action: "fill", locator: "#email", value: "run" }] },
        tabId,
      ),
      {},
    ) as (page: unknown) => Promise<{ deskmatesWorkflow: number; targetId: string }>;
    expect(await workflow(page)).toMatchObject({ deskmatesWorkflow: 1, targetId: tabId });
    expect(fills).toEqual(["run"]);

    const screenshot = runInNewContext(buildBrowserCliScreenshotProgram(tabId, origin), {}) as (
      page: unknown,
    ) => Promise<{ deskmatesScreenshot: number; targetId: string; base64: string }>;
    expect(await screenshot(page)).toMatchObject({
      deskmatesScreenshot: 1,
      targetId: tabId,
      base64: Buffer.from("test jpeg").toString("base64"),
    });
  });
});

it("rechecks live egress between steps and stops before dispatch after revocation", async () => {
  const receipt = JSON.stringify({
    deskmatesWorkflow: 1,
    targetId: tabId,
    url: origin,
    observations: [],
  });
  const h = harness([invocation(0), invocation(0, receipt), invocation(0)]);
  let reads = 0;
  h.deps.client.getEgressAllowlist = async () => ({
    type: "egress_allowlist",
    updatedAt: "2026-09-23T00:00:00Z",
    egressAllowlist: ++reads < 3 ? ["shop.example.com"] : [],
  });
  const result = await executeBrowserCliWorkflow(
    {
      expectedOrigin: origin,
      steps: [
        { action: "click", locator: "#submit" },
        { action: "click", locator: "#again" },
      ],
    },
    context,
    h.deps,
  );
  expect(result.ok).toBe(false);
  expect(result.text).toContain("Egress permission changed before step 2");
  expect(h.calls.filter((args) => args.includes("run-code"))).toHaveLength(1);
});
