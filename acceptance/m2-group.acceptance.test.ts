// T3: explicit parallel browser work, ordered silence, and human join-by-mention history.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotDefinition, RELAY_COUNT_MAX, type Thread } from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  applyGroupRoleContract,
  groupRoleContractEvidence,
  selectGroupRoleContractVersion,
} from "./support/m2-group-role-contract.js";
import {
  browserTabIds,
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMembers,
  groupMessages,
  groupRunEvents,
  postGroupMessage,
  threadRuns,
  waitForGroup,
} from "./support/m2-group.js";
import { type RunView, toolNameOf } from "./support/runs.js";
import { type Stack, groupRoutingOf, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const image = process.env.WORKSPACE_IMAGE ?? "";
const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);
const roleContractVersion = selectGroupRoleContractVersion(process.env.M2_GROUP_ROLE_CONTRACT);

const CHIEF_SOUL = `# b3_group_chief
You own unaddressed requests in this acceptance group. Use no tools.
For a GROUP_OWNER message, reply exactly GROUP_OWNER_ANSWER followed by its marker, once.
For every other message, stay silent. Return the required fenced JSON run summary.`;

const ANALYST_SOUL = `# b3_group_analyst
You are the ticket-metric analyst. For a GROUP_PARALLEL request explicitly addressed to you,
use browser_navigate and browser_snapshot only, open the analyst URL from the request, and read
Open tickets. Verify the displayed value is 23, then reply exactly ANALYST_BROWSER=23 followed by
its marker. Do not answer
GROUP_OWNER or HISTORY_CHECK messages. Otherwise stay silent. Never use shell or modify data.
Return the required fenced JSON run summary.`;

const REVIEWER_SOUL = `# b3_group_reviewer
You are the revenue-metric reviewer. For a GROUP_PARALLEL request explicitly addressed to you,
use browser_navigate and browser_snapshot only, open the reviewer URL from the request, and read
This month's revenue. Verify the displayed value is 128450, then reply exactly
REVIEWER_BROWSER=128450 followed by its marker. Do not answer
GROUP_OWNER or HISTORY_CHECK messages. Otherwise stay silent. Never use shell or modify data.
Return the required fenced JSON run summary.`;

const OBSERVER_SOUL = `# b3_group_observer
You are a history auditor. Use no tools. When a human addresses HISTORY_CHECK to you, verify that
the delivered conversation contains PARALLEL_HISTORY_MARKER, both ANALYST_BROWSER and
REVIEWER_BROWSER replies with values 23 and 128450, OWNER_HISTORY_MARKER, and
GROUP_OWNER_ANSWER. If all are visible,
reply exactly HISTORY_SEEN parallel+two-replies+owner. Otherwise reply exactly HISTORY_MISSING.
For anything else stay silent. Return the required fenced JSON run summary.`;

const roleContract = groupRoleContractEvidence(roleContractVersion, {
  chief: CHIEF_SOUL,
  analyst: ANALYST_SOUL,
  reviewer: REVIEWER_SOUL,
  observer: OBSERVER_SOUL,
});

type GroupPhase = "parallel" | "ordered" | "newcomer" | "state";
interface PhaseCheck {
  detail: string;
  passed: boolean;
}

function firstRunFor(runs: readonly RunView[], bot: BotDefinition): RunView {
  const run = runs.find((item) => item.botId === bot.id);
  if (!run) throw new Error(`missing run for ${bot.name}`);
  return run;
}

describe.skipIf(skip)(`M2 group acceptance${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;
  let bots: BotDefinition[] = [];
  let observer: BotDefinition;
  let thread: Thread;
  let failure: unknown;
  let testCompleted = false;
  let baselineState = "";
  const phaseOutcomes: Record<GroupPhase, PhaseCheck[]> = {
    parallel: [],
    ordered: [],
    newcomer: [],
    state: [],
  };
  const check = (phase: GroupPhase, passed: boolean, detail: string): void => {
    phaseOutcomes[phase].push({ detail, passed });
  };

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({ ...modelEnv(), label: "m2-group", botName: "b3_bootstrap_group" });
    stack.config.browserSnapshotMode = snapshotMode;
    stack.config.maxTurns = 8;
    stack.config.runTimeoutSeconds = 180;
    const session = stack.site.state.login(OPS_ACCOUNT, PASSWORD);
    if (!session) throw new Error("operator login fixture failed");
    expect(stack.site.state.kpis().openTickets).toBe(23);
    expect(stack.site.state.kpis().monthRevenue).toBe(128_450);
    baselineState = JSON.stringify(stack.site.state.view());
    const seeded = await stack.provider.exec(stack.handle, {
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `import { chromium } from '/opt/deskmates/node_modules/playwright/index.mjs'; const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'); await browser.contexts()[0].addCookies([{name:${JSON.stringify(SESSION_COOKIE)},value:${JSON.stringify(session.id)},url:${JSON.stringify(stack.siteOriginForBot)}}]); await browser.close();`,
      ],
      timeoutMs: 20_000,
    });
    if (seeded.exitCode !== 0) throw new Error(`seed browser session: ${seeded.stderr}`);
    bots = await Promise.all([
      createGroupBot(stack, {
        name: "b3_group_chief",
        role: "group owner",
        soul: applyGroupRoleContract(CHIEF_SOUL, roleContractVersion),
      }),
      createGroupBot(stack, {
        name: "b3_group_analyst",
        role: "ticket metric analyst",
        soul: applyGroupRoleContract(ANALYST_SOUL, roleContractVersion),
      }),
      createGroupBot(stack, {
        name: "b3_group_reviewer",
        role: "revenue metric reviewer",
        soul: applyGroupRoleContract(REVIEWER_SOUL, roleContractVersion),
      }),
    ]);
    observer = await createGroupBot(stack, {
      name: "b3_group_observer",
      role: "history auditor",
      soul: applyGroupRoleContract(OBSERVER_SOUL, roleContractVersion),
    });
    thread = await createGroupThread(stack, bots, "B3 group behavior");
  }, 120_000);

  afterAll(async () => {
    try {
      const output = ensureReportDir(reportDir);
      if (output && stack && thread) {
        const runs = await threadRuns(stack, thread);
        const messages = await groupMessages(stack, thread);
        const members = await groupMembers(stack, thread);
        const live = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
        if (live.status !== 200) throw new Error(`get live thread: ${live.status}`);
        const runEvidence = await Promise.all(
          runs.map(async (run) => ({ run, events: await groupRunEvents(stack, run) })),
        );
        let lastHumanIndex = -1;
        for (const [index, message] of messages.entries()) {
          if (message.authorKind === "human") lastHumanIndex = index;
        }
        const botMessagesSinceLastHuman = messages
          .slice(lastHumanIndex + 1)
          .filter((message) => message.authorKind === "bot").length;
        writeFileSync(
          join(output, "group-results.json"),
          JSON.stringify(
            {
              passed: testCompleted && failure === undefined,
              testCompleted,
              ...(failure === undefined ? {} : { error: String(failure) }),
              tested:
                "configured-model explicit parallel browser work with distinct run tabs, ordered no-mention silence, and human join-by-mention full-history delivery",
              phaseOutcomes,
              model: modelEnv().defaultModel,
              image,
              roleContract,
              thread: live.json.thread,
              threadCalibration: {
                status: live.json.thread.status,
                turnBudget: live.json.thread.turnBudget,
                relayCountMax: RELAY_COUNT_MAX,
                observedMaxRelayCount: Math.max(
                  0,
                  ...messages.map((message) => message.relayCount),
                ),
                botMessagesSinceLastHuman,
                capBreachedEvents: runEvidence.reduce(
                  (count, entry) =>
                    count + entry.events.filter((event) => event.kind === "cap_breached").length,
                  0,
                ),
              },
              members,
              messages,
              runs: runEvidence,
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
    "runs explicit mentions in separate tabs, orders an unaddressed round, and joins a nonmember with history",
    async () => {
      try {
        const parallel = await postGroupMessage(
          stack,
          thread,
          `@b3_group_analyst @b3_group_reviewer GROUP_PARALLEL PARALLEL_HISTORY_MARKER. Analyst open ${stack.siteOriginForBot}/dashboard?b3=analyst, verify Open tickets is 23, and reply ANALYST_BROWSER=23. Reviewer open ${stack.siteOriginForBot}/dashboard?b3=reviewer, verify This month's revenue is 128450, and reply REVIEWER_BROWSER=128450.`,
        );
        check("parallel", parallel.runs.length === 2, "human mention created exactly two runs");
        const parallelRuns = await waitForGroup(stack, thread, 2);
        const primaryParallelRuns = parallelRuns.filter(
          (run) => run.triggerRef === parallel.message.id,
        );
        check(
          "parallel",
          primaryParallelRuns.length === 2,
          "exactly two runs have the human message as trigger_ref",
        );
        check(
          "parallel",
          [...new Set(primaryParallelRuns.map((run) => run.botId))].sort().join(",") ===
            [bots[1]?.id, bots[2]?.id].sort().join(","),
          "the two human-triggered runs belong to analyst and reviewer",
        );
        // Each unaddressed final reply deliberately starts an in-turn observation walk. Those
        // later runs may be present, but are silent and are not counted as primary parallel work.
        check(
          "parallel",
          parallelRuns
            .filter((run) => run.triggerRef !== parallel.message.id)
            .every((run) => run.status === "silent"),
          "derivative observation walks are silent",
        );
        const analystRun = firstRunFor(primaryParallelRuns, bots[1] as BotDefinition);
        const reviewerRun = firstRunFor(primaryParallelRuns, bots[2] as BotDefinition);
        check("parallel", analystRun.status === "succeeded", "analyst primary run succeeded");
        check("parallel", reviewerRun.status === "succeeded", "reviewer primary run succeeded");
        check(
          "parallel",
          Math.max(
            Date.parse(analystRun.startedAt ?? ""),
            Date.parse(reviewerRun.startedAt ?? ""),
          ) <
            Math.min(
              Date.parse(analystRun.finishedAt ?? ""),
              Date.parse(reviewerRun.finishedAt ?? ""),
            ),
          "analyst and reviewer run intervals overlap",
        );
        const parallelEvents = await Promise.all([
          groupRunEvents(stack, analystRun),
          groupRunEvents(stack, reviewerRun),
        ]);
        const tabs = parallelEvents.map(browserTabIds);
        check("parallel", tabs[0]?.length === 1, "analyst has exactly one browser tab id");
        check("parallel", tabs[1]?.length === 1, "reviewer has exactly one browser tab id");
        check("parallel", tabs[0]?.[0] !== tabs[1]?.[0], "parallel runs own distinct tabs");
        for (const [index, events] of parallelEvents.entries()) {
          const ownedTab = tabs[index]?.[0];
          const screenshots = events.filter((event) => event.kind === "screenshot");
          check("parallel", screenshots.length > 0, `run ${index + 1} captured screenshots`);
          check(
            "parallel",
            screenshots.every((event) => event.payload.tabId === ownedTab),
            `run ${index + 1} screenshots match its owned tab`,
          );
          // Runtime health is tool-result success and correctly attributed screenshots.
          check(
            "parallel",
            events
              .filter((event) => event.kind === "tool_result")
              .every((event) => event.payload.isError !== true),
            `run ${index + 1} browser tool results have no runtime error`,
          );
          // Protocol compliance is kept separate: the role declared exactly these two tools.
          check(
            "parallel",
            events
              .filter((event) => event.kind === "tool_call")
              .map(toolNameOf)
              .every((name) => name === "browser_navigate" || name === "browser_snapshot"),
            `run ${index + 1} used only role-declared browser tools`,
          );
        }
        let messages = await groupMessages(stack, thread);
        const parallelReplies = messages.filter((message) => message.authorKind === "bot");
        check(
          "parallel",
          parallelReplies.length === 2,
          "the parallel round published exactly two bot messages",
        );
        check(
          "parallel",
          [...new Set(parallelReplies.map((message) => message.authorId))].sort().join(",") ===
            [bots[1]?.id, bots[2]?.id].sort().join(","),
          "each addressed peer published exactly one parallel reply",
        );
        check(
          "parallel",
          messages.some(
            (message) =>
              message.authorId === bots[1]?.id && message.body.includes("ANALYST_BROWSER=23"),
          ),
          "analyst published the exact verified marker",
        );
        check(
          "parallel",
          messages.some(
            (message) =>
              message.authorId === bots[2]?.id && message.body.includes("REVIEWER_BROWSER=128450"),
          ),
          "reviewer published the exact verified marker",
        );

        const beforeOrderedRuns = parallelRuns.length;
        const beforeOrderedMessages = messages.length;
        const ordered = await postGroupMessage(
          stack,
          thread,
          "GROUP_OWNER OWNER_HISTORY_MARKER. The group owner should answer; everyone else should remain silent.",
        );
        // Decision 4 walks all three members; under owner-v1 (amendment 2) the offer ends with
        // the owner's answer, nobody else is woken, and its reply starts no observation walk.
        const offered = groupRoutingOf(stack) === "owner-v1";
        const throughOrdered = await waitForGroup(
          stack,
          thread,
          beforeOrderedRuns + (offered ? 1 : 3),
        );
        const orderedRuns = throughOrdered.slice(beforeOrderedRuns);
        const primaryOrderedRuns = orderedRuns.filter(
          (run) => run.triggerRef === ordered.message.id,
        );
        check(
          "ordered",
          primaryOrderedRuns.map((run) => run.botId).join(",") ===
            (offered ? [bots[0]] : bots).map((bot) => bot?.id).join(","),
          offered
            ? "the unaddressed request was offered to the first member only, which took it"
            : "the human-triggered unaddressed walk ran every member in join order",
        );
        if (offered) {
          check("ordered", orderedRuns.length === 1, "the owner's unaddressed answer woke nobody");
        }
        check(
          "ordered",
          primaryOrderedRuns.slice(1).every((run) => run.status === "silent"),
          "the human-triggered second and third members ended silent",
        );
        check(
          "ordered",
          primaryOrderedRuns[0]?.status === "succeeded",
          "the human-triggered group owner run succeeded",
        );
        for (let index = 1; index < primaryOrderedRuns.length; index += 1) {
          check(
            "ordered",
            Date.parse(primaryOrderedRuns[index]?.startedAt ?? "") >=
              Date.parse(primaryOrderedRuns[index - 1]?.finishedAt ?? ""),
            `primary ordered run ${index + 1} starts after its predecessor finishes`,
          );
        }
        // The owner's unaddressed final answer starts a legitimate observation walk. Keep those
        // runs in the evidence, but distinguish them by trigger_ref from the three primary runs.
        check(
          "ordered",
          orderedRuns
            .filter((run) => run.triggerRef !== ordered.message.id)
            .every((run) => run.status === "silent"),
          "derivative ordered observation walks are silent",
        );
        messages = await groupMessages(stack, thread);
        const orderedReplies = messages
          .slice(beforeOrderedMessages + 1)
          .filter((message) => message.authorKind === "bot");
        check("ordered", orderedReplies.length === 1, "exactly one bot message answered the round");
        check("ordered", orderedReplies[0]?.authorId === bots[0]?.id, "the group owner answered");
        check(
          "ordered",
          orderedReplies[0]?.body.includes("GROUP_OWNER_ANSWER") === true,
          "the owner answer carries the required marker",
        );

        const beforeJoinRuns = throughOrdered.length;
        const beforeJoinMessages = messages.length;
        const join = await postGroupMessage(
          stack,
          thread,
          "@b3_group_observer HISTORY_CHECK: confirm the complete earlier conversation.",
        );
        const throughJoin = await waitForGroup(stack, thread, beforeJoinRuns + 1);
        // The observer's unaddressed answer legitimately starts a later in-turn observation walk.
        // Select the primary join wake by both recipient and the human join message, not list tail.
        const observerRun = throughJoin.find(
          (run) => run.botId === observer.id && run.triggerRef === join.message.id,
        );
        check(
          "newcomer",
          observerRun?.botId === observer.id,
          "the joined observer received the wake",
        );
        check("newcomer", observerRun?.status === "succeeded", "the joined observer run succeeded");
        check(
          "newcomer",
          throughJoin
            .slice(beforeJoinRuns)
            .filter((run) => run.triggerRef !== join.message.id)
            .every((run) => run.status === "silent"),
          "derivative newcomer observation walks are silent",
        );
        check(
          "newcomer",
          (await groupMembers(stack, thread)).length === 4,
          "observer joined as fourth member",
        );
        const delivery = stack.provider
          .sidecarRuns()
          .find((entry) => entry.request.runId === observerRun?.id)?.request.trigger;
        check("newcomer", delivery?.kind === "thread_message", "observer has a thread delivery");
        const deliveredBodies =
          delivery?.kind === "thread_message"
            ? delivery.messages.map((message) => message.body).join("\n")
            : "";
        for (const marker of [
          "PARALLEL_HISTORY_MARKER",
          "ANALYST_BROWSER=23",
          "REVIEWER_BROWSER=128450",
          "OWNER_HISTORY_MARKER",
          "GROUP_OWNER_ANSWER",
          "HISTORY_CHECK",
        ]) {
          check("newcomer", deliveredBodies.includes(marker), `full history includes ${marker}`);
        }
        messages = await groupMessages(stack, thread);
        const newcomerReplies = messages
          .slice(beforeJoinMessages + 1)
          .filter((message) => message.authorKind === "bot");
        check(
          "newcomer",
          newcomerReplies.length === 1,
          "exactly one bot message answered the newcomer round",
        );
        check(
          "newcomer",
          newcomerReplies.some(
            (message) =>
              message.authorId === observer.id &&
              message.body.includes("HISTORY_SEEN parallel+two-replies+owner"),
          ),
          "observer confirms the complete history",
        );
        check(
          "state",
          JSON.stringify(stack.site.state.view()) === baselineState,
          "all group browser work left golden-site state unchanged",
        );
        const failedChecks = Object.entries(phaseOutcomes).flatMap(([phase, checks]) =>
          checks.filter((item) => !item.passed).map((item) => `${phase}: ${item.detail}`),
        );
        if (failedChecks.length > 0) throw new Error(failedChecks.join("; "));
        testCompleted = true;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
    12 * 60_000,
  );
});
