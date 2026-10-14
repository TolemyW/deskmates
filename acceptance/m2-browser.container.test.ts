// T2: separate run tabs in one Chromium, stable IDs, shared cookies, contention and takeover.
import { readFileSync } from "node:fs";
import type { BotDefinition, Thread } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, takeOver } from "./support/takeover.js";

const available = await dockerAvailable();
describe.skipIf(!available)("M2 browser runtime (real Docker/MCP/SDK, scripted upstream)", () => {
  let stack: Stack;
  let upstream: FakeModelUpstream;
  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: "m2-browser-fake",
      reply: "done",
      script: (_turn, body) => {
        const messages = JSON.stringify(body?.messages ?? []);
        if (JSON.stringify(body?.tools).includes("mcp__browser__browser_navigate")) {
          if (!messages.includes('"tool_result"'))
            return {
              kind: "tool_use",
              name: "mcp__browser__browser_navigate",
              input: { url: `${stack.siteOriginForBot}/login` },
            };
          if (!messages.includes('"name":"mcp__browser__browser_snapshot"'))
            return { kind: "tool_use", name: "mcp__browser__browser_snapshot", input: {} };
        }
        return { kind: "text", text: assistantText("done") };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: "m2-browser-fake",
      defaultModel: "fake-model",
      cheapModel: "fake-cheap",
      label: "m2-browser",
    });
  }, 120_000);
  afterAll(async () => {
    await stopStack(stack);
    await upstream?.close();
  }, 120_000);

  it("coordinates real MCP connections, preserves shared login state and restores selected targets", async () => {
    const ctx = stack.app.deskmates.ctx;
    const runs = ["a", "b"].map((label) => {
      const run = ctx.runs.create({
        botId: stack.bot.id,
        lane: label === "a" ? "interactive" : "background",
        triggerKind: "thread_message",
        triggerRef: label,
      });
      ctx.runs.transition(run.id, "running");
      return {
        runId: run.id,
        token: ctx.tokens.issue(run.id).token,
        gatewayBaseUrl: stack.config.gatewayBaseUrl,
        statePath: `/tmp/m2-browser-${run.id}.json`,
      };
    });
    // The container publishes phase files only. The host makes authenticated operator calls,
    // then acknowledges each phase, so the operator token never enters the workspace.
    const controlPath = `/tmp/m2-browser-control-${runs[0]?.runId}`;
    let driverFinished = false;
    const waitForPhase = async (phase: "takeover" | "handback") => {
      const path = `${controlPath}-${phase}-ready`;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const found = await stack.provider.exec(stack.handle, {
          cmd: ["/bin/sh", "-c", 'test -f "$1"', "phase-check", path],
          timeoutMs: 5_000,
        });
        if (found.exitCode === 0) return;
        if (driverFinished) throw new Error(`browser driver ended before ${phase}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`browser driver did not request ${phase}`);
    };
    const signalPhase = async (phase: "takeover" | "handback") => {
      const signalled = await stack.provider.exec(stack.handle, {
        cmd: ["touch", `${controlPath}-${phase}-done`],
        timeoutMs: 5_000,
      });
      if (signalled.exitCode !== 0) {
        throw new Error(`signal ${phase}: ${signalled.stderr || signalled.stdout}`);
      }
    };
    try {
      const script = readFileSync(
        new URL("../spikes/m2-browser/runtime.mjs", import.meta.url),
        "utf8",
      );
      const driver = stack.provider
        .exec(stack.handle, {
          cmd: ["node", "--input-type=module", "-e", script],
          stdin: JSON.stringify({
            runs,
            site: stack.siteOriginForBot,
            controlPath,
          }),
          timeoutMs: 120_000,
        })
        .finally(() => {
          driverFinished = true;
        });
      const hostControl = async () => {
        await waitForPhase("takeover");
        await takeOver(stack);
        await signalPhase("takeover");
        await waitForPhase("handback");
        await handBack(stack);
        await signalPhase("handback");
      };
      const [driverOutcome, controlOutcome] = await Promise.allSettled([driver, hostControl()]);
      if (controlOutcome.status === "rejected") throw controlOutcome.reason;
      if (driverOutcome.status === "rejected") throw driverOutcome.reason;
      const result = driverOutcome.value;
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const evidence = JSON.parse(result.stdout) as {
        passed: boolean;
        clickRounds: number;
        ordinaryClickCalls: number;
        counters: number[];
        clickCaptures: number[];
      };
      expect(evidence.passed).toBe(true);
      expect(evidence.clickRounds).toBe(8);
      expect(evidence.ordinaryClickCalls).toBe(16);
      expect(evidence.counters).toEqual([8, 8]);
      expect(evidence.clickCaptures).toEqual([8, 8]);
      console.log(result.stdout.trim());
    } finally {
      if (ctx.locks.humanHolds(stack.workspace.id)) await handBack(stack);
      for (const run of runs) {
        ctx.locks.releaseForRun(run.runId);
        ctx.tokens.revokeForRun(run.runId);
        ctx.runs.transition(run.runId, "cancelled");
      }
    }
  }, 150_000);

  it("handles a real client pipe disconnect and reaps its child MCP without an uncaught error", async () => {
    const result = await stack.provider.exec(stack.handle, {
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const server = "process.stdout.write('READY:' + process.pid + String.fromCharCode(10)); setInterval(() => process.stdout.write('RESULT' + String.fromCharCode(10)), 50); process.stdin.resume();";
const proxy = spawn('deskmates-sidecar', ['mcp-proxy', '--', 'node', '-e', server], {
  stdio: ['pipe', 'pipe', 'pipe']
});
let stderr = '', childPid;
proxy.stderr.on('data', chunk => stderr += chunk);
proxy.stdout.once('data', chunk => {
  childPid = Number(String(chunk).match(/READY:(\\d+)/)?.[1]);
  proxy.stdout.destroy();
});
const timeout = setTimeout(() => proxy.kill('SIGTERM'), 10000);
try {
  const code = await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.once('exit', resolve);
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /mcp-proxy: stdio connection closed/);
  assert.doesNotMatch(stderr, /Unhandled|write EPIPE/);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  console.log(JSON.stringify({ passed: true, disconnected: true, childReaped: true }));
} finally {
  clearTimeout(timeout);
  proxy.kill('SIGTERM');
  proxy.stdin.destroy();
}
`,
      ],
      timeoutMs: 15_000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      passed: true,
      disconnected: true,
      childReaped: true,
    });
  }, 30_000);

  it("carries stable IDs through real SDK hooks and ledger for two concurrent bots", async () => {
    const created = await stack.api<{
      bot: BotDefinition;
      privateChat: Thread;
      welcomeRun: { id: string };
    }>("POST", "/api/bots", {
      name: "browser-peer",
      role: "test",
      workspaceId: stack.workspace.id,
    });
    stack.app.deskmates.scheduler.cancel(
      created.json.welcomeRun.id as import("@deskmates/contracts").RunId,
      "test",
    );
    await stack.app.deskmates.scheduler.drain();
    const starts = await Promise.all([
      postMessage(stack, "Read login page"),
      postMessage(stack, "Read login page", created.json.privateChat.id),
    ]);
    const finished = await Promise.all(starts.map(({ run }) => waitForRun(stack, run.id, 120_000)));
    expect(finished.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    const events = await Promise.all(starts.map(({ run }) => runEvents(stack, run.id)));
    const targets = events.map(
      (list) =>
        list.find((e) => e.kind === "log" && e.payload.source === "browser_lock")?.payload.tabId,
    );
    expect(targets.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(targets).size).toBe(2);
    for (const list of events) {
      expect(
        list.filter((e) => e.kind === "tool_result").every((e) => e.payload.isError !== true),
      ).toBe(true);
      expect(list.some((e) => e.kind === "screenshot" && typeof e.payload.tabId === "string")).toBe(
        true,
      );
      const timing = list.filter((event) => event.payload.source === "phase_timing");
      for (const phase of ["model_request", "browser_rpc", "browser_capture_rpc"]) {
        const end = timing.find(
          (event) => event.payload.phase === phase && event.payload.edge === "end",
        );
        expect(end, `missing completed ${phase} observation`).toBeDefined();
        expect(end?.payload.durationMs).toEqual(expect.any(Number));
        expect(end?.payload.outcome).toBe("ok");
        expect(end?.attempt).toBe(1);
        expect(end?.sidecarSeq).toBeUndefined();
        expect(
          timing.some(
            (event) =>
              event.payload.spanId === end?.payload.spanId && event.payload.edge === "start",
          ),
        ).toBe(true);
      }
    }
    expect(upstream.requests.some((request) => request.rawBody.includes('"phase_timing"'))).toBe(
      false,
    );
    expect(stack.app.deskmates.ctx.locks.list(stack.workspace.id)).toEqual([]);
  }, 150_000);
});
