import type {
  BotId,
  IsoTimestamp,
  MessageId,
  RunEvent,
  RunId,
  ThreadId,
  ThreadMessage,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  type BillingProtocolInput,
  type BillingProtocolRunEvidence,
  analyzeBillingProtocol,
} from "./m2-billing-protocol.js";
import type { RunView } from "./runs.js";

const threadId = "thread" as ThreadId;
const chiefId = "chief" as BotId;
const analystId = "analyst" as BotId;
const reviewerId = "reviewer" as BotId;
const humanMessageId = "human-message" as MessageId;
const assignmentId = "assignment" as MessageId;

function message(
  input: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "body">,
): ThreadMessage {
  return {
    threadId,
    seq: 1,
    authorKind: "bot",
    authorId: chiefId,
    attachments: [],
    mentions: [],
    relayCount: 1,
    ts: "2026-09-23T00:00:00.000Z" as IsoTimestamp,
    ...input,
  };
}

function run(
  id: string,
  botId: BotId,
  triggerRef: string,
  status: RunView["status"] = "silent",
  reply = "",
): RunView {
  return {
    id: id as RunId,
    botId,
    threadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef,
    status,
    attempt: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    config: { model: "test" },
    summary: {
      done: "done",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply,
    },
  };
}

function event(
  runId: string,
  seq: number,
  kind: RunEvent["kind"],
  payload: Record<string, unknown>,
): RunEvent {
  return {
    runId: runId as RunId,
    seq,
    kind,
    payload,
    ts: "2026-09-23T00:00:00.000Z" as IsoTimestamp,
  };
}

function threadPost(runId: string, seq: number): RunEvent {
  return event(runId, seq, "tool_call", {
    toolUseId: `${runId}-post`,
    toolName: "mcp__deskmates__thread_post",
    input: { body: "completion" },
  });
}

function browserDiscovery(runId: string): RunEvent[] {
  return [
    event(runId, 1, "tool_call", {
      toolUseId: "snapshot",
      toolName: "mcp__browser__browser_snapshot",
      input: {},
    }),
    event(runId, 2, "tool_result", {
      toolUseId: "snapshot",
      isError: false,
      content: "Tickets 1070 and 1071; Labels: billing; Created 2026-09-23T09:00:00.000Z",
    }),
  ];
}

function baseInput(over: Partial<BillingProtocolInput> = {}): BillingProtocolInput {
  const assignment = message({
    id: assignmentId,
    body: "@analyst @reviewer X01 marker: 1070 and 1071",
    mentions: [
      { kind: "bot", botId: analystId },
      { kind: "bot", botId: reviewerId },
    ],
    runId: "chief-run" as RunId,
  });
  const runs: BillingProtocolRunEvidence[] = [
    {
      run: run("chief-run", chiefId, humanMessageId),
      events: [...browserDiscovery("chief-run"), threadPost("chief-run", 3)],
    },
    {
      run: run("analyst-run", analystId, assignmentId),
      events: [threadPost("analyst-run", 1)],
    },
    {
      run: run("reviewer-run", reviewerId, assignmentId),
      events: [threadPost("reviewer-run", 1)],
    },
  ];
  return {
    marker: "X01",
    humanMessageId,
    chiefBotId: chiefId,
    expertBotIds: [analystId, reviewerId],
    expectedTicketIds: ["1070", "1071"],
    expectedDate: "2026-09-23",
    messages: [assignment],
    runs,
    ...over,
  };
}

describe("X01 billing protocol offline diagnostics", () => {
  it("recognises one silent delegation, two silent expert posts, and evidenced discovery", () => {
    const input = baseInput();
    input.messages = [
      ...input.messages,
      message({
        id: "chief-summary" as MessageId,
        body: "X01 complete: @analyst and @reviewer handled 2",
        mentions: [
          { kind: "bot", botId: analystId },
          { kind: "bot", botId: reviewerId },
        ],
        runId: "chief-summary-run" as RunId,
      }),
    ];
    const result = analyzeBillingProtocol(input);
    expect(result.strictProtocolConformant).toBe(true);
    expect(result.exactlyOneAssignment).toBe(true);
    expect(result.assignmentMessageIds).toEqual([assignmentId]);
    expect(result.initialBrowserDiscovery.sufficient).toBe(true);
    expect(result.initialChief.threadPostCalls).toBe(1);
    expect(result.experts.every((expert) => expert.silentWithEmptyReply)).toBe(true);
  });

  it("reports an exact final reply dedup separately from logical transcript duplication", () => {
    const input = baseInput();
    const analyst = input.runs.find((entry) => entry.run.botId === analystId);
    if (!analyst) throw new Error("missing analyst fixture");
    analyst.run = run(
      "analyst-run",
      analystId,
      assignmentId,
      "succeeded",
      "@chief X01_DONE tickets=1070 X01",
    );
    analyst.events = [
      threadPost("analyst-run", 1),
      event("analyst-run", 2, "log", {
        source: "final_reply",
        op: "deduplicated",
        messageId: "completion",
      }),
    ];
    const result = analyzeBillingProtocol(input);
    const diagnostic = result.experts.find((expert) => expert.botId === analystId);
    expect(result.strictProtocolConformant).toBe(false);
    expect(diagnostic).toMatchObject({
      threadPostCalls: 1,
      silentWithEmptyReply: false,
      finalReplyDeduplications: 1,
      repeatedFinalWasLogicallyDeduplicated: true,
    });
  });

  it("requires exactly one assignment and successful snapshots with all discovery facts", () => {
    const input = baseInput();
    input.messages = [...input.messages, message({ id: "assignment-2" as MessageId, body: "X01" })];
    const chief = input.runs.find((entry) => entry.run.botId === chiefId);
    if (!chief) throw new Error("missing chief fixture");
    chief.events = [
      event("chief-run", 1, "tool_call", {
        toolUseId: "snapshot",
        toolName: "mcp__browser__browser_snapshot",
      }),
      event("chief-run", 2, "tool_result", {
        toolUseId: "snapshot",
        isError: false,
        content: "Ticket 1070, billing",
      }),
      threadPost("chief-run", 3),
    ];
    const duplicate = input.messages[1] as ThreadMessage;
    duplicate.mentions = [
      { kind: "bot", botId: analystId },
      { kind: "bot", botId: reviewerId },
    ];
    duplicate.authorId = chiefId;
    duplicate.runId = "chief-run" as RunId;
    const result = analyzeBillingProtocol(input);
    expect(result.exactlyOneAssignment).toBe(false);
    expect(result.assignmentMessageIds).toHaveLength(2);
    expect(result.initialBrowserDiscovery).toMatchObject({
      sufficient: false,
      sawEveryExpectedTicket: false,
      sawExpectedDate: false,
      sawBillingLabel: true,
    });
    expect(result.strictProtocolConformant).toBe(false);
  });
});
