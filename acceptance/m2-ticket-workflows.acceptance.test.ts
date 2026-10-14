// Actual X02/X03 workflows on the implemented ticket site. One paired repetition validates
// implementation; ADR-0004 lock calibration still requires K=5 and an aggregate report.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BotDefinition,
  type BrowserCoordinationMode,
  type BrowserSnapshotMode,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  botHomeDir,
  isTerminal,
} from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE, type StateView } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completedTicketStatus, ticketOracle } from "./support/b3-calibration.js";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import {
  type M2Assessment,
  aggregateAssessments,
  assessTicketArm,
} from "./support/m2-assessment.js";
import { browserTabIds, createGroupBot, createGroupThread } from "./support/m2-group.js";
import {
  type TicketCompletionContractVersion,
  selectTicketCompletionContract,
  ticketCompletionContractEvidence,
  ticketPromptEvidence,
} from "./support/m2-ticket-completion-contract.js";
import { readTicketArm, ticketFailureDiagnostics } from "./support/m2-ticket-failure-evidence.js";
import { getRun, postMessage, runEvents, toolNameOf, waitForRun } from "./support/runs.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";

const skip = missingModelEnv().length > 0 || !(await dockerAvailable());
const output = process.env.M2_B3_REPORT_DIR;
const coordinationMode = (() => {
  const value = process.env.M2_BROWSER_COORDINATION_MODE?.trim() || "tab-v1";
  if (value !== "tab-v1" && value !== "origin-v2")
    throw new Error("M2_BROWSER_COORDINATION_MODE must be tab-v1 or origin-v2");
  return value satisfies BrowserCoordinationMode;
})();
const snapshotMode = (() => {
  const value = process.env.M2_BROWSER_SNAPSHOT_MODE?.trim() || "explicit-v1";
  if (value !== "explicit-v1" && value !== "inline-v2")
    throw new Error("M2_BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2");
  return value satisfies BrowserSnapshotMode;
})();
const completionContract = selectTicketCompletionContract(
  process.env.M2_TICKET_COMPLETION_CONTRACT,
);
const completionContractEvidence = ticketCompletionContractEvidence(completionContract);
const COMMENT = "Concurrent review verified";
const SOUL = `You operate the Galaxy Ops Console through browser tools only.
The operator has logged in. Do not log in again, use shell, read local files, or call HTTP APIs.
Perform only the requested ticket changes through the visible UI. A blocked or denied action
must be reported; do not work around it. Return the required JSON summary after verifying the change.`;

interface Task {
  prompt: string;
  paths: string[];
  verify(before: StateView, after: StateView): void;
}
const scenarios: { id: string; tasks: Task[] }[] = [
  {
    id: "X02",
    tasks: [
      {
        prompt:
          'Find the tickets whose comments mention "refund" and add the label refund to each.',
        paths: ["tickets.1015.tags", "tickets.1058.tags"],
        verify: (before, after) => {
          for (const id of ["1015", "1058"])
            expect(after.tickets[id]?.tags).toEqual([
              ...(before.tickets[id]?.tags ?? []),
              "refund",
            ]);
        },
      },
      {
        prompt: "Reassign all open tickets assigned to zhang to li.",
        paths: ["tickets.1012.assignee", "tickets.1024.assignee", "tickets.1036.assignee"],
        verify: (_before, after) => {
          for (const id of ["1012", "1024", "1036"]) expect(after.tickets[id]?.assignee).toBe("li");
        },
      },
    ],
  },
  {
    id: "X03",
    tasks: [
      {
        prompt: `Add the comment "${COMMENT}" to ticket 1050 once.`,
        paths: ["tickets.1050.comments"],
        verify: (before, after) =>
          expect(after.tickets["1050"]?.comments).toEqual([
            ...(before.tickets["1050"]?.comments ?? []),
            COMMENT,
          ]),
      },
      {
        prompt: "Reassign ticket 1050 to li.",
        paths: ["tickets.1050.assignee"],
        verify: (before, after) => {
          expect(before.tickets["1050"]?.assignee).toBe("wang");
          expect(after.tickets["1050"]?.assignee).toBe("li");
        },
      },
    ],
  },
];

describe.skipIf(skip)("M2 ticket workflows (paired solo/concurrent, configured model)", () => {
  let stack: Stack;
  const bots: BotDefinition[] = [];
  let promptHashes: Record<string, string>;
  let unsafeToReset = false;
  const evidence: unknown[] = [];
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      ...modelEnv(),
      label: "m2-tickets",
      browserCoordinationMode: coordinationMode,
    });
    stack.config.browserSnapshotMode = snapshotMode;
    stack.config.maxTurns = 35;
    stack.config.runTimeoutSeconds = 300;
    stack.config.strategyEvidence = {
      ticketCompletionContract: completionContractEvidence.version,
      ticketCompletionContractSha256: completionContractEvidence.contractSha256,
      ticketCompletionInstructionSha256: completionContractEvidence.instructionSha256,
      ticketSoulSha256: createHash("sha256").update(SOUL).digest("hex"),
      ...Object.fromEntries(
        scenarios.flatMap((scenario) =>
          scenario.tasks.map((task, index) => [
            `ticketPrompt${scenario.id}Task${index}Sha256`,
            ticketPromptEvidence(
              `Open ${stack.siteOriginForBot}/tickets. ${task.prompt}`,
              completionContract,
            ).sha256,
          ]),
        ),
      ),
    };
    promptHashes = { ...stack.config.strategyEvidence };
    for (const name of ["ticket_reader_a", "ticket_reader_b"]) {
      bots.push(await createGroupBot(stack, { name, role: "ticket operator", soul: SOUL }));
    }
  }, 120_000);
  afterAll(async () => {
    try {
      if (output) {
        mkdirSync(output, { recursive: true });
        writeFileSync(
          join(output, "ticket-workflows-results.json"),
          JSON.stringify(evidence, null, 2),
        );
      }
    } finally {
      await stopStack(stack);
    }
  }, 120_000);

  const reset = async () => {
    stack.site.state.reset();
    const session = stack.site.state.login(OPS_ACCOUNT, PASSWORD);
    if (!session) throw new Error("fixture login failed");
    // Keep one inert page alive: closing the last page exits headed Chromium.
    const code = `import {chromium} from '/opt/deskmates/node_modules/playwright/index.mjs';
      import {rmSync} from 'node:fs';
      const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
      const context=browser.contexts()[0]; const old=context.pages(); await context.newPage();
      await Promise.all(old.map(p=>p.close())); await context.clearCookies();
      await context.addCookies(${JSON.stringify([{ name: SESSION_COOKIE, value: session.id, url: stack.siteOriginForBot }])});
      for(const path of ${JSON.stringify(bots.map((bot) => `${botHomeDir(bot.name)}/memory`))}) rmSync(path,{recursive:true,force:true});
      await browser.close();`;
    const result = await stack.provider.exec(stack.handle, {
      cmd: ["node", "--input-type=module", "-e", code],
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) throw new Error(`reset fixture: ${result.stderr}`);
  };

  for (const scenario of scenarios)
    it(
      `${scenario.id}: keeps both writes and changes only requested fields`,
      async () => {
        const row: {
          id: string;
          passed: boolean;
          strictDiagnosticsPassed?: boolean;
          diagnosticFailures?: string[];
          assessment?: M2Assessment;
          error?: string;
          coordinationMode: BrowserCoordinationMode;
          snapshotMode: BrowserSnapshotMode;
          completionContract: TicketCompletionContractVersion;
          completionContractEvidence: typeof completionContractEvidence;
          arms: unknown[];
        } = {
          id: scenario.id,
          passed: false,
          coordinationMode,
          snapshotMode,
          completionContract,
          completionContractEvidence,
          arms: [],
        };
        evidence.push(row);
        try {
          if (unsafeToReset)
            throw new Error("Prior arm may still be active; refusing to reset its workspace");
          // Each solo task starts from exactly the same seed as the concurrent pair.
          const failures: string[] = [];
          const oracleFailures: string[] = [];
          for (const indices of [[0], [1], [0, 1]]) {
            await reset();
            const before = await siteState(stack);
            const starts = await Promise.all(
              indices.map(async (index) => {
                const bot = bots[index];
                const task = scenario.tasks[index];
                if (!bot || !task) throw new Error("missing ticket task");
                const thread = await createGroupThread(stack, [bot], "Ticket operation");
                const prompt = ticketPromptEvidence(
                  `Open ${stack.siteOriginForBot}/tickets. ${task.prompt}`,
                  completionContract,
                );
                const started = await postMessage(stack, prompt.text, thread.id);
                return { ...started, promptSha256: prompt.sha256 };
              }),
            );
            const arm: Record<string, unknown> = {
              indices,
              before,
              runIds: starts.map(({ run }) => run.id),
              promptSha256: starts.map((started) => started.promptSha256),
              configuredPromptHashes: promptHashes,
            };
            const transientReadErrors: {
              runId: string;
              attempt: number;
              observedAt: string;
              message: string;
              code?: string;
            }[] = [];
            arm.transientReadErrors = transientReadErrors;
            row.arms.push(arm);
            // Persist last-known rows on timeout; never reset underneath an active or parked run.
            unsafeToReset = true;
            const waited = await Promise.allSettled(
              starts.map(({ run }) =>
                waitForRun(stack, run.id, 330_000, {
                  onTransientReadError: (error) =>
                    transientReadErrors.push({
                      runId: run.id,
                      attempt: run.attempt,
                      observedAt: new Date().toISOString(),
                      ...error,
                    }),
                }),
              ),
            );
            const { runs, events, after } = await readTicketArm({
              waited,
              runIds: starts.map(({ run }) => run.id),
              arm,
              readRun: (id) => getRun(stack, id).then((value) => value.run),
              readEvents: (run) => runEvents(stack, run.id),
              readState: () => siteState(stack),
              diagnostics: () =>
                ticketFailureDiagnostics(
                  stack,
                  starts.map(({ run }) => run.id),
                ),
              secrets: [
                stack.config.modelAuthToken,
                stack.config.operatorToken,
                stack.config.secretsKey,
                PASSWORD,
              ],
            });
            const targets = events.map(browserTabIds);
            const originCoordinationEvents = events.map((list) =>
              list.filter(
                (event) => event.kind === "log" && event.payload.source === "browser_origin",
              ),
            );
            Object.assign(arm, { after, runs, events, targets, originCoordinationEvents });
            unsafeToReset = runs.some((run) => !isTerminal(run.status));
            // Only active/parked work prevents later arms. A terminal protocol failure must
            // remain a failure while allowing us to observe the other business scenarios.
            if (unsafeToReset) throw new Error("Arm still active/parked; refusing fixture reset");
            const checks: { name: string; passed: boolean; error?: string }[] = [];
            arm.checks = checks;
            const check = (name: string, verify: () => void) => {
              try {
                verify();
                checks.push({ name, passed: true });
              } catch (error) {
                checks.push({ name, passed: false, error: String(error) });
                failures.push(`${indices.join("+")}: ${name}: ${String(error)}`);
              }
            };
            check("runtime", () => {
              expect(arm.waitErrors).toEqual([]);
              expect(runs).toHaveLength(indices.length);
              expect(runs.every((run) => completedTicketStatus(run.status))).toBe(true);
            });
            check("requested writes", () => {
              for (const index of indices) scenario.tasks[index]?.verify(before, after);
            });
            check("unchanged unrelated state", () => {
              expect(
                unexpectedChanges(
                  before,
                  after,
                  indices.flatMap((index) => scenario.tasks[index]?.paths ?? []),
                ),
              ).toEqual([]);
            });
            check("distinct stable targets", () => {
              expect(targets.every((ids) => ids.length === 1)).toBe(true);
              expect(new Set(targets.flat()).size).toBe(indices.length);
            });
            for (const [runIndex, list] of events.entries()) {
              check(`run ${runIndex}: browser-only protocol`, () => {
                const calls = list.filter((event) => event.kind === "tool_call");
                expect(calls.length).toBeGreaterThan(0);
                expect(
                  calls.map(toolNameOf).filter((name) => !name.startsWith("browser_")),
                ).toEqual([]);
              });
              check(`run ${runIndex}: tool errors and takeover`, () => {
                expect(list.filter((event) => event.kind === "takeover")).toEqual([]);
                expect(
                  list.filter(
                    (event) => event.kind === "tool_result" && event.payload.isError === true,
                  ),
                ).toEqual([]);
              });
              check(`run ${runIndex}: screenshot attribution`, () => {
                const target = browserTabIds(list)[0];
                const screenshots = list.filter((event) => event.kind === "screenshot");
                expect(screenshots.length).toBeGreaterThan(0);
                expect(screenshots.every((event) => event.payload.tabId === target)).toBe(true);
              });
              check(`run ${runIndex}: no own-tab lock wait`, () => {
                expect(list.filter((event) => event.kind === "takeover")).toEqual([]);
                expect(
                  list.filter((event) => {
                    if (event.kind !== "tool_result") return false;
                    const content = JSON.stringify(event.payload.content ?? "");
                    return (
                      content.includes(HUMAN_HOLDS_BROWSER_MESSAGE) ||
                      content.includes("Another run is operating this browser tab.")
                    );
                  }),
                ).toEqual([]);
              });
            }
            if (indices.length === 2) {
              check("runs overlap", () => {
                const startsAt = runs.map((run) => Date.parse(run.startedAt ?? ""));
                const endsAt = runs.map((run) => Date.parse(run.finishedAt ?? ""));
                expect(Math.min(...endsAt) - Math.max(...startsAt)).toBeGreaterThan(0);
              });
            }
            if (ticketOracle({ indices, checks }) !== true)
              oracleFailures.push(
                `${indices.join("+")}: canonical runtime/state/tab oracle failed`,
              );
            arm.assessment = assessTicketArm({
              indices,
              checks,
              events,
              targets,
              eventsComplete: true,
            });
          }
          // Canonical X02/X03 oracle (benchmark §6) is distinct from the stricter diagnostics
          // added in the first batch. Retain every diagnostic failure without relabelling it.
          row.strictDiagnosticsPassed = failures.length === 0;
          row.diagnosticFailures = failures;
          row.assessment = aggregateAssessments(
            row.arms.map((arm) => (arm as { assessment?: M2Assessment }).assessment),
          );
          expect(
            oracleFailures,
            "All canonical paired arm failures are retained in evidence",
          ).toEqual([]);
          row.passed = true;
        } catch (error) {
          for (const rawArm of row.arms) {
            const arm = rawArm as {
              indices: number[];
              waitErrors?: string[];
              assessment?: M2Assessment;
            };
            if (!arm.assessment)
              arm.assessment = assessTicketArm({
                indices: arm.indices,
                ...(arm.waitErrors?.length ? { checks: [{ name: "runtime", passed: false }] } : {}),
              });
          }
          row.assessment ??= aggregateAssessments(
            row.arms.map((arm) => (arm as { assessment?: M2Assessment }).assessment),
          );
          row.error = String(error);
          throw error;
        }
      },
      18 * 60_000,
    );
});
