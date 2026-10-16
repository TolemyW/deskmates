// T3: does a group find its own owner for a request nobody was named for, delegate what it
// cannot do itself and pass the results back (ADR-0005 amendment 2)? Three bots through the
// configured model, none of them scripted with a protocol:
//
//   prices  knows unit prices and nothing else
//   lead    plans and reports, holds no data
//   stock   knows stock counts and nothing else
//
// Each SOUL states a role and a private fact. None says who answers, who stays silent or whom
// to ask: that has to come from the roster and the group norm the platform supplies (or, under
// `walk-v1`, from the in-turn walk alone). The join order puts `prices` first on purpose, so the
// first member offered is not the natural coordinator.
//
//   combine    "what is item K's stock value?" needs the price AND the count: somebody has to
//              get the other half from a teammate. Oracle: a bot posts STOCK_VALUE=425.
//   follow-up  the same thread, right after: "and item M?". Oracle: STOCK_VALUE_M=120. Under
//              owner-v1 the owner of `combine` is offered it first.
//   single     a fresh thread: "how many units of item Q are in stock?" belongs to `stock`, who
//              is offered last. Oracle: STOCK_UNITS_Q=61. This is where a member answering "not
//              mine" in words, instead of passing, ends the offer early. Item Q appears nowhere
//              else: a bot that learned item K's count in the first thread carries it into this
//              one through its memory, which is what the first real run of this file showed.
//
//   relay      a fresh thread, and the one scenario that names a bot: "@lead, what is item R's
//              stock value?". The lead holds no data, so the answer has to come back to it
//              through one teammate or two, possibly through a teammate that asks the other.
//              Oracle: RELAY_VALUE=63. Item R appears nowhere else either.
//
//   everyone   a fresh thread: "@everyone, what is item V's stock value?". Under the parallel arm
//              every member answers on its own; in turn each sees the earlier answers; under
//              `round-v1` a triage picks who works and one closer answers. Oracle:
//              EVERYONE_VALUE=72. Item V appears nowhere else.
//
// The suite runs under whichever routing the stack is given (`DESKMATES_GROUP_ROUTING`), so the
// same file measures `walk-v1`, `owner-v1` and `round-v1` (ADR-0005 amendment 6, proposed). The
// arm of the group-round evaluation (`M2_GROUP_ROUND_ARM`: parallel, in-turn or round-v1) decides
// how the `everyone` scenario is sent; `evals/group-rounds.ts` turns the reports into rows for
// `evals/compare.ts`. No campaign of the three arms has been run. One report per scenario is written whether or
// not the oracle holds: runs offered the request, who took it, delegations by mention, outcome
// notices, the owner, wall time and per-run usage.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread, ThreadMessage } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import {
  GROUP_ROUND_ARM_ENV,
  type GroupRoundArmConfig,
  groupRoundArm,
} from "./support/group-round-arms.js";
import {
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMessages,
  postGroupMessage,
  threadRuns,
} from "./support/m2-group.js";
import type { RunView } from "./support/runs.js";
import { type Stack, groupRoutingOf, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;

const TERMINAL = new Set(["succeeded", "silent", "failed", "cancelled", "stopped"]);
/**
 * Parked on a human: nothing more happens without one, so a thread whose remaining runs are all
 * parked has settled. The first walk-v1 runs parked on an approval for a team-discovery tool and
 * held every later scenario for the full timeout.
 */
const PARKED = new Set(["waiting_approval", "waiting_continuation", "waiting_browser"]);
/** No run changed for this long after everything is terminal: nothing more is coming. */
const QUIET_MS = 15_000;
const SETTLE_TIMEOUT_MS = 9 * 60_000;
const MARKER = "GROUP_OWNER_20260930";

const COMMON = `Use only the messaging tools. Do not browse, run shell commands, read or write
files, or write memory. Never invent a number you were not given: if you need a fact you do not
have, get it from the teammate who has it. Return the required fenced JSON run summary.`;

const SOULS = {
  prices: (name: string) => `# ${name}
You are ${name}, the pricing analyst of a small operations team.
You are the only one who knows the unit price list:
- item K costs 17 per unit
- item M costs 40 per unit
- item R costs 9 per unit
- item V costs 6 per unit
You do not know how many units of anything are in stock.
${COMMON}`,
  lead: (name: string) => `# ${name}
You are ${name}, the team lead of a small operations team. You plan work, split it between the
specialists and give the human the final answer. You hold no price or stock data yourself.
${COMMON}`,
  stock: (name: string) => `# ${name}
You are ${name}, the stock keeper of a small operations team.
You are the only one who knows the stock counts:
- item K: 25 units in stock
- item M: 3 units in stock
- item Q: 61 units in stock
- item R: 7 units in stock
- item V: 12 units in stock
You do not know any price.
${COMMON}`,
};

const ROLES = {
  prices: "pricing analyst: knows the unit price of every item",
  lead: "team lead: plans the work, splits it between specialists, reports the final answer",
  stock: "stock keeper: knows how many units of every item are in stock",
};

type Scenario = "combine" | "follow-up" | "single" | "relay" | "everyone";

interface ScenarioReport {
  scenario: Scenario;
  routing: string;
  /** The group-round evaluation arm (ADR-0005 amendment 6, decision 52). */
  arm: string;
  passed: boolean;
  error?: string;
  model: string;
  image: string;
  request: string;
  expected: string;
  answered: boolean;
  answeredBy: string | null;
  wallMs: number;
  msToAnswer: number | null;
  /** Time to the first bot message after the request, whatever it says. */
  msToFirstReply: number | null;
  /** Bot messages after the request: duplicates show here before a judge reads them. */
  botMessages: number;
  /** Round triage jobs the request started (`round-v1` only). */
  triageRuns: number;
  /** Cap and loop-breaker notices in the thread after the request. */
  capBreaches: number;
  ownerAfter: string | null;
  /** Runs whose trigger is the human request, in creation order. */
  offered: { bot: string; status: string }[];
  takenBy: string | null;
  totalRuns: number;
  silentRuns: number;
  failedRuns: number;
  /** Runs left waiting for a human (an approval nobody was there to give). */
  parkedRuns: number;
  /** Tools a run asked approval for, from the approval cards in the thread. */
  approvalsAsked: string[];
  /** Bot messages that mention another member: work handed to a teammate. */
  delegations: { from: string; to: string[]; seq: number }[];
  outcomeNotices: number;
  nobodyRepliedNotice: boolean;
  runs: {
    bot: string;
    status: string;
    triggerSeq: number | null;
    error?: string;
    usage: unknown[];
  }[];
  messages: { seq: number; authorKind: string; author: string; body: string }[];
}

async function settle(stack: Stack, thread: Thread, minimumRuns: number): Promise<RunView[]> {
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
    if (
      runs.length >= minimumRuns &&
      runs.every((run) => TERMINAL.has(run.status) || PARKED.has(run.status))
    ) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= QUIET_MS) return runs;
    }
    if (Date.now() > deadline) return runs;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe.skipIf(skip)(`group owner acceptance${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;
  let bots: BotDefinition[];
  let names: Map<string, string>;
  let shared: Thread;
  let arm: GroupRoundArmConfig;

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({ ...modelEnv(), label: "m3-group-owner", botName: "g_bootstrap" });
    stack.config.maxTurns = 8;
    stack.config.runTimeoutSeconds = 180;
    arm = groupRoundArm(process.env[GROUP_ROUND_ARM_ENV], groupRoutingOf(stack));
    // Join order is the order of this list: the pricing analyst is offered first.
    bots = [];
    for (const key of ["prices", "lead", "stock"] as const) {
      bots.push(
        await createGroupBot(stack, {
          name: `g_${key}`,
          role: ROLES[key],
          soul: SOULS[key](`g_${key}`),
        }),
      );
    }
    names = new Map(bots.map((bot) => [bot.id, bot.name]));
    shared = await createGroupThread(stack, bots, "operations team");
  }, 180_000);

  afterAll(async () => {
    await stopStack(stack);
  }, 120_000);

  async function observe(
    scenario: Scenario,
    thread: Thread,
    request: string,
    expected: string,
    options: { roundMode?: "parallel" | "sequential" } = {},
  ): Promise<ScenarioReport> {
    const started = Date.now();
    const runsBefore = (await threadRuns(stack, thread)).length;
    const posted = await postGroupMessage(stack, thread, request, options);
    const runs = (await settle(stack, thread, runsBefore + 1)).slice(runsBefore);
    const all: ThreadMessage[] = await groupMessages(stack, thread);
    const messages = all.filter((m) => m.seq > posted.message.seq);
    const name = (id: string): string => names.get(id) ?? id;
    const answer = messages.find((m) => m.authorKind === "bot" && m.body.includes(expected));
    const botMessages = messages.filter((m) => m.authorKind === "bot");
    const offered = runs
      .filter((run) => run.triggerRef === posted.message.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const taker = offered.find((run) => messages.some((m) => m.runId === run.id));
    const detail = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
    const seqOf = new Map(all.map((m) => [m.id as string, m.seq]));
    const withUsage = await Promise.all(
      runs.map(async (run) => {
        const response = await stack.api<{ usage: unknown[] }>("GET", `/api/runs/${run.id}`);
        return {
          bot: name(run.botId),
          status: run.status,
          triggerSeq: seqOf.get(run.triggerRef) ?? null,
          ...(run.error ? { error: run.error.slice(0, 200) } : {}),
          usage: response.status === 200 ? response.json.usage : [],
        };
      }),
    );
    return {
      scenario,
      routing: groupRoutingOf(stack),
      arm: arm.arm,
      passed: false,
      model: modelEnv().defaultModel,
      image: process.env.WORKSPACE_IMAGE ?? "",
      request,
      expected,
      answered: answer !== undefined,
      answeredBy: answer ? name(answer.authorId) : null,
      wallMs: Date.now() - started,
      msToAnswer: answer ? Date.parse(answer.ts) - Date.parse(posted.message.ts) : null,
      msToFirstReply: botMessages[0]
        ? Date.parse(botMessages[0].ts) - Date.parse(posted.message.ts)
        : null,
      botMessages: botMessages.length,
      triageRuns: runs.filter((run) => run.config.runType === "round_triage").length,
      capBreaches: messages.filter(
        (m) =>
          m.authorKind === "system" &&
          /^(turn budget reached|relay cap reached|loop breaker tripped)/.test(m.body),
      ).length,
      ownerAfter: detail.json.thread.ownerBotId ? name(detail.json.thread.ownerBotId) : null,
      offered: offered.map((run) => ({ bot: name(run.botId), status: run.status })),
      takenBy: taker ? name(taker.botId) : null,
      totalRuns: runs.length,
      silentRuns: runs.filter((run) => run.status === "silent").length,
      failedRuns: runs.filter((run) => run.status === "failed").length,
      parkedRuns: runs.filter((run) => PARKED.has(run.status)).length,
      approvalsAsked: messages
        .filter((m) => m.authorKind === "system" && m.body.startsWith("Approval needed:"))
        .map((m) => m.body.slice(0, 120)),
      delegations: messages
        .filter((m) => m.authorKind === "bot" && m.mentions.some((x) => x.kind === "bot"))
        .map((m) => ({
          from: name(m.authorId),
          to: m.mentions.flatMap((x) => (x.kind === "bot" ? [name(x.botId)] : [])),
          seq: m.seq,
        })),
      outcomeNotices: messages.filter(
        (m) => m.authorKind === "system" && m.body.startsWith("Delegation outcome:"),
      ).length,
      nobodyRepliedNotice: messages.some(
        (m) => m.authorKind === "system" && m.body.startsWith("No member replied"),
      ),
      runs: withUsage,
      messages: messages.map((m) => ({
        seq: m.seq,
        authorKind: m.authorKind,
        author: m.authorKind === "bot" ? name(m.authorId) : m.authorKind,
        body: m.body.slice(0, 500),
      })),
    };
  }

  async function check(
    scenario: Scenario,
    thread: Thread,
    request: string,
    expected: string,
    options: { roundMode?: "parallel" | "sequential" } = {},
  ): Promise<void> {
    let report: ScenarioReport | undefined;
    try {
      report = await observe(scenario, thread, request, expected, options);
      expect(report.failedRuns, "no run failed").toBe(0);
      expect(report.answered, `a bot posted ${expected}`).toBe(true);
      report.passed = true;
    } catch (error) {
      if (report) report.error = String(error).slice(0, 400);
      throw error;
    } finally {
      const output = ensureReportDir(reportDir);
      if (output && report) {
        writeFileSync(
          join(output, `group-owner-${scenario}.json`),
          JSON.stringify(report, null, 2),
        );
      }
    }
  }

  it(
    "combine: a request that needs two specialists is answered with nobody named",
    async () => {
      await check(
        "combine",
        shared,
        `${MARKER} What is the total stock value of item K, that is its unit price times the units in stock? Give the final answer as one line: STOCK_VALUE=<number>`,
        "STOCK_VALUE=425",
      );
    },
    11 * 60_000,
  );

  it(
    "follow-up: the next unaddressed question in the same thread is answered",
    async () => {
      await check(
        "follow-up",
        shared,
        `${MARKER} And the same for item M? Give the final answer as one line: STOCK_VALUE_M=<number>`,
        "STOCK_VALUE_M=120",
      );
    },
    11 * 60_000,
  );

  it(
    "single: a question for the member offered last still reaches it",
    async () => {
      const thread = await createGroupThread(stack, bots, "operations team, second thread");
      await check(
        "single",
        thread,
        `${MARKER} How many units of item Q are in stock? Give the answer as one line: STOCK_UNITS_Q=<number>`,
        "STOCK_UNITS_Q=61",
      );
    },
    11 * 60_000,
  );

  it(
    "relay: a named lead gets the answer back through the teammates who hold the facts",
    async () => {
      const thread = await createGroupThread(stack, bots, "operations team, third thread");
      await check(
        "relay",
        thread,
        `@g_lead ${MARKER} What is the total stock value of item R, that is its unit price times the units in stock? Give the final answer as one line: RELAY_VALUE=<number>`,
        "RELAY_VALUE=63",
      );
    },
    11 * 60_000,
  );

  it(
    "everyone: a request to every member is answered, sent the way the arm says",
    async () => {
      const thread = await createGroupThread(stack, bots, "operations team, fourth thread");
      await check(
        "everyone",
        thread,
        `@everyone ${MARKER} What is the total stock value of item V, that is its unit price times the units in stock? Give the final answer as one line: EVERYONE_VALUE=<number>`,
        "EVERYONE_VALUE=72",
        { roundMode: arm.everyoneRoundMode },
      );
    },
    11 * 60_000,
  );
});
