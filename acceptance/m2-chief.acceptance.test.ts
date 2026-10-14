// T3: the canonical chief -> two experts -> chief exchange through the configured model.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread, ThreadMessage } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMessages,
  groupRunEvents,
  postGroupMessage,
  threadRuns,
  waitForGroup,
} from "./support/m2-group.js";
import type { RunView } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const image = process.env.WORKSPACE_IMAGE ?? "";
const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);

const CHIEF_SOUL = `# b3_chief
You are the chief of staff in a controlled collaboration acceptance case.
Use messaging tools only. Do not browse, use shell, inspect files, or write memory.
For CHIEF_CASE, call thread_post once with one message that mentions both @b3_analyst and
@b3_reviewer. Include the case marker, ASSIGN_ANALYST:17+25 and ASSIGN_REVIEWER:9*6.
Then end that run with an empty reply. Do not calculate either expert's answer yourself.
When both expert messages for that marker are visible, reply exactly
CHIEF_SUMMARY analyst=42 reviewer=54 total=96 <marker>. If only one is visible, stay silent.
Never delegate or summarize the same marker twice. Return the required fenced JSON run summary.`;

const ANALYST_SOUL = `# b3_analyst
You are the arithmetic analyst in a controlled collaboration acceptance case.
Use no tools. When the chief assigns ASSIGN_ANALYST:17+25, reply exactly
@b3_chief ANALYST_RESULT=42 followed by the case marker. Handle each marker once.
Otherwise stay silent. Return the required fenced JSON run summary.`;

const REVIEWER_SOUL = `# b3_reviewer
You are the arithmetic reviewer in a controlled collaboration acceptance case.
Use no tools. When the chief assigns ASSIGN_REVIEWER:9*6, reply exactly
@b3_chief REVIEWER_RESULT=54 followed by the case marker. Handle each marker once.
Otherwise stay silent. Return the required fenced JSON run summary.`;

function messageWith(messages: readonly ThreadMessage[], text: string): ThreadMessage {
  const message = messages.find((item) => item.body.includes(text));
  if (!message) throw new Error(`missing message containing ${text}`);
  return message;
}

describe.skipIf(skip)(`M2 chief acceptance${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;
  let bots: BotDefinition[] = [];
  let thread: Thread | undefined;
  let failure: unknown;
  let testCompleted = false;

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({ ...modelEnv(), label: "m2-chief", botName: "b3_bootstrap_chief" });
    stack.config.browserSnapshotMode = snapshotMode;
    stack.config.maxTurns = 8;
    stack.config.runTimeoutSeconds = 180;
    bots = await Promise.all([
      createGroupBot(stack, { name: "b3_chief", role: "chief of staff", soul: CHIEF_SOUL }),
      createGroupBot(stack, { name: "b3_analyst", role: "arithmetic analyst", soul: ANALYST_SOUL }),
      createGroupBot(stack, {
        name: "b3_reviewer",
        role: "arithmetic reviewer",
        soul: REVIEWER_SOUL,
      }),
    ]);
    thread = await createGroupThread(stack, bots, "B3 chief collaboration");
  }, 120_000);

  afterAll(async () => {
    try {
      const output = ensureReportDir(reportDir);
      if (output && stack && thread) {
        const runs = await threadRuns(stack, thread);
        writeFileSync(
          join(output, "chief-results.json"),
          JSON.stringify(
            {
              passed: testCompleted && failure === undefined,
              testCompleted,
              ...(failure === undefined ? {} : { error: String(failure) }),
              scope:
                "Focused arithmetic routing acceptance; this is not the billing-ticket X01 benchmark.",
              tested:
                "configured-model chief delegation, two expert replies, final aggregation, trace attribution, and ADR-0005 coalesced-or-straddled wake shape",
              model: modelEnv().defaultModel,
              image,
              thread,
              messages: await groupMessages(stack, thread),
              runs: await Promise.all(
                runs.map(async (run) => ({ run, events: await groupRunEvents(stack, run) })),
              ),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await stopStack(stack);
    }
  }, 120_000);

  it(
    "delegates to both experts, coalesces their replies, and preserves every ledger hop",
    async () => {
      try {
        const marker = "B3_CHIEF_TRACE_20260923";
        const activeThread = thread as Thread;
        const posted = await postGroupMessage(
          stack,
          activeThread,
          `@b3_chief CHIEF_CASE ${marker}. Delegate the two calculations and summarize only after both experts answer.`,
        );
        expect(posted.runs).toHaveLength(1);
        expect(posted.runs[0]?.botId).toBe(bots[0]?.id);

        const runs = await waitForGroup(stack, activeThread, 4);
        const messages = await groupMessages(stack, activeThread);
        const assignment = messageWith(messages, "ASSIGN_ANALYST:17+25");
        expect(assignment.body).toContain("ASSIGN_REVIEWER:9*6");
        expect(assignment.mentions.filter((mention) => mention.kind === "bot")).toHaveLength(2);
        const analystResult = messageWith(messages, "ANALYST_RESULT=42");
        const reviewerResult = messageWith(messages, "REVIEWER_RESULT=54");
        const summary = messageWith(messages, "CHIEF_SUMMARY analyst=42 reviewer=54 total=96");

        // Required markers alone are not enough: an expert reply without @chief would exercise a
        // different unaddressed walk, and extra progress posts change both routing and budget use.
        expect(assignment.authorId).toBe(bots[0]?.id);
        expect(
          assignment.mentions
            .filter((mention) => mention.kind === "bot")
            .map((mention) => mention.botId)
            .sort(),
        ).toEqual([bots[1]?.id, bots[2]?.id].sort());
        expect(analystResult.authorId).toBe(bots[1]?.id);
        expect(reviewerResult.authorId).toBe(bots[2]?.id);
        expect(summary.authorId).toBe(bots[0]?.id);
        expect(analystResult.mentions).toContainEqual({ kind: "bot", botId: bots[0]?.id });
        expect(reviewerResult.mentions).toContainEqual({ kind: "bot", botId: bots[0]?.id });
        const botMessages = messages.filter((message) => message.authorKind === "bot");
        expect(botMessages).toHaveLength(4);
        expect(
          botMessages.filter((message) => message.body.includes("ASSIGN_ANALYST")),
        ).toHaveLength(1);
        expect(
          botMessages.filter((message) => message.body.includes("ANALYST_RESULT")),
        ).toHaveLength(1);
        expect(
          botMessages.filter((message) => message.body.includes("REVIEWER_RESULT")),
        ).toHaveLength(1);

        const chiefRuns = runs.filter((run) => run.botId === bots[0]?.id);
        const analystRun = runs.find((run) => run.botId === bots[1]?.id);
        const reviewerRun = runs.find((run) => run.botId === bots[2]?.id);
        expect(analystRun).toBeDefined();
        expect(reviewerRun).toBeDefined();
        expect(analystRun?.status).toBe("succeeded");
        expect(reviewerRun?.status).toBe("succeeded");
        const initialChief = chiefRuns.find((run) => run.triggerRef === posted.message.id);
        const finalChief = chiefRuns.find((run) => run.id === summary.runId);
        expect(initialChief).toBeDefined();
        expect(finalChief).toBeDefined();
        expect(finalChief?.status).toBe("succeeded");
        // ADR-0005 permits one coalesced wake, or two when the expert replies straddle the
        // first follow-up run's boundary. Either shape must converge on exactly one summary.
        expect(chiefRuns.length).toBeGreaterThanOrEqual(2);
        expect(chiefRuns.length).toBeLessThanOrEqual(3);
        expect(messages.filter((message) => message.body.includes("CHIEF_SUMMARY"))).toHaveLength(
          1,
        );

        // Bidirectional trace: trigger message -> run -> emitted message at every hop.
        expect(assignment.runId).toBe(initialChief?.id);
        expect(analystRun?.triggerRef).toBe(assignment.id);
        expect(reviewerRun?.triggerRef).toBe(assignment.id);
        expect(analystResult.runId).toBe(analystRun?.id);
        expect(reviewerResult.runId).toBe(reviewerRun?.id);
        expect([analystResult.id, reviewerResult.id]).toContain(finalChief?.triggerRef);
        expect(summary.runId).toBe(finalChief?.id);
        expect(summary.seq).toBeGreaterThan(Math.max(analystResult.seq, reviewerResult.seq));
        expect(runs.every((run) => run.lane === "interactive")).toBe(true);
        expect(runs.every((run) => Object.keys(run.config).length > 0)).toBe(true);

        // At the real sidecar boundary, the follow-up wake(s) cover both replies exactly once.
        // One delivery proves queued coalescing; two are the documented straddle case.
        const followups = chiefRuns
          .filter((run) => run.id !== initialChief?.id)
          .map(
            (run) =>
              stack.provider.sidecarRuns().find((entry) => entry.request.runId === run.id)?.request
                .trigger,
          );
        expect(followups.every((trigger) => trigger?.kind === "thread_message")).toBe(true);
        const deliveredBodies = followups.flatMap((trigger) =>
          trigger?.kind === "thread_message" ? trigger.messages.map((message) => message.body) : [],
        );
        expect(deliveredBodies.filter((body) => body.includes("ANALYST_RESULT=42"))).toHaveLength(
          1,
        );
        expect(deliveredBodies.filter((body) => body.includes("REVIEWER_RESULT=54"))).toHaveLength(
          1,
        );

        for (const run of runs) {
          const response = await stack.api<{ run: RunView; usage: unknown[] }>(
            "GET",
            `/api/runs/${run.id}`,
          );
          expect(response.status).toBe(200);
          expect(response.json.usage.length).toBeGreaterThan(0);
        }
        testCompleted = true;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
    8 * 60_000,
  );
});
