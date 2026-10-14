// T2: actual pinned Playwright CLI, exact run tab, Gateway fences and final screenshot. The
// container receives only short-lived run tokens, never the operator credential.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();

describe.skipIf(!available)("M2 governed native Playwright CLI (T2)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      modelBaseUrl: "http://127.0.0.1:9",
      modelAuthToken: "unused-t2-cli",
      defaultModel: "fake-model",
      cheapModel: "fake-cheap",
      label: "m2-cli",
    });
  }, 120_000);
  afterAll(async () => {
    if (stack) await stopStack(stack);
  }, 120_000);

  it("fills only its own tab, attributes the capture and leaves Chromium running after detach", async () => {
    const ctx = stack.app.deskmates.ctx;
    const runs = ["run", "peer"].map((label) => {
      const run = ctx.runs.create({
        botId: stack.bot.id,
        lane: label === "run" ? "interactive" : "background",
        triggerKind: "thread_message",
        triggerRef: `t2-cli-${label}`,
      });
      ctx.runs.transition(run.id, "running");
      return {
        runId: run.id,
        token: ctx.tokens.issue(run.id).token,
        gatewayBaseUrl: stack.config.gatewayBaseUrl,
        statePath: `/tmp/m2-cli-${run.id}.json`,
      };
    });
    try {
      const script = readFileSync(
        new URL("../spikes/m2-closeout/browser-cli-smoke.mjs", import.meta.url),
        "utf8",
      );
      const result = await stack.provider.exec(stack.handle, {
        cmd: ["node", "--input-type=module", "-e", script],
        stdin: JSON.stringify({ runs, site: stack.siteOriginForBot }),
        timeoutMs: 120_000,
      });
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const evidence = JSON.parse(result.stdout) as {
        passed: boolean;
        distinctTargets: boolean;
        exactRunFill: boolean;
        peerUnchanged: boolean;
        screenshotTabId: string;
        screenshotBytes: number;
        browserSurvivedDetach: boolean;
      };
      expect(evidence).toMatchObject({
        passed: true,
        distinctTargets: true,
        exactRunFill: true,
        peerUnchanged: true,
        browserSurvivedDetach: true,
      });
      expect(evidence.screenshotTabId).toMatch(/^[a-f0-9-]+$/i);
      expect(evidence.screenshotBytes).toBeGreaterThan(100);
    } finally {
      for (const run of runs) {
        ctx.locks.releaseForRun(run.runId);
        ctx.tokens.revokeForRun(run.runId);
        ctx.runs.transition(run.runId, "cancelled");
      }
    }
  }, 150_000);
});
