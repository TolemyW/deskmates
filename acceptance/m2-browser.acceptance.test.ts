// T3 smoke: two real-model bots share one authenticated profile and read their own tabs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotDefinition, type Thread, botHomeDir } from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSmokeOracle,
  browserSmokeOracle,
  formatBrowserSmokeFailures,
} from "./support/browser-smoke-oracle.js";
import { setCanonicalSoul } from "./support/canonical-soul.js";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
const skip = missingModelEnv().length > 0 || !(await dockerAvailable());
const evidence: Record<string, unknown>[] = [];
const repetitions = Number(process.env.M2_REPETITIONS ?? 2);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
  throw new Error("Invalid M2_REPETITIONS");
const output = process.env.M2_REPORT_DIR;
describe.skipIf(skip)("M2 shared browser (configured model smoke)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ ...modelEnv(), label: "m2-browser-live" });
    stack.config.maxTurns = 6;
    stack.config.runTimeoutSeconds = 180;
    // Operator fixture logs in once; the bots receive no credentials and must reuse this profile.
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
  }, 120_000);
  afterAll(async () => {
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "browser-results.json"), JSON.stringify(evidence, null, 2));
    }
    await stopStack(stack);
  }, 120_000);
  for (let index = 0; index < repetitions; index++)
    it(`reads two metrics concurrently from a shared login, repetition ${index + 1}`, async () => {
      const threads: Thread[] = [];
      const started = Date.now();
      const tasks = [
        {
          label: "tickets",
          question: "Open tickets",
          value: String(stack.site.state.kpis().openTickets),
        },
        {
          label: "revenue",
          question: "This month's revenue",
          value: stack.site.state.kpis().monthRevenue.toFixed(2),
        },
      ];
      for (const task of tasks) {
        const name = `reader_${task.label}_${index}`;
        const bot = await stack.api<{ bot: BotDefinition }>("POST", "/api/bots", {
          name,
          role: "browser reader",
          workspaceId: stack.workspace.id,
        });
        const soul = `# ${name}\nUse only browser_navigate and browser_snapshot to read the requested dashboard metric. The operator has already logged in. Do not log in or out, modify data, use shell, or send messages to other bots. If a tool is blocked, report it and stop. Return the required JSON summary with reply exactly "answer: <value>". Do not put the summary in a file.`;
        const wrote = await stack.provider.exec(stack.handle, {
          cmd: [
            "/bin/sh",
            "-c",
            'mkdir -p "$(dirname "$0")" && cat > "$0"',
            `${botHomeDir(name)}/SOUL.md`,
          ],
          stdin: soul,
          timeoutMs: 10_000,
        });
        expect(wrote.exitCode).toBe(0);
        await setCanonicalSoul(stack.api, bot.json.bot.id, soul, name);
        const thread = await stack.api<{ thread: Thread }>("POST", "/api/threads", {
          workspaceId: stack.workspace.id,
          botIds: [bot.json.bot.id],
        });
        threads.push(thread.json.thread);
      }
      const starts = await Promise.all(
        tasks.map((task, i) =>
          postMessage(
            stack,
            `Open ${stack.siteOriginForBot}/dashboard?reader=${task.label} and read the exact value of "${task.question}". Return answer: <value>.`,
            threads[i]?.id,
          ),
        ),
      );
      let failure: unknown;
      let oracle: BrowserSmokeOracle | undefined;
      try {
        const runs = await Promise.all(starts.map(({ run }) => waitForRun(stack, run.id, 210_000)));
        const events = await Promise.all(starts.map(({ run }) => runEvents(stack, run.id)));
        oracle = browserSmokeOracle(
          tasks.map((task) => ({ label: task.label, expectedReply: `answer: ${task.value}` })),
          runs,
          events,
          stack.site.state.view().session.active_sessions,
        );
        expect(oracle.failures, formatBrowserSmokeFailures(oracle)).toEqual([]);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const ctx = stack.app.deskmates.ctx;
        evidence.push({
          repetition: index + 1,
          passed: failure === undefined,
          ...(failure ? { error: String(failure) } : {}),
          ...(oracle ? { oracle } : {}),
          wallMs: Date.now() - started,
          model: modelEnv().defaultModel,
          runs: starts.map(({ run }) => ({
            run: ctx.runs.mustGet(run.id),
            events: ctx.events.list(run.id),
          })),
        });
        console.log(
          `[m2-browser-live] repetition ${index + 1}: ${failure ? "FAIL" : "PASS"}, ${Math.round((Date.now() - started) / 1000)}s`,
        );
      }
    }, 240_000);
});
