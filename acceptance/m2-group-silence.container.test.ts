// T2: a real SDK result with visible prose plus an explicit empty summary reply stays silent.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { type FakeModelUpstream, startFakeModelUpstream } from "./support/fake-model-upstream.js";
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
import { type Stack, groupRoutingOf, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;
const SILENT_RESULT = [
  "Nothing addressed to me; remaining silent per my role.",
  "",
  "```json",
  JSON.stringify({
    done: "Observed the group message and intentionally stayed silent.",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply: "",
  }),
  "```",
].join("\n");

describe.skipIf(!available)(
  "M2 explicit summary silence (real Docker/SDK, scripted upstream)",
  () => {
    let upstream: FakeModelUpstream;
    let stack: Stack;
    let thread: Thread;
    let bots: BotDefinition[] = [];
    let failure: unknown;
    let testCompleted = false;

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: "m2-group-silence-fake",
        reply: "unused",
        script: () => ({ kind: "text", text: SILENT_RESULT }),
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: "m2-group-silence-fake",
        defaultModel: "fake-group-silence",
        cheapModel: "fake-group-silence-cheap",
        label: "m2-group-silence",
        botName: "b3_silence_bootstrap",
      });
      bots = await Promise.all(
        ["b3_silence_a", "b3_silence_b"].map((name) =>
          createGroupBot(stack, {
            name,
            role: "silent observer",
            soul: `# ${name}\nObserve unaddressed messages and stay silent.`,
          }),
        ),
      );
      thread = await createGroupThread(stack, bots, "B3 explicit silence contract");
    }, 120_000);

    afterAll(async () => {
      try {
        const output = ensureReportDir(reportDir);
        if (output && stack && thread) {
          const runs = await threadRuns(stack, thread);
          writeFileSync(
            join(output, "group-silence-results.json"),
            JSON.stringify(
              {
                passed: testCompleted && failure === undefined,
                testCompleted,
                ...(failure === undefined ? {} : { error: String(failure) }),
                assistantText: SILENT_RESULT,
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
        await upstream?.close();
      }
    }, 120_000);

    it("honours explicit reply empty and creates no derivative observation walk", async () => {
      try {
        const posted = await postGroupMessage(stack, thread, "Observe this unaddressed message.");
        expect(posted.runs).toHaveLength(1);
        const runs = await waitForGroup(stack, thread, 2, 120_000);
        expect(runs).toHaveLength(2);
        expect(runs.map((run) => run.botId)).toEqual(bots.map((bot) => bot.id));
        expect(runs.every((run) => run.status === "silent")).toBe(true);
        expect(runs.every((run) => run.summary?.reply === "")).toBe(true);
        expect(
          runs.every(
            (run) =>
              run.summary?.done === "Observed the group message and intentionally stayed silent.",
          ),
        ).toBe(true);
        const messages = await groupMessages(stack, thread);
        expect(messages[0]?.authorKind).toBe("human");
        if (groupRoutingOf(stack) === "owner-v1") {
          // ADR-0005 amendment 2, decision 18: an offer every member passed on is said so, by
          // the Gateway, and that line wakes nobody.
          expect(messages).toHaveLength(2);
          expect(messages[1]?.authorKind).toBe("system");
          expect(messages[1]?.body).toContain("No member replied to message #1");
          expect(await threadRuns(stack, thread)).toHaveLength(2);
        } else {
          expect(messages).toHaveLength(1);
        }
        testCompleted = true;
      } catch (error) {
        failure = error;
        throw error;
      }
    }, 150_000);
  },
);
