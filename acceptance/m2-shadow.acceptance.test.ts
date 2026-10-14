// T3: S09 and S10 use visible browser pixels. Baseline-v1 can pass by requesting its own
// screenshot; the opt-in automatic two-miss fallback is measured separately by its T2 contract.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE } from "@deskmates/golden-site";
import { afterAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import {
  answerOf,
  getRun,
  postMessage,
  runEvents,
  toolNameOf,
  waitForRun,
} from "./support/runs.js";
import { siteLog, siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";

const skip = missingModelEnv().length > 0 || !(await dockerAvailable());
const image = process.env.WORKSPACE_IMAGE ?? "";
const output = resolve(process.env.M2_SHADOW_REPORT_DIR ?? "spikes/m2-closeout/work-vision");
const evidence: Record<string, unknown>[] = [];
const diagnostic = "[Deskmates host diagnostic] Two matching target lookups failed";

const cases = [
  {
    id: "S09",
    path: "/shadow",
    prompt: "Open the /shadow page and click its Approve button.",
    allowed: ["shadow"],
  },
  {
    id: "S10",
    path: "/canvas",
    prompt:
      "Open the /canvas page, click the Refresh button drawn on the chart, and report the number shown after refresh. Give the answer on the last line as answer: <value>.",
    allowed: ["canvas"],
  },
] as const;

async function seedOperatorLogin(stack: Stack): Promise<void> {
  // Authentication fixture only; it neither reads an answer nor performs the requested action.
  const session = stack.site.state.login(OPS_ACCOUNT, PASSWORD);
  expect(session).toBeDefined();
  const seeded = await stack.provider.exec(stack.handle, {
    cmd: [
      "node",
      "--input-type=module",
      "-e",
      `import { chromium } from '/opt/deskmates/node_modules/playwright/index.mjs'; const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'); await browser.contexts()[0].addCookies([{name:${JSON.stringify(SESSION_COOKIE)},value:${JSON.stringify(session?.id)},url:${JSON.stringify(stack.siteOriginForBot)}}]); await browser.close();`,
    ],
    timeoutMs: 20_000,
  });
  expect(seeded.exitCode, seeded.stderr).toBe(0);
}

describe.skipIf(skip)("M2 S09/S10 visual browser tasks (configured model)", () => {
  afterAll(() => {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "m2-shadow-results.json"), JSON.stringify(evidence, null, 2));
  });

  for (const scenario of cases) {
    it(scenario.id, async () => {
      requireWorkspaceImageId();
      let stack: Stack | undefined;
      let runId: string | undefined;
      const row: Record<string, unknown> = {
        scenario: scenario.id,
        image,
        browserExecutionMode: "baseline-v1",
        model: modelEnv().defaultModel,
        startedAt: new Date().toISOString(),
      };
      evidence.push(row);
      try {
        stack = await startStack({
          ...modelEnv(),
          label: `m2-vision-${scenario.id.toLowerCase()}`,
          soul: "You operate Galaxy Ops Console using visible browser controls only. The operator has already logged in. Use browser screenshots and coordinate clicks when a control is not in the accessibility tree. Do not use shell, JavaScript evaluation, browser CLI scripts, DOM inspection, or HTTP/state APIs to learn an answer or make a change. Do only the requested action; report a blocked action instead of working around it. For a numeric answer, use the required answer: <value> line.",
        });
        stack.config.maxTurns = 20;
        stack.config.runTimeoutSeconds = 300;
        await seedOperatorLogin(stack);
        const before = await siteState(stack);
        const { run: started } = await postMessage(
          stack,
          `Open ${stack.siteOriginForBot}${scenario.path}. ${scenario.prompt}`,
        );
        runId = started.id;
        row.runId = runId;
        const run = await waitForRun(stack, started.id, 330_000);
        const events = await runEvents(stack, started.id);
        const after = await siteState(stack);
        const log = await siteLog(stack);
        const names = events.filter((event) => event.kind === "tool_call").map(toolNameOf);
        const calls = events.filter((event) => event.kind === "tool_call");
        const fallbackCount = events.filter(
          (event) =>
            event.kind === "tool_result" && JSON.stringify(event.payload).includes(diagnostic),
        ).length;
        const screenshotCount = events.filter((event) => event.kind === "screenshot").length;
        const coordinateClicks = names.filter((name) => name === "browser_mouse_click_xy").length;
        const firstCoordinateClick = calls.find(
          (event) => toolNameOf(event) === "browser_mouse_click_xy",
        );
        // The ledger intentionally strips image bytes from tool_result. A matched successful
        // screenshot tool result before the click is the observable proof that the model received
        // the browser's screenshot response, not just an automatic capture retained by the host.
        const successfulScreenshotCalls = calls.filter((call) => {
          if (toolNameOf(call) !== "browser_take_screenshot") return false;
          const result = events.find(
            (event) =>
              event.kind === "tool_result" &&
              event.payload.toolUseId === call.payload.toolUseId &&
              event.seq > call.seq &&
              event.seq < (firstCoordinateClick?.seq ?? Number.POSITIVE_INFINITY),
          );
          return result !== undefined && result.payload.isError !== true;
        });
        Object.assign(row, {
          run,
          before,
          after,
          log,
          events,
          browserTools: names,
          screenshotCount,
          successfulScreenshotToolResults: successfulScreenshotCalls.length,
          coordinateClicks,
          fallbackCount,
          visualTaskPassed: false,
          automaticFallbackObserved: fallbackCount > 0,
        });

        expect(run.status).toBe("succeeded");
        expect(names).not.toContain("browser_run_code_unsafe");
        expect(names).not.toContain("browser_evaluate");
        expect(names).not.toContain("browser_cli_workflow");
        expect(names.some((name) => /^(Bash|Shell|Read|WebFetch|WebSearch)$/.test(name))).toBe(
          false,
        );
        expect(
          calls.some((event) =>
            /\/api\/state|\/canvas\/value|\/shadow\/approve/.test(
              JSON.stringify(event.payload.input),
            ),
          ),
        ).toBe(false);
        expect(screenshotCount).toBeGreaterThan(0);
        expect(successfulScreenshotCalls.length).toBeGreaterThan(0);
        expect(coordinateClicks).toBeGreaterThan(0);
        expect(unexpectedChanges(before, after, scenario.allowed)).toEqual([]);
        if (scenario.id === "S09") {
          expect(before.shadow.approved).toBe(false);
          expect(after.shadow.approved).toBe(true);
          expect(log.filter((entry) => entry.op === "shadow_approve")).toHaveLength(1);
        } else {
          expect(before.canvas.number).toBe(41);
          expect(after.canvas.number).toBe(42);
          expect(answerOf(run.summary?.reply)).toBe("42");
          expect(log.filter((entry) => entry.op === "canvas_refresh")).toHaveLength(1);
        }
        row.visualTaskPassed = true;
      } catch (error) {
        row.error = String(error);
        throw error;
      } finally {
        if (stack && runId) {
          try {
            row.finalLedger = await getRun(stack, runId);
            row.events ??= await runEvents(stack, runId);
            row.after ??= await siteState(stack);
            row.log ??= await siteLog(stack);
          } catch (error) {
            row.evidenceError = String(error);
          }
        }
        row.finishedAt = new Date().toISOString();
        await stopStack(stack);
      }
    }, 480_000);
  }
});
