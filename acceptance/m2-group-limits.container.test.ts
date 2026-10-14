// T2: adversarial bot loops through the real SDK and thread_post tool, with a scripted upstream.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread } from "@deskmates/contracts";
import { RELAY_COUNT_MAX, TURN_BUDGET_DEFAULT } from "@deskmates/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import {
  type GroupTarget,
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMessages,
  groupRunEvents,
  postGroupMessage,
  threadRuns,
  waitForGroup,
} from "./support/m2-group.js";
import { type Stack, addWorkspace, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;
const RELAY_A = "b3_relay_a";
const RELAY_B = "b3_relay_b";
const BUDGET_NAMES = Array.from({ length: 6 }, (_, index) => `b3_budget_${index + 1}`);

function requestText(body: Record<string, unknown> | undefined): string {
  return JSON.stringify(body ?? {});
}

function currentTurnHasToolResult(text: string): boolean {
  const latestTrigger = Math.max(
    text.lastIndexOf("B3_RELAY_LOOP"),
    text.lastIndexOf("B3_BUDGET_LOOP"),
  );
  return text.lastIndexOf('"tool_result"') > latestTrigger;
}

describe.skipIf(!available)("M2 group loop limits (real Docker/SDK, scripted upstream)", () => {
  let upstream: FakeModelUpstream;
  let stack: Stack;
  // The budget case's own workspace, provisioned while the relay case runs.
  let budgetWorkspace: Promise<GroupTarget> | undefined;
  const threads: Thread[] = [];
  const threadEvidence: Record<string, unknown>[] = [];
  let failure: unknown;
  let testCompleted = false;

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: "m2-group-limits-fake",
      reply: "",
      script: (_turn, body) => {
        const text = requestText(body);
        const conversation = JSON.stringify(body?.messages ?? []);
        const hasThreadPost = text.includes("mcp__deskmates__thread_post");
        // A resumed bot session contains earlier tool results. Ordering distinguishes those from
        // the result of the current run: the fresh trigger follows history, while this run's
        // tool_result follows the most recent loop marker.
        const hasToolResult = currentTurnHasToolResult(conversation);
        if (!hasThreadPost || hasToolResult) return { kind: "text", text: assistantText("") };
        if (conversation.includes("B3_RELAY_LOOP")) {
          const target = text.includes(`# ${RELAY_A}`) ? RELAY_B : RELAY_A;
          return {
            kind: "tool_use",
            name: "mcp__deskmates__thread_post",
            input: { body: `@${target} B3_RELAY_LOOP`, attachments: [] },
          };
        }
        if (conversation.includes("B3_BUDGET_LOOP")) {
          return {
            kind: "tool_use",
            name: "mcp__deskmates__thread_post",
            input: {
              body: `${BUDGET_NAMES.map((name) => `@${name}`).join(" ")} B3_BUDGET_LOOP`,
              attachments: [],
            },
          };
        }
        return { kind: "text", text: assistantText("") };
      },
    });
  }, 120_000);

  beforeAll(async () => {
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: "m2-group-limits-fake",
      defaultModel: "fake-group-limits",
      cheapModel: "fake-group-limits-cheap",
      label: "m2-group-limits",
      botName: "b3_limits_bootstrap",
    });
    stack.config.maxTurns = 4;
    stack.config.runTimeoutSeconds = 90;
    // Screen slots persist for a bot's lifetime and a workspace has six. The relay case's two
    // desktops would leave too few for the budget case's six fan-out bots, so each case has its
    // own workspace in this one Gateway. The second starts provisioning now, alongside the relay
    // case; the budget case awaits it.
    budgetWorkspace = addWorkspace(stack, {
      label: "m2-group-limits-budget",
      egressAllowlist: [new URL(stack.siteOriginForBot).hostname],
    });
    // Handled here so a provisioning failure fails the budget case instead of the process.
    budgetWorkspace.catch(() => undefined);
  }, 120_000);

  afterEach(async () => {
    threadEvidence.push(
      ...(await Promise.all(
        threads.splice(0).map(async (thread) => {
          const runs = await threadRuns(stack, thread);
          const current = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
          return {
            thread: current.json.thread,
            messages: await groupMessages(stack, thread),
            runs: await Promise.all(
              runs.map(async (run) => ({ run, events: await groupRunEvents(stack, run) })),
            ),
          };
        }),
      )),
    );
  }, 120_000);

  afterAll(async () => {
    try {
      const output = ensureReportDir(reportDir);
      if (output) {
        writeFileSync(
          join(output, "group-limits-results.json"),
          JSON.stringify(
            {
              passed: testCompleted && failure === undefined,
              testCompleted,
              ...(failure === undefined ? {} : { error: String(failure) }),
              tested:
                "real SDK thread_post adversaries stop at relay_count and turn_budget with transcript alerts and cap_breached ledger events",
              threads: threadEvidence,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      // A budget workspace still provisioning is recorded on the stack once it exists; wait for
      // it so stopStack removes it too.
      await budgetWorkspace?.catch(() => undefined);
      await stopStack(stack);
      await upstream?.close();
    }
  }, 120_000);

  it("stores the relay breach but does not deliver its mention", async () => {
    try {
      const bots = await Promise.all(
        [RELAY_A, RELAY_B].map((name) =>
          createGroupBot(stack, {
            name,
            role: "adversarial relay bot",
            soul: `# ${name}\nFor B3_RELAY_LOOP, call thread_post mentioning the other relay bot.`,
          }),
        ),
      );
      const thread = await createGroupThread(stack, bots, "B3 relay bound");
      threads.push(thread);
      await postGroupMessage(stack, thread, `@${RELAY_A} B3_RELAY_LOOP`);
      const runs = await waitForGroup(stack, thread, RELAY_COUNT_MAX + 1, 180_000);
      const messages = await groupMessages(stack, thread);
      const botMessages = messages.filter((message) => message.authorKind === "bot");
      expect(runs).toHaveLength(RELAY_COUNT_MAX + 1);
      expect(botMessages).toHaveLength(RELAY_COUNT_MAX + 1);
      expect(botMessages.at(-1)?.relayCount).toBe(RELAY_COUNT_MAX + 1);
      expect(messages.filter((message) => message.body.includes("relay cap reached"))).toHaveLength(
        1,
      );
      const capEvents = (await Promise.all(runs.map((run) => groupRunEvents(stack, run)))).flatMap(
        (events) => events.filter((event) => event.kind === "cap_breached"),
      );
      expect(capEvents).toHaveLength(1);
      expect(capEvents[0]?.payload.cap).toBe("relay_count");
      const response = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
      expect(response.json.thread.status).toBe("active");
    } catch (error) {
      failure = error;
      throw error;
    }
  }, 240_000);

  it("pauses a fan-out loop at the turn budget and bounds total model runs", async () => {
    try {
      const target = await (budgetWorkspace as Promise<GroupTarget>);
      const bots: BotDefinition[] = [];
      for (const name of BUDGET_NAMES) {
        bots.push(
          await createGroupBot(
            stack,
            {
              name,
              role: "adversarial fan-out bot",
              soul: `# ${name}\nFor B3_BUDGET_LOOP, call thread_post mentioning every budget bot.`,
            },
            target,
          ),
        );
      }
      const thread = await createGroupThread(stack, bots, "B3 turn budget bound", target);
      threads.push(thread);
      await postGroupMessage(
        stack,
        thread,
        `${BUDGET_NAMES.map((name) => `@${name}`).join(" ")} B3_BUDGET_LOOP`,
      );
      const runs = await waitForGroup(stack, thread, TURN_BUDGET_DEFAULT, 240_000);
      const messages = await groupMessages(stack, thread);
      const botMessages = messages.filter((message) => message.authorKind === "bot");
      const response = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
      expect(response.json.thread.status).toBe("paused");
      expect(botMessages.length).toBeGreaterThanOrEqual(TURN_BUDGET_DEFAULT);
      expect(runs.length).toBeLessThanOrEqual(TURN_BUDGET_DEFAULT + bots.length * 2);
      expect(messages.some((message) => message.body.includes("turn budget reached"))).toBe(true);
      const capEvents = (await Promise.all(runs.map((run) => groupRunEvents(stack, run)))).flatMap(
        (events) => events.filter((event) => event.kind === "cap_breached"),
      );
      expect(capEvents.some((event) => event.payload.cap === "turn_budget")).toBe(true);
      testCompleted = true;
    } catch (error) {
      failure = error;
      throw error;
    }
  }, 300_000);
});
