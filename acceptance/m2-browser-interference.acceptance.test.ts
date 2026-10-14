// T3 calibration: compare the same two implemented dashboard reads alone and concurrently.
// This is a repeatable read-only proxy for ADR-0004's B2 interference metric. It deliberately
// does not call itself X02/X03: those benchmark cases need ticket/report writes that the current
// golden site does not yet implement.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotDefinition, type RunEvent, type Thread, botHomeDir } from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCanonicalSoul } from "./support/canonical-soul.js";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import {
  type RunView,
  answerOf,
  getRun,
  normaliseAnswer,
  postMessage,
  runEvents,
  toolNameOf,
  waitForRun,
} from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const skip = missing.length > 0 || !(await dockerAvailable());
const repetitions = Number(process.env.M2_INTERFERENCE_REPETITIONS ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error("M2_INTERFERENCE_REPETITIONS must be an integer between 1 and 20");
}
const output = process.env.M2_INTERFERENCE_REPORT_DIR;
const RUN_TIMEOUT_MS = 210_000;
const READER_SOUL = [
  "# Dashboard reader",
  "Use only browser_navigate and browser_snapshot to read the requested dashboard metric.",
  "The operator has already logged in. Do not log in or out, modify data, use shell, or send messages.",
  "If a tool is blocked or fails, report it and stop.",
  'Return the required JSON run summary with reply exactly "answer: <value>".',
  "Do not put the summary in a file.",
].join("\n");

interface Task {
  id: "dashboard-open-tickets" | "dashboard-month-revenue";
  label: string;
  expected: string;
}

interface RunEvidence {
  mode: "solo" | "concurrent";
  taskId: Task["id"];
  expected: string;
  run: RunView;
  events: RunEvent[];
  reply?: string;
  answer?: string;
  answerLinePresent: boolean;
  parsedAnswerPassed: boolean;
  formatPassed: boolean;
  terminalPassed: boolean;
  toolErrorCount: number;
  unexpectedToolNames: string[];
  tabIds: string[];
  screenshotCount: number;
  misattributedScreenshotCount: number;
  runtimePassed: boolean;
  protocolPassed: boolean;
  strictPassed: boolean;
  latencyMs?: number;
  waitError?: string;
}

interface RepetitionEvidence {
  repetition: number;
  startedAt: string;
  finishedAt: string;
  overlapMs: number | null;
  phaseOrder: ["solo" | "concurrent", "solo" | "concurrent"];
  concurrentTargetsSeparate: boolean;
  tabCleanup: { before: number; after: number }[];
  diaryResetCount: number;
  stateInvariantChecks: boolean[];
  solo: RunEvidence[];
  concurrent: RunEvidence[];
  strictInterference: boolean[];
  parsedAnswerInterference: boolean[];
  runtimeInterference: boolean[];
  matrixAborted?: boolean;
  infrastructureError?: string;
}

const evidence: RepetitionEvidence[] = [];

class MatrixAbortError extends Error {}

function intervalMs(run: RunView): number | undefined {
  if (!run.startedAt || !run.finishedAt) return undefined;
  const value = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function inspectRun(
  mode: RunEvidence["mode"],
  task: Task,
  run: RunView,
  events: RunEvent[],
): RunEvidence {
  const reply = run.summary?.reply;
  const answer = answerOf(reply);
  const toolResults = events.filter((event) => event.kind === "tool_result");
  const toolErrorCount = toolResults.filter((event) => event.payload.isError === true).length;
  const unexpectedToolNames = events
    .filter((event) => event.kind === "tool_call")
    .map(toolNameOf)
    .filter((name) => name !== "browser_navigate" && name !== "browser_snapshot");
  const tabIds = [
    ...new Set(
      events
        .filter((event) => event.payload.source === "browser_lock")
        .map((event) => event.payload.tabId)
        .filter((tabId): tabId is string => typeof tabId === "string" && tabId.length > 0),
    ),
  ];
  const screenshots = events.filter((event) => event.kind === "screenshot");
  const ownedTab = tabIds.length === 1 ? tabIds[0] : undefined;
  const misattributedScreenshotCount = screenshots.filter(
    (event) => ownedTab === undefined || event.payload.tabId !== ownedTab,
  ).length;
  const parsedAnswerPassed =
    answer !== undefined && normaliseAnswer(answer) === normaliseAnswer(task.expected);
  // Benchmark section 5 requires one final `answer: <value>` line. Keep exact formatting separate
  // from parsed-answer correctness so formatting remains a visible hard failure.
  const formatPassed = reply !== undefined && /^answer: \S(?:.*\S)?$/.test(reply);
  const terminalPassed = run.status === "succeeded";
  const runtimePassed =
    terminalPassed &&
    toolResults.length > 0 &&
    toolErrorCount === 0 &&
    tabIds.length === 1 &&
    screenshots.length > 0 &&
    misattributedScreenshotCount === 0;
  const latencyMs = intervalMs(run);
  return {
    mode,
    taskId: task.id,
    expected: task.expected,
    run,
    events,
    ...(reply === undefined ? {} : { reply }),
    ...(answer === undefined ? {} : { answer }),
    answerLinePresent: answer !== undefined,
    parsedAnswerPassed,
    formatPassed,
    terminalPassed,
    toolErrorCount,
    unexpectedToolNames,
    tabIds,
    screenshotCount: screenshots.length,
    misattributedScreenshotCount,
    runtimePassed,
    protocolPassed: unexpectedToolNames.length === 0,
    strictPassed:
      runtimePassed && unexpectedToolNames.length === 0 && parsedAnswerPassed && formatPassed,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

function overlapMs(runs: readonly RunEvidence[]): number | null {
  const starts = runs.map((item) => item.run.startedAt && Date.parse(item.run.startedAt));
  const finishes = runs.map((item) => item.run.finishedAt && Date.parse(item.run.finishedAt));
  if (
    starts.some((value) => typeof value !== "number") ||
    finishes.some((value) => typeof value !== "number")
  ) {
    return null;
  }
  return Math.min(...(finishes as number[])) - Math.max(...(starts as number[]));
}

describe.skipIf(skip)("M2 browser interference (paired solo/concurrent, configured model)", () => {
  let stack: Stack;
  let bots: BotDefinition[];
  let baselineState: string;

  const clearTestTabs = async (): Promise<{ before: number; after: number }> => {
    const result = await stack.provider.exec(stack.handle, {
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        "import { chromium } from '/opt/deskmates/node_modules/playwright/index.mjs'; const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'); const context=browser.contexts()[0]; const oldPages=context.pages(); const sentinel=await context.newPage(); await sentinel.goto('about:blank'); await Promise.all(oldPages.map((page)=>page.close())); const out={before:oldPages.length,after:context.pages().length}; await browser.close(); console.log(JSON.stringify(out));",
      ],
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) throw new Error(`clear test tabs: ${result.stderr}`);
    const lastLine = result.stdout.trim().split("\n").at(-1);
    const parsed: unknown = JSON.parse(lastLine ?? "");
    if (!parsed || typeof parsed !== "object")
      throw new Error("clear test tabs returned no counts");
    const before = (parsed as Record<string, unknown>).before;
    const after = (parsed as Record<string, unknown>).after;
    if (typeof before !== "number" || typeof after !== "number") {
      throw new Error(`clear test tabs returned invalid counts: ${lastLine}`);
    }
    if (after !== 1) throw new Error(`clear test tabs left ${after} pages instead of one sentinel`);
    return { before, after };
  };

  const createThread = async (bot: BotDefinition, title: string): Promise<Thread> => {
    const response = await stack.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: stack.workspace.id,
      botIds: [bot.id],
      title,
    });
    if (response.status !== 201) {
      throw new Error(`create thread: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return response.json.thread;
  };

  const clearBotDiaries = async (selected: readonly BotDefinition[]): Promise<void> => {
    // These homes belong only to the two bots created by this isolated test stack. Removing their
    // generated diary directories restores identical context input without touching SOUL.md,
    // another bot, another workspace, or the shared browser profile.
    const paths = selected.map((bot) => `${botHomeDir(bot.name)}/memory`);
    const result = await stack.provider.exec(stack.handle, {
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        "import { rmSync } from 'node:fs'; for (const path of JSON.parse(process.argv[1])) rmSync(path,{recursive:true,force:true});",
        JSON.stringify(paths),
      ],
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) throw new Error(`clear bot diaries: ${result.stderr}`);
  };

  beforeAll(async () => {
    stack = await startStack({ ...modelEnv(), label: "m2-browser-interference" });
    stack.config.maxTurns = 6;
    stack.config.runTimeoutSeconds = 180;

    const session = stack.site.state.login(OPS_ACCOUNT, PASSWORD);
    expect(session).toBeDefined();
    // Site 1.2.0 provides the canonical distinct KPI values itself. Preserve the seed instead of
    // adding an order to change a revenue KPI that now correctly comes from the monthly report.
    const kpis = stack.site.state.kpis();
    expect(kpis.openTickets).toBe(23);
    expect(kpis.monthRevenue).toBe(128450);
    baselineState = JSON.stringify(stack.site.state.view());
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

    bots = [];
    for (const suffix of ["a", "b"]) {
      const name = `interference_reader_${suffix}`;
      const created = await stack.api<{ bot: BotDefinition }>("POST", "/api/bots", {
        name,
        role: "browser reader",
        workspaceId: stack.workspace.id,
      });
      if (created.status !== 201) {
        throw new Error(`create bot: ${created.status} ${JSON.stringify(created.json)}`);
      }
      const bot = created.json.bot;
      const wrote = await stack.provider.exec(stack.handle, {
        cmd: [
          "/bin/sh",
          "-c",
          'mkdir -p "$(dirname "$0")" && cat > "$0"',
          `${botHomeDir(name)}/SOUL.md`,
        ],
        stdin: READER_SOUL,
        timeoutMs: 10_000,
      });
      expect(wrote.exitCode, wrote.stderr).toBe(0);
      await setCanonicalSoul(stack.api, bot.id, READER_SOUL, name);
      bots.push(bot);
    }
  }, 120_000);

  afterAll(async () => {
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "interference-results.json"), JSON.stringify(evidence, null, 2));
    }
    if (stack) await stopStack(stack);
  }, 120_000);

  it(
    `measures ${repetitions} paired repetitions without dropping failure evidence`,
    async () => {
      for (let index = 0; index < repetitions; index++) {
        const tasks: Task[] = [
          {
            id: "dashboard-open-tickets",
            label: "Open tickets",
            expected: String(stack.site.state.kpis().openTickets),
          },
          {
            id: "dashboard-month-revenue",
            label: "This month's revenue",
            expected: stack.site.state.kpis().monthRevenue.toFixed(2),
          },
        ];
        const startedAt = new Date().toISOString();
        const row: RepetitionEvidence = {
          repetition: index + 1,
          startedAt,
          finishedAt: startedAt,
          overlapMs: null,
          phaseOrder: index % 2 === 0 ? ["solo", "concurrent"] : ["concurrent", "solo"],
          concurrentTargetsSeparate: false,
          tabCleanup: [],
          diaryResetCount: 0,
          stateInvariantChecks: [],
          solo: [],
          concurrent: [],
          strictInterference: [],
          parsedAnswerInterference: [],
          runtimeInterference: [],
        };
        evidence.push(row);

        try {
          const execute = async (
            mode: RunEvidence["mode"],
            task: Task,
            taskIndex: number,
          ): Promise<RunEvidence> => {
            const bot = bots[taskIndex];
            if (!bot) throw new Error(`missing bot ${taskIndex}`);
            // The title is deliberately identical in both arms: thread metadata is rendered into
            // the model prompt, so an arm-specific title would make the contexts differ.
            const thread = await createThread(bot, "dashboard metric read");
            const prompt = `Open ${stack.siteOriginForBot}/dashboard?interference=${task.id} and read the exact value of "${task.label}". Return answer: <value>.`;
            const { run } = await postMessage(stack, prompt, thread.id);
            let finished: RunView;
            let waitError: string | undefined;
            try {
              finished = await waitForRun(stack, run.id, RUN_TIMEOUT_MS);
            } catch (error) {
              // Keep the last run row and ledger even when the wait itself fails; these are the
              // evidence needed to tell a model/tool failure from a harness failure.
              finished = (await getRun(stack, run.id)).run;
              waitError = error instanceof Error ? (error.stack ?? error.message) : String(error);
            }
            const inspected = inspectRun(mode, task, finished, await runEvents(stack, run.id));
            return waitError === undefined ? inspected : { ...inspected, waitError };
          };

          // The same bots, model, SOUL and task prompts are used in both modes. Fresh threads keep
          // SDK sessions independent while avoiding a strategy change between A and B. Mode order
          // alternates by repetition, and old run tabs are closed between phases so later runs do
          // not pay an ever-growing CDP page-enumeration cost. Cookies remain in the shared profile.
          for (const mode of row.phaseOrder) {
            row.tabCleanup.push(await clearTestTabs());
            if (mode === "solo") {
              for (const [taskIndex, task] of tasks.entries()) {
                const bot = bots[taskIndex];
                if (!bot) throw new Error(`missing bot ${taskIndex}`);
                await clearBotDiaries([bot]);
                row.diaryResetCount += 1;
                row.solo[taskIndex] = await execute("solo", task, taskIndex);
                if (row.solo[taskIndex]?.waitError) {
                  throw new MatrixAbortError(
                    `aborting matrix after solo wait failure; run may still be active: ${row.solo[taskIndex].waitError}`,
                  );
                }
                const stateUnchanged = JSON.stringify(stack.site.state.view()) === baselineState;
                row.stateInvariantChecks.push(stateUnchanged);
                if (!stateUnchanged) {
                  throw new MatrixAbortError(
                    "golden-site state changed during a read-only solo run",
                  );
                }
                // Each solo baseline starts with the same page count. Otherwise the second solo
                // task would pay to enumerate the first task's retained tab.
                row.tabCleanup.push(await clearTestTabs());
              }
            } else {
              await clearBotDiaries(bots);
              row.diaryResetCount += bots.length;
              row.concurrent = await Promise.all(
                tasks.map((task, taskIndex) => execute("concurrent", task, taskIndex)),
              );
              const waitFailure = row.concurrent.find((item) => item.waitError);
              if (waitFailure?.waitError) {
                throw new MatrixAbortError(
                  `aborting matrix after concurrent wait failure; run may still be active: ${waitFailure.waitError}`,
                );
              }
            }
            if (mode === "concurrent") {
              const stateUnchanged = JSON.stringify(stack.site.state.view()) === baselineState;
              row.stateInvariantChecks.push(stateUnchanged);
              if (!stateUnchanged) {
                throw new MatrixAbortError(
                  "golden-site state changed during a read-only concurrent phase",
                );
              }
            }
          }
          row.tabCleanup.push(await clearTestTabs());
          row.overlapMs = overlapMs(row.concurrent);
          const concurrentTargets = row.concurrent.flatMap((item) => item.tabIds);
          row.concurrentTargetsSeparate =
            row.concurrent.every((item) => item.tabIds.length === 1) &&
            new Set(concurrentTargets).size === row.concurrent.length;
          row.strictInterference = tasks.map(
            (_task, taskIndex) =>
              row.solo[taskIndex]?.strictPassed === true &&
              row.concurrent[taskIndex]?.strictPassed !== true,
          );
          row.parsedAnswerInterference = tasks.map(
            (_task, taskIndex) =>
              row.solo[taskIndex]?.parsedAnswerPassed === true &&
              row.concurrent[taskIndex]?.parsedAnswerPassed !== true,
          );
          row.runtimeInterference = tasks.map(
            (_task, taskIndex) =>
              row.solo[taskIndex]?.runtimePassed === true &&
              row.concurrent[taskIndex]?.runtimePassed !== true,
          );
        } catch (error) {
          // Any thrown error here is harness/infrastructure failure rather than a measured oracle
          // result. Stop the matrix so a damaged browser/container cannot contaminate later pairs.
          row.matrixAborted = true;
          row.infrastructureError =
            error instanceof Error ? (error.stack ?? error.message) : String(error);
        } finally {
          row.finishedAt = new Date().toISOString();
          console.log(
            `[m2-browser-interference] repetition ${index + 1}/${repetitions}: solo=${row.solo.filter((item) => item.strictPassed).length}/2 concurrent=${row.concurrent.filter((item) => item.strictPassed).length}/2 overlap=${String(row.overlapMs)}ms`,
          );
        }
        if (row.matrixAborted) break;
      }

      // A failed repetition stays in the evidence file. These assertions run only after the full
      // matrix, so one bad model answer cannot erase the remaining paired observations.
      expect(
        evidence.filter((row) => row.infrastructureError).map((row) => row.infrastructureError),
      ).toEqual([]);
      expect(evidence.flatMap((row) => row.solo).every((item) => item.strictPassed)).toBe(true);
      expect(evidence.every((row) => row.concurrentTargetsSeparate)).toBe(true);
      expect(evidence.every((row) => row.diaryResetCount === 4)).toBe(true);
      expect(evidence.every((row) => row.stateInvariantChecks.length === 3)).toBe(true);
      expect(evidence.flatMap((row) => row.stateInvariantChecks).every(Boolean)).toBe(true);
      expect(evidence.every((row) => row.overlapMs !== null && row.overlapMs > 0)).toBe(true);
      const observations = evidence.flatMap((row) => row.strictInterference);
      // With only two targets at K=5, zero observed failures is a useful acceptance gate but not
      // statistical evidence that the true rate is <=5%; the generated report says so explicitly.
      expect(observations.filter(Boolean), "concurrent-only strict oracle failures").toEqual([]);
    },
    repetitions * 4 * RUN_TIMEOUT_MS + 120_000,
  );
});
