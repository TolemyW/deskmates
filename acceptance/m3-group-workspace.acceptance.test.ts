// T3: a group task whose facts live in the shared workspace, not in anyone's SOUL (ADR-0005
// amendment 2, ADR-0004). Three bots share one browser that is already logged in to the golden
// site, one filesystem and one thread. Nobody is named; each SOUL states a role and nothing about
// who answers, who stays silent or whom to ask.
//
//   lead      writes the brief; knows nothing about the console
//   tickets   knows the tickets page
//   kpis      knows the dashboard
//
// The human asks for this week's ops brief as a file plus three facts in the thread. Every fact
// is on a page of the golden site, so the answer has to come out of the shared browser, be passed
// between bots through the thread or the shared file, and land in one place. The oracle is the
// site's own fixture: 23 open tickets, this month's revenue 128450, and the three open tickets
// assigned to zhang (1012, 1024, 1036). Nothing in the workspace says any of this before the run.
//
// What the report records, beyond the group-owner case: which bot visited which page
// (`sitesVisited` from each run's summary), who wrote the file (`filesChanged`), how often a
// run was refused the workspace browser lock, and whether the file matches the thread. It runs under
// whichever routing the stack is given (`DESKMATES_GROUP_ROUTING`). One JSON report is written
// whether or not the oracle holds.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, Thread, ThreadMessage } from "@deskmates/contracts";
import { OPS_ACCOUNT, PASSWORD, SESSION_COOKIE } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import {
  createGroupBot,
  createGroupThread,
  ensureReportDir,
  groupMessages,
  groupRunEvents,
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
const PARKED = new Set(["waiting_approval", "waiting_continuation", "waiting_browser"]);
/** No run changed for this long after everything is terminal or parked: nothing more is coming. */
const QUIET_MS = 20_000;
const SETTLE_TIMEOUT_MS = 12 * 60_000;
const MARKER = "OPS_BRIEF_20261001";
const BRIEF_PATH = "/work/ops-brief.md";

/** The golden site's fixture, which the bots have to read from the pages. */
const EXPECTED = {
  openTickets: "OPEN_TICKETS=23",
  monthRevenue: "MONTH_REVENUE=128450",
  zhangOpen: "ZHANG_OPEN=1012,1024,1036",
};

const COMMON = `Use the shared browser for anything about the console; it is already logged in.
Do not log in again, do not change any data on the site, do not read other bots' home
directories. Never state a number you have not read from a page or been given by a teammate.
Return the required fenced JSON run summary.`;

function souls(origin: string): Record<"lead" | "tickets" | "kpis", (name: string) => string> {
  return {
    lead: (name) => `# ${name}
You are ${name}, the lead of a small operations team. You write the team's briefs under /work
and give the human the final answer. You have never used the operations console yourself and
do not know where anything is on it.
${COMMON}`,
    tickets: (name) => `# ${name}
You are ${name}, the team's ticket analyst. You know the console's tickets page, ${origin}/tickets:
its filters (status, label, assignee, search) and the table of ticket ids, titles, statuses and
assignees. You do not use any other page.
${COMMON}`,
    kpis: (name) => `# ${name}
You are ${name}, the team's KPI analyst. You know the console's dashboard, ${origin}/dashboard:
its cards for open tickets, orders today and this month's revenue. You do not use any other page.
${COMMON}`,
  };
}

const ROLES = {
  lead: "team lead: writes briefs under /work and answers the human; has never used the console",
  tickets: "ticket analyst: knows the console's tickets page and its filters",
  kpis: "KPI analyst: knows the console's dashboard cards",
};

interface WorkspaceReport {
  scenario: "brief";
  routing: string;
  passed: boolean;
  error?: string;
  model: string;
  image: string;
  request: string;
  expected: typeof EXPECTED;
  /** Which of the three facts a bot posted in the thread. */
  posted: Record<keyof typeof EXPECTED, boolean>;
  answeredBy: string | null;
  msToAnswer: number | null;
  wallMs: number;
  /** The brief as written in the workspace, or null when the file does not exist. */
  brief: string | null;
  briefHasAllFacts: boolean;
  ownerAfter: string | null;
  offered: { bot: string; status: string }[];
  takenBy: string | null;
  totalRuns: number;
  silentRuns: number;
  failedRuns: number;
  parkedRuns: number;
  delegations: { from: string; to: string[]; seq: number }[];
  outcomeNotices: number;
  approvalsAsked: string[];
  /** Runs that waited for the shared browser at least once, with the wait count. */
  browserWaits: { bot: string; runId: string; waits: number }[];
  runs: {
    bot: string;
    status: string;
    triggerSeq: number | null;
    sitesVisited: string[];
    filesChanged: string[];
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

describe.skipIf(skip)(`group workspace task acceptance${skipReason(missing, dockerUp)}`, () => {
  let stack: Stack;
  let bots: BotDefinition[];
  let names: Map<string, string>;

  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({
      ...modelEnv(),
      label: "m3-group-workspace",
      botName: "w_bootstrap",
    });
    // Browsing takes turns; the group-owner case's eight would cut a page read short.
    stack.config.maxTurns = 14;
    stack.config.runTimeoutSeconds = 300;
    // One login for the whole group (ADR-0004): the session cookie is placed in the shared
    // browser once, the way a human would log in for the team.
    const session = stack.site.state.login(OPS_ACCOUNT, PASSWORD);
    if (!session) throw new Error("operator login fixture failed");
    expect(stack.site.state.kpis().openTickets).toBe(23);
    expect(stack.site.state.kpis().monthRevenue).toBe(128_450);
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
    // Join order puts the lead last on purpose: the member offered first knows one page and
    // cannot write the brief alone.
    const soul = souls(stack.siteOriginForBot);
    bots = [];
    for (const key of ["tickets", "kpis", "lead"] as const) {
      bots.push(
        await createGroupBot(stack, {
          name: `w_${key}`,
          role: ROLES[key],
          soul: soul[key](`w_${key}`),
        }),
      );
    }
    names = new Map(bots.map((bot) => [bot.id, bot.name]));
  }, 240_000);

  afterAll(async () => {
    await stopStack(stack);
  }, 120_000);

  async function readBrief(): Promise<string | null> {
    const read = await stack.provider.exec(stack.handle, {
      cmd: ["/bin/sh", "-c", `[ -f ${BRIEF_PATH} ] && cat ${BRIEF_PATH}`],
      timeoutMs: 10_000,
    });
    return read.exitCode === 0 ? read.stdout : null;
  }

  async function observe(thread: Thread, request: string): Promise<WorkspaceReport> {
    const started = Date.now();
    const posted = await postGroupMessage(stack, thread, request);
    const runs = await settle(stack, thread, 1);
    const all: ThreadMessage[] = await groupMessages(stack, thread);
    const messages = all.filter((m) => m.seq > posted.message.seq);
    const name = (id: string): string => names.get(id) ?? id;
    const has = (fact: string): ThreadMessage | undefined =>
      messages.find((m) => m.authorKind === "bot" && m.body.includes(fact));
    const answer = messages.find(
      (m) =>
        m.authorKind === "bot" && Object.values(EXPECTED).every((fact) => m.body.includes(fact)),
    );
    const offered = runs
      .filter((run) => run.triggerRef === posted.message.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const taker = offered.find((run) => messages.some((m) => m.runId === run.id));
    const detail = await stack.api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`);
    const seqOf = new Map(all.map((m) => [m.id as string, m.seq]));
    const brief = await readBrief();
    const withDetail = await Promise.all(
      runs.map(async (run) => {
        const response = await stack.api<{ run: RunView; usage: unknown[] }>(
          "GET",
          `/api/runs/${run.id}`,
        );
        const summary = response.status === 200 ? response.json.run.summary : undefined;
        // The hook records a refused browser lock as a `takeover` event with the wait message.
        const events = await groupRunEvents(stack, run);
        const waits = events.filter((event) => event.kind === "takeover").length;
        return {
          bot: name(run.botId),
          status: run.status,
          triggerSeq: seqOf.get(run.triggerRef) ?? null,
          sitesVisited: [...(summary?.sitesVisited ?? [])],
          filesChanged: [...(summary?.filesChanged ?? [])],
          ...(run.error ? { error: run.error.slice(0, 200) } : {}),
          usage: response.status === 200 ? response.json.usage : [],
          waits,
          runId: run.id,
        };
      }),
    );
    return {
      scenario: "brief",
      routing: groupRoutingOf(stack),
      passed: false,
      model: modelEnv().defaultModel,
      image: process.env.WORKSPACE_IMAGE ?? "",
      request,
      expected: EXPECTED,
      posted: {
        openTickets: has(EXPECTED.openTickets) !== undefined,
        monthRevenue: has(EXPECTED.monthRevenue) !== undefined,
        zhangOpen: has(EXPECTED.zhangOpen) !== undefined,
      },
      answeredBy: answer ? name(answer.authorId) : null,
      msToAnswer: answer ? Date.parse(answer.ts) - Date.parse(posted.message.ts) : null,
      wallMs: Date.now() - started,
      brief,
      briefHasAllFacts:
        brief !== null &&
        ["23", "128450", "1012", "1024", "1036"].every((fact) => brief.includes(fact)),
      ownerAfter: detail.json.thread.ownerBotId ? name(detail.json.thread.ownerBotId) : null,
      offered: offered.map((run) => ({ bot: name(run.botId), status: run.status })),
      takenBy: taker ? name(taker.botId) : null,
      totalRuns: runs.length,
      silentRuns: runs.filter((run) => run.status === "silent").length,
      failedRuns: runs.filter((run) => run.status === "failed").length,
      parkedRuns: runs.filter((run) => PARKED.has(run.status)).length,
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
      approvalsAsked: messages
        .filter((m) => m.authorKind === "system" && m.body.startsWith("Approval needed:"))
        .map((m) => m.body.slice(0, 120)),
      browserWaits: withDetail
        .filter((run) => run.waits > 0)
        .map((run) => ({ bot: run.bot, runId: run.runId, waits: run.waits })),
      runs: withDetail.map(({ waits: _waits, runId: _runId, ...run }) => run),
      messages: messages.map((m) => ({
        seq: m.seq,
        authorKind: m.authorKind,
        author: m.authorKind === "bot" ? name(m.authorId) : m.authorKind,
        body: m.body.slice(0, 500),
      })),
    };
  }

  it(
    "brief: three facts from two pages of the shared browser, one file, one answer",
    async () => {
      const thread = await createGroupThread(stack, bots, "operations team");
      let report: WorkspaceReport | undefined;
      try {
        report = await observe(
          thread,
          `${MARKER} Please write this week's ops brief to ${BRIEF_PATH} with three facts from the operations console: the number of open tickets, this month's revenue, and the ids of the open tickets assigned to zhang. When the file is written, post the three facts here, one per line, exactly like this: OPEN_TICKETS=<number>, MONTH_REVENUE=<number without currency or separators>, ZHANG_OPEN=<ids, comma-separated, ascending>.`,
        );
        expect(report.failedRuns, "no run failed").toBe(0);
        expect(report.posted, "all three facts were posted in the thread").toEqual({
          openTickets: true,
          monthRevenue: true,
          zhangOpen: true,
        });
        expect(report.briefHasAllFacts, `the brief holds the facts: ${report.brief}`).toBe(true);
        report.passed = true;
      } catch (error) {
        if (report) report.error = String(error).slice(0, 400);
        throw error;
      } finally {
        const output = ensureReportDir(reportDir);
        if (output && report) {
          writeFileSync(
            join(output, "group-workspace-brief.json"),
            JSON.stringify(report, null, 2),
          );
        }
      }
    },
    15 * 60_000,
  );
});
