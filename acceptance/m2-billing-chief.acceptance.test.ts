// T3 deskbench X01: one repetition for K=5 calibration. A chief discovers today's billing
// tickets in the real site, delegates them across two experts, and reports the derived count.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition, RunEvent, Thread, ThreadMessage } from "@deskmates/contracts";
import {
  OPS_ACCOUNT,
  type OpLogEntry,
  PASSWORD,
  type StateView,
  type Ticket,
} from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import {
  type BillingProtocolDiagnostic,
  analyzeBillingProtocol,
} from "./support/m2-billing-protocol.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  createGroupBot,
  groupMessages,
  groupRunEvents,
  threadRuns,
  waitForGroup,
} from "./support/m2-group.js";
import { type RunView, answerOf } from "./support/runs.js";
import { siteLog, siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { unexpectedChanges } from "./support/state-diff.js";
import { stopStack } from "./support/stop-stack.js";

const image = process.env.WORKSPACE_IMAGE ?? "";
const reportDir = process.env.M2_B3_REPORT_DIR ?? process.env.M2_REPORT_DIR;
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);
const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
const MARKER = "X01_BILLING_20260923";
// K=5 is five independent runner invocations. Each invocation measures the production default.
const TURN_BUDGET = 8;

interface Evidence {
  startedAt: string;
  finishedAt?: string;
  passed: boolean;
  error?: string;
  image: string;
  model: string;
  fixture?: { today: string; targetIds: string[]; source: string };
  before?: StateView;
  after?: StateView;
  unexpectedStateChanges?: string[];
  siteOperations?: OpLogEntry[];
  thread?: Thread;
  messages?: ThreadMessage[];
  runs?: { run: RunView; events: RunEvent[]; usage: unknown[] }[];
  metrics?: {
    botMessagesSinceHuman: number;
    threadPaused: boolean;
    turnBudgetPauseEvents: number;
    runCount: number;
  };
  protocol?: BillingProtocolDiagnostic;
  expertAttribution?: {
    botId: string;
    runId: string | undefined;
    ticketIds: string[];
    loggedComment: string | undefined;
  }[];
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  passed: false,
  image,
  model: modelEnv().defaultModel,
};

function chiefSoul(siteOrigin: string): string {
  return `# x01_billing_chief
You are the chief for deskbench X01 at ${siteOrigin}.
Use the browser to inspect the live Galaxy Ops Console. Log in with ${OPS_ACCOUNT} / ${PASSWORD}.
For the human's ${MARKER} request, find every ticket whose label is billing and whose Created date
is the supplied UTC date. Do not infer the result from ticket titles alone. Call thread_post once
with one message mentioning both @x01_billing_analyst and @x01_billing_reviewer. Partition all
discovered matching tickets between the two experts, give each expert at least one ticket, and
include ${MARKER} and the ticket IDs. Ask each expert to add one useful handling comment per ticket.
Then end the delegation run with an empty reply. Do not comment on tickets yourself.
After both experts report completion for ${MARKER}, verify they handled distinct assigned tickets,
then summarize briefly and put the number handled on the last line as \`answer: <number>\`.
If only one expert result is visible, stay silent. Never delegate or summarize this marker twice.
Return the required fenced JSON run summary.`;
}

function expertSoul(name: string, chief: string, siteOrigin: string): string {
  return `# ${name}
You are a billing-ticket expert for deskbench X01 at ${siteOrigin}.
Use the shared browser session. On a ${MARKER} assignment from @${chief}, handle only the tickets
assigned specifically to you: open each detail page, read it, and add exactly one concise, useful
comment per assigned ticket describing that you reviewed the billing issue and the next action.
Do not change labels, status, assignee, or any other ticket, and do not add a second comment.
After all comments are visibly saved, call thread_post once with exactly
\`@${chief} X01_DONE tickets=<comma-separated actual ticket ids> ${MARKER}\`, then end empty.
Otherwise stay silent. Never handle the same marker twice. Return the required fenced JSON run summary.`;
}

function installFixture(stack: Stack): { today: string; targetIds: string[] } {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tickets = stack.site.state.data.tickets;
  const set = (id: string, input: { title: string; tags: string[]; createdAt: string }) => {
    const ticket = tickets[id];
    if (!ticket) throw new Error(`fixture ticket ${id} is missing from the versioned seed`);
    ticket.title = input.title;
    ticket.tags = input.tags;
    ticket.created_at = `${input.createdAt}T09:00:00.000Z`;
    ticket.updated_at = ticket.created_at;
    ticket.comments = [];
  };
  set("1070", { title: "Card charged twice", tags: ["support", "billing"], createdAt: today });
  set("1071", { title: "Invoice total is wrong", tags: ["support", "billing"], createdAt: today });
  set("1072", {
    title: "Yesterday billing follow-up",
    tags: ["support", "billing"],
    createdAt: yesterday,
  });
  set("1060", { title: "Today non-billing distractor", tags: ["support"], createdAt: today });
  const targetIds = Object.values(tickets)
    .filter((ticket) => ticket.tags.includes("billing") && ticket.created_at.startsWith(today))
    .map((ticket) => ticket.id)
    .sort();
  return { today, targetIds };
}

function botMessageContaining(
  messages: readonly ThreadMessage[],
  text: string,
  predicate: (message: ThreadMessage) => boolean = () => true,
): ThreadMessage {
  const found = messages.find(
    (message) => message.authorKind === "bot" && message.body.includes(text) && predicate(message),
  );
  if (!found) throw new Error(`missing thread message containing ${text}`);
  return found;
}

function ticketWithoutMutableFields(ticket: Ticket): Omit<Ticket, "comments" | "updated_at"> {
  const { comments: _comments, updated_at: _updatedAt, ...stable } = ticket;
  return stable;
}

function inputStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(inputStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(inputStrings);
  }
  return [];
}

function browserToolInputStrings(events: readonly RunEvent[]): string[] {
  return events
    .filter(
      (event) =>
        event.kind === "tool_call" &&
        typeof event.payload.toolName === "string" &&
        event.payload.toolName.includes("browser_"),
    )
    .flatMap((event) => inputStrings(event.payload.input));
}

describe.skipIf(skip)(
  `M2 X01 billing chief (one repetition for the K=5 runner)${skipReason(missing, dockerUp)}`,
  () => {
    let stack: Stack;
    let bots: BotDefinition[] = [];
    let thread: Thread | undefined;
    let logBaseline = 0;

    async function collectLiveEvidence(): Promise<void> {
      if (!stack || !thread) return;
      const finalState = await siteState(stack).catch(() => undefined);
      if (finalState !== undefined) {
        evidence.after = finalState;
        if (evidence.before && evidence.fixture) {
          evidence.unexpectedStateChanges = unexpectedChanges(
            evidence.before,
            finalState,
            evidence.fixture.targetIds.map((id) => `tickets.${id}.comments`),
          );
        }
      }
      evidence.siteOperations = await siteLog(stack)
        .then((entries) => entries.slice(logBaseline))
        .catch(() => []);
      const finalMessages = await groupMessages(stack, thread).catch(() => undefined);
      if (finalMessages !== undefined) evidence.messages = finalMessages;
      const runs = await threadRuns(stack, thread).catch(() => []);
      const runEvidence = await Promise.all(
        runs.map(async (run) => {
          const detail = await stack
            .api<{ run: RunView; usage: unknown[] }>("GET", `/api/runs/${run.id}`)
            .catch(() => undefined);
          return {
            run,
            events: await groupRunEvents(stack, run).catch(() => []),
            usage: detail?.json.usage ?? [],
          };
        }),
      );
      evidence.runs = runEvidence;
      const human = finalMessages?.find((message) => message.authorKind === "human");
      const chief = bots[0];
      if (human && chief && bots.length === 3 && evidence.fixture && finalMessages) {
        evidence.protocol = analyzeBillingProtocol({
          marker: MARKER,
          humanMessageId: human.id,
          chiefBotId: chief.id,
          expertBotIds: bots.slice(1).map((bot) => bot.id),
          expectedTicketIds: evidence.fixture.targetIds,
          expectedDate: evidence.fixture.today,
          messages: finalMessages,
          runs: runEvidence,
        });
      }
      const currentThread = await stack
        .api<{ thread: Thread }>("GET", `/api/threads/${thread.id}`)
        .catch(() => undefined);
      const pauseEvents = runEvidence
        .flatMap((row) => row.events)
        .filter(
          (event) => event.kind === "cap_breached" && event.payload.cap === "turn_budget",
        ).length;
      evidence.metrics = {
        botMessagesSinceHuman:
          finalMessages?.filter((message) => message.authorKind === "bot").length ?? 0,
        threadPaused:
          currentThread?.status === 200 ? currentThread.json.thread.status === "paused" : false,
        turnBudgetPauseEvents: pauseEvents,
        runCount: runs.length,
      };
    }

    beforeAll(async () => {
      requireWorkspaceImageId();
      stack = await startStack({
        ...modelEnv(),
        label: "m2-x01-billing-chief",
        botName: "x01_boot",
      });
      stack.config.browserSnapshotMode = snapshotMode;
      stack.config.maxTurns = 30;
      stack.config.runTimeoutSeconds = 300;
      const fixture = installFixture(stack);
      if (fixture.targetIds.length !== 2) {
        throw new Error(`X01 fixture produced ${fixture.targetIds.length} targets`);
      }
      evidence.fixture = {
        ...fixture,
        source:
          "host-side overlay on the versioned golden-site seed; oracle re-derives by label/date",
      };
      evidence.before = await siteState(stack);
      logBaseline = (await siteLog(stack)).length;
      bots = await Promise.all([
        createGroupBot(stack, {
          name: "x01_billing_chief",
          role: "billing chief",
          soul: chiefSoul(stack.siteOriginForBot),
        }),
        createGroupBot(stack, {
          name: "x01_billing_analyst",
          role: "billing analyst",
          soul: expertSoul("x01_billing_analyst", "x01_billing_chief", stack.siteOriginForBot),
        }),
        createGroupBot(stack, {
          name: "x01_billing_reviewer",
          role: "billing reviewer",
          soul: expertSoul("x01_billing_reviewer", "x01_billing_chief", stack.siteOriginForBot),
        }),
      ]);
      const created = await stack.api<{ thread: Thread }>("POST", "/api/threads", {
        workspaceId: stack.workspace.id,
        botIds: bots.map((bot) => bot.id),
        title: "X01 today's billing tickets",
        turnBudget: TURN_BUDGET,
      });
      if (created.status !== 201) throw new Error(`create X01 thread: ${created.status}`);
      thread = created.json.thread;
      evidence.thread = thread;
    }, 120_000);

    afterAll(async () => {
      try {
        evidence.finishedAt = new Date().toISOString();
        await collectLiveEvidence();
        if (reportDir) {
          mkdirSync(reportDir, { recursive: true });
          const stamp = evidence.startedAt.replace(/[^0-9A-Za-z]+/g, "-");
          writeFileSync(
            join(
              reportDir,
              `m2-billing-chief-${stamp}-${evidence.passed ? "passed" : "failed"}.json`,
            ),
            JSON.stringify(evidence, null, 2),
          );
        }
      } finally {
        await stopStack(stack);
      }
    }, 120_000);

    it(
      "discovers and handles every relevant ticket through a traceable chief round trip",
      async () => {
        try {
          const activeThread = thread as Thread;
          const today = evidence.fixture?.today;
          const before = evidence.before;
          if (!today || !before) throw new Error("fixture evidence is missing");
          const expectedIds = Object.values(before.tickets)
            .filter(
              (ticket) => ticket.tags.includes("billing") && ticket.created_at.startsWith(today),
            )
            .map((ticket) => ticket.id)
            .sort();

          const posted = await stack.api<{ message: ThreadMessage; runs: RunView[] }>(
            "POST",
            `/api/threads/${activeThread.id}/messages`,
            {
              body: `@x01_billing_chief ${MARKER}: Handle all of today's billing tickets. Today is ${today} UTC. Delegate the ticket work to both billing experts, then summarize and answer with the number handled.`,
            },
          );
          expect(posted.status, JSON.stringify(posted.json)).toBe(201);
          expect(posted.json.runs).toHaveLength(1);
          expect(posted.json.runs[0]?.botId).toBe(bots[0]?.id);

          const runs = await waitForGroup(stack, activeThread, 4, 10 * 60_000);
          const messages = await groupMessages(stack, activeThread);
          await collectLiveEvidence();
          const assignment = botMessageContaining(
            messages,
            MARKER,
            (message) => message.mentions.filter((mention) => mention.kind === "bot").length === 2,
          );
          const expertResults = messages.filter(
            (message) => message.authorKind === "bot" && message.body.includes("X01_DONE tickets="),
          );
          const summaries = messages.filter(
            (message) => message.authorId === bots[0]?.id && answerOf(message.body) !== undefined,
          );
          expect(assignment.authorId).toBe(bots[0]?.id);
          expect(assignment.mentions.filter((mention) => mention.kind === "bot")).toHaveLength(2);
          for (const id of expectedIds) expect(assignment.body).toContain(id);
          expect(expertResults).toHaveLength(2);
          expect(summaries).toHaveLength(1);
          const summary = summaries[0] as ThreadMessage;
          expect(answerOf(summary.body)).toBe(String(expectedIds.length));

          const handledIds = expertResults
            .flatMap(
              (message) =>
                /X01_DONE tickets=([0-9, ]+)/
                  .exec(message.body)?.[1]
                  ?.split(",")
                  .map((id) => id.trim()) ?? [],
            )
            .sort();
          expect(handledIds).toEqual(expectedIds);
          expect(new Set(expertResults.map((message) => message.authorId))).toEqual(
            new Set([bots[1]?.id, bots[2]?.id]),
          );
          const expertAssignments = expertResults.map((message) => ({
            message,
            ids:
              /X01_DONE tickets=([0-9, ]+)/
                .exec(message.body)?.[1]
                ?.split(",")
                .map((id) => id.trim()) ?? [],
          }));
          expect(expertAssignments.every(({ ids }) => ids.length === 1)).toBe(true);
          expect(new Set(expertAssignments.flatMap(({ ids }) => ids)).size).toBe(
            expectedIds.length,
          );

          const after = await siteState(stack);
          evidence.after = after;
          expect(
            unexpectedChanges(
              before,
              after,
              expectedIds.map((id) => `tickets.${id}.comments`),
            ),
            "only target comments may change outside session and updated_at",
          ).toEqual([]);
          for (const [id, beforeTicket] of Object.entries(before.tickets)) {
            const afterTicket = after.tickets[id];
            expect(afterTicket, `ticket ${id} disappeared`).toBeDefined();
            if (!afterTicket) continue;
            if (expectedIds.includes(id)) {
              expect(ticketWithoutMutableFields(afterTicket)).toEqual(
                ticketWithoutMutableFields(beforeTicket),
              );
              expect(afterTicket.comments.slice(0, beforeTicket.comments.length)).toEqual(
                beforeTicket.comments,
              );
              expect(afterTicket.comments).toHaveLength(beforeTicket.comments.length + 1);
              expect(afterTicket.comments.at(-1)?.trim().length).toBeGreaterThan(0);
            }
          }
          const businessOps = new Set([
            "ticket_comment",
            "ticket_reassign",
            "ticket_label",
            "ticket_close",
            "order_placed",
          ]);
          const writes = (await siteLog(stack))
            .slice(logBaseline)
            .filter((entry) => businessOps.has(entry.op));
          expect(writes.map((entry) => entry.op)).toEqual(
            Array(expectedIds.length).fill("ticket_comment"),
          );
          expect(writes.map((entry) => String(entry.details.id)).sort()).toEqual(expectedIds);
          evidence.siteOperations = (await siteLog(stack)).slice(logBaseline);

          const chiefRuns = runs.filter((run) => run.botId === bots[0]?.id);
          const initialChief = chiefRuns.find((run) => run.triggerRef === posted.json.message.id);
          const finalChief = chiefRuns.find((run) => run.id === summary.runId);
          expect(initialChief).toBeDefined();
          expect(finalChief).toBeDefined();
          expect(assignment.runId).toBe(initialChief?.id);
          for (const result of expertResults) {
            const expertRun = runs.find((run) => run.id === result.runId);
            expect(expertRun?.triggerRef).toBe(assignment.id);
            expect(expertRun?.botId).toBe(result.authorId);
          }
          expect(expertResults.map((message) => message.id)).toContain(finalChief?.triggerRef);
          expect(summary.seq).toBeGreaterThan(
            Math.max(...expertResults.map((message) => message.seq)),
          );
          expect(runs.every((run) => run.lane === "interactive")).toBe(true);
          expect(runs.every((run) => Object.keys(run.config).length > 0)).toBe(true);

          const runEvidence = await Promise.all(
            runs.map(async (run) => {
              const detail = await stack.api<{ run: RunView; usage: unknown[] }>(
                "GET",
                `/api/runs/${run.id}`,
              );
              expect(detail.status).toBe(200);
              expect(detail.json.usage.length).toBeGreaterThan(0);
              return { run, events: await groupRunEvents(stack, run), usage: detail.json.usage };
            }),
          );
          const initialChiefEvidence = runEvidence.find((row) => row.run.id === initialChief?.id);
          const chiefInputs = browserToolInputStrings(initialChiefEvidence?.events ?? []);
          expect(chiefInputs.some((value) => /add comment/i.test(value))).toBe(false);
          evidence.expertAttribution = expertAssignments.map(({ message, ids }) => ({
            botId: message.authorId,
            runId: message.runId,
            ticketIds: ids,
            loggedComment:
              typeof writes.find((entry) => String(entry.details.id) === ids[0])?.details
                .comment === "string"
                ? String(
                    writes.find((entry) => String(entry.details.id) === ids[0])?.details.comment,
                  )
                : undefined,
          }));
          for (const { message, ids } of expertAssignments) {
            const expertEvidence = runEvidence.find((row) => row.run.id === message.runId);
            expect(
              expertEvidence,
              `missing run evidence for expert message ${message.id}`,
            ).toBeDefined();
            const inputs = browserToolInputStrings(expertEvidence?.events ?? []);
            const id = ids[0] as string;
            const write = writes.find((entry) => String(entry.details.id) === id);
            expect(write, `missing comment operation for expert ticket ${id}`).toBeDefined();
            expect(
              inputs.some((value) => value.includes(`/tickets/${id}`) || value.includes(id)),
            ).toBe(true);
            expect(
              inputs.some((value) => value.includes(String(write?.details.comment))),
              `expert run ${expertEvidence?.run.id} did not submit its logged comment`,
            ).toBe(true);
          }
          for (const write of writes) {
            expect(
              chiefInputs.some((value) => value.includes(String(write.details.comment))),
              "initial chief must not submit a ticket comment",
            ).toBe(false);
          }
          evidence.runs = runEvidence;
          evidence.messages = messages;
          const currentThread = await stack.api<{ thread: Thread }>(
            "GET",
            `/api/threads/${activeThread.id}`,
          );
          expect(currentThread.status).toBe(200);
          const botMessages = messages.filter((message) => message.authorKind === "bot").length;
          const pauseEvents = runEvidence
            .flatMap((row) => row.events)
            .filter(
              (event) => event.kind === "cap_breached" && event.payload.cap === "turn_budget",
            ).length;
          evidence.metrics = {
            botMessagesSinceHuman: botMessages,
            threadPaused: currentThread.json.thread.status === "paused",
            turnBudgetPauseEvents: pauseEvents,
            runCount: runs.length,
          };
          expect(botMessages).toBeLessThanOrEqual(TURN_BUDGET);
          expect(currentThread.json.thread.status).toBe("active");
          expect(pauseEvents).toBe(0);
          evidence.passed = true;
        } catch (error) {
          evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
          throw error;
        }
      },
      12 * 60_000,
    );
  },
);
