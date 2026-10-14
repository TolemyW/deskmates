// T3: what a chief learns when the expert it delegated to ends without a reply, or fails
// (ADR-0016 amendment 1). Two scenarios through the configured model:
//
//   silent  the expert is told to end its run with an empty reply;
//   failed  the expert's run cannot reach a model (its bot names a model the upstream does not
//           have), so the run ends `failed` without the expert's SOUL being involved.
//
// The oracle is the chief's own statement of what happened: it must post
// `CHIEF_RESULT silent <marker>` or `CHIEF_RESULT failed <marker>`. Before the amendment nothing
// tells the chief either outcome, so it is never woken and the thread just stops; the report
// records that as well (no notice, no follow-up run, no result), so the same file measures both
// trees. A report is written per scenario whether or not the assertion holds.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread, ThreadMessage } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import {
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMessages,
  postGroupMessage,
  threadRuns,
} from "./support/m2-group.js";
import type { RunView } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;

const TERMINAL = new Set(["succeeded", "silent", "failed", "cancelled", "stopped"]);
/** No run changed for this long after everything is terminal: nothing more is coming. */
const QUIET_MS = 12_000;
const SETTLE_TIMEOUT_MS = 6 * 60_000;
/** Not a model: the point is that the upstream refuses it and the run fails. */
const UNAVAILABLE_MODEL = "delegation-outcome-unavailable";

type Scenario = "silent" | "failed";

function chiefSoul(chief: string, expert: string): string {
  return `# ${chief}
You coordinate one expert in a controlled delegation case. Use messaging tools only.
Do not browse, use shell, inspect files, or write memory.
For DELEGATE_CASE, call thread_post once with one message that mentions @${expert} and contains
the case marker and TASK:17+25. Then end that run with an empty reply. Do not compute the task.
When you are woken again, decide from the new messages in the thread:
- an expert message containing E_RESULT is visible: reply exactly CHIEF_RESULT ok <marker>
- a system message says the expert ended without posting a reply: reply exactly CHIEF_RESULT silent <marker>
- a system message says the expert failed: reply exactly CHIEF_RESULT failed <marker>
Never delegate the same marker twice. Return the required fenced JSON run summary.`;
}

function expertSoul(expert: string): string {
  return `# ${expert}
You are an expert in a controlled delegation case. Use no tools.
When the chief assigns TASK:17+25, do not post anything and do not answer: end the run with an
empty reply. Return the required fenced JSON run summary with reply "".`;
}

interface OutcomeReport {
  scenario: Scenario;
  passed: boolean;
  error?: string;
  marker: string;
  model: string;
  image: string;
  wallMs: number;
  delegationPosted: boolean;
  expertStatus: string | null;
  noticePosted: boolean;
  noticeBody: string | null;
  chiefRuns: number;
  chiefFollowUpRuns: number;
  chiefResult: string | null;
  runs: { botId: string; status: string; error?: string; usage: unknown[] }[];
  messages: { seq: number; authorKind: string; authorId: string; body: string }[];
}

async function settle(stack: Stack, thread: Thread): Promise<RunView[]> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let signature = "";
  let stableSince = 0;
  for (;;) {
    const runs = await threadRuns(stack, thread);
    const next = runs.map((run) => `${run.id}:${run.status}:${run.attempt}`).join(",");
    if (next !== signature) {
      signature = next;
      stableSince = 0;
    }
    if (runs.length >= 2 && runs.every((run) => TERMINAL.has(run.status))) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= QUIET_MS) return runs;
    }
    if (Date.now() > deadline) return runs;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe.skipIf(skip)(`delegation outcome acceptance${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      ...modelEnv(),
      label: "m3-delegation-outcome",
      botName: "d_bootstrap",
    });
    stack.config.maxTurns = 8;
    // The failed scenario's run has no model to talk to; this bounds how long it can take to fail.
    stack.config.runTimeoutSeconds = 120;
  }, 120_000);

  afterAll(async () => {
    await stopStack(stack);
  }, 120_000);

  async function observe(scenario: Scenario): Promise<OutcomeReport> {
    const chiefName = `d_chief_${scenario}`;
    const expertName = `d_expert_${scenario}`;
    const marker = `DELEGATION_OUTCOME_${scenario.toUpperCase()}_20260930`;
    const started = Date.now();
    const bots: BotDefinition[] = [
      await createGroupBot(stack, {
        name: chiefName,
        role: "chief",
        soul: chiefSoul(chiefName, expertName),
      }),
      await createGroupBot(stack, {
        name: expertName,
        role: "expert",
        soul: expertSoul(expertName),
        ...(scenario === "failed" ? { model: UNAVAILABLE_MODEL } : {}),
      }),
    ];
    const [chief, expert] = bots as [BotDefinition, BotDefinition];
    const thread = await createGroupThread(stack, bots, `delegation outcome ${scenario}`);
    await postGroupMessage(
      stack,
      thread,
      `@${chiefName} DELEGATE_CASE ${marker}. Delegate the task to the expert and report what happened.`,
    );
    const runs = await settle(stack, thread);
    const messages: ThreadMessage[] = await groupMessages(stack, thread);
    const delegation = messages.find(
      (m) =>
        m.authorKind === "bot" &&
        m.authorId === chief.id &&
        m.mentions.some((mention) => mention.kind === "bot" && mention.botId === expert.id),
    );
    const expertRun = runs.find((run) => run.botId === expert.id);
    const notice = messages.find(
      (m) => m.authorKind === "system" && m.body.startsWith("Delegation outcome:"),
    );
    const chiefRuns = runs.filter((run) => run.botId === chief.id);
    const result = messages.find(
      (m) => m.authorKind === "bot" && m.authorId === chief.id && m.body.includes("CHIEF_RESULT"),
    );
    const withUsage = await Promise.all(
      runs.map(async (run) => {
        const response = await stack.api<{ usage: unknown[] }>("GET", `/api/runs/${run.id}`);
        return {
          botId: run.botId,
          status: run.status,
          ...(run.error ? { error: run.error.slice(0, 200) } : {}),
          usage: response.status === 200 ? response.json.usage : [],
        };
      }),
    );
    return {
      scenario,
      passed: false,
      marker,
      model: modelEnv().defaultModel,
      image: process.env.WORKSPACE_IMAGE ?? "",
      wallMs: Date.now() - started,
      delegationPosted: delegation !== undefined,
      expertStatus: expertRun?.status ?? null,
      noticePosted: notice !== undefined,
      noticeBody: notice?.body ?? null,
      chiefRuns: chiefRuns.length,
      chiefFollowUpRuns: Math.max(0, chiefRuns.length - 1),
      chiefResult: result?.body ?? null,
      runs: withUsage,
      messages: messages.map((m) => ({
        seq: m.seq,
        authorKind: m.authorKind,
        authorId: m.authorId,
        body: m.body.slice(0, 400),
      })),
    };
  }

  for (const scenario of ["silent", "failed"] as const) {
    it(
      `${scenario} expert: the chief is told and says so`,
      async () => {
        let report: OutcomeReport | undefined;
        try {
          report = await observe(scenario);
          expect(report.delegationPosted, "the chief delegated by mention").toBe(true);
          expect(report.expertStatus).toBe(scenario);
          expect(report.chiefResult ?? "").toContain(`CHIEF_RESULT ${scenario} ${report.marker}`);
          report.passed = true;
        } catch (error) {
          if (report) report.error = String(error).slice(0, 400);
          throw error;
        } finally {
          const output = ensureReportDir(reportDir);
          if (output && report) {
            writeFileSync(
              join(output, `delegation-outcome-${scenario}.json`),
              JSON.stringify(report, null, 2),
            );
          }
        }
      },
      8 * 60_000,
    );
  }
});
