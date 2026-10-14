import type { RunEvent, ThreadMessage } from "@deskmates/contracts";
import type { RunView } from "./runs.js";

export interface BillingProtocolRunEvidence {
  run: RunView;
  events: readonly RunEvent[];
}

export interface BillingProtocolInput {
  marker: string;
  humanMessageId: string;
  chiefBotId: string;
  expertBotIds: readonly string[];
  expectedTicketIds: readonly string[];
  expectedDate: string;
  messages: readonly ThreadMessage[];
  runs: readonly BillingProtocolRunEvidence[];
}

export interface BillingProtocolRunDiagnostic {
  botId: string;
  runId?: string;
  foundExactlyOne: boolean;
  threadPostCalls: number;
  status?: string;
  summaryReply?: string;
  silentWithEmptyReply: boolean;
  finalReplyDeduplications: number;
  repeatedFinalWasLogicallyDeduplicated: boolean;
}

export interface BillingDiscoveryDiagnostic {
  sufficient: boolean;
  successfulBrowserCalls: number;
  successfulSnapshots: number;
  sawEveryExpectedTicket: boolean;
  sawExpectedDate: boolean;
  sawBillingLabel: boolean;
}

export interface BillingProtocolDiagnostic {
  strictProtocolConformant: boolean;
  assignmentMessageIds: string[];
  exactlyOneAssignment: boolean;
  initialChief: BillingProtocolRunDiagnostic;
  experts: BillingProtocolRunDiagnostic[];
  initialBrowserDiscovery: BillingDiscoveryDiagnostic;
}

function toolName(event: RunEvent): string {
  const raw = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  const match = /^mcp__.+?__(.+)$/.exec(raw);
  return match?.[1] ?? raw;
}

function toolUseId(event: RunEvent): string | undefined {
  return typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : undefined;
}

function threadPostCalls(events: readonly RunEvent[]): number {
  return events.filter((event) => event.kind === "tool_call" && toolName(event) === "thread_post")
    .length;
}

function finalReplyDeduplications(events: readonly RunEvent[]): number {
  return events.filter(
    (event) =>
      event.kind === "log" &&
      event.payload.source === "final_reply" &&
      event.payload.op === "deduplicated",
  ).length;
}

function runDiagnostic(
  botId: string,
  matches: readonly BillingProtocolRunEvidence[],
): BillingProtocolRunDiagnostic {
  const evidence = matches.length === 1 ? matches[0] : undefined;
  const deduplications = finalReplyDeduplications(evidence?.events ?? []);
  const reply = evidence?.run.summary?.reply;
  return {
    botId,
    ...(evidence ? { runId: evidence.run.id, status: evidence.run.status } : {}),
    ...(reply === undefined ? {} : { summaryReply: reply }),
    foundExactlyOne: evidence !== undefined,
    threadPostCalls: threadPostCalls(evidence?.events ?? []),
    silentWithEmptyReply: evidence?.run.status === "silent" && reply?.trim() === "",
    finalReplyDeduplications: deduplications,
    repeatedFinalWasLogicallyDeduplicated: deduplications > 0,
  };
}

function successfulBrowserEvidence(
  evidence: BillingProtocolRunEvidence | undefined,
  expectedTicketIds: readonly string[],
  expectedDate: string,
): BillingDiscoveryDiagnostic {
  const events = evidence?.events ?? [];
  const browserCalls = new Map(
    events
      .filter((event) => event.kind === "tool_call" && toolName(event).startsWith("browser_"))
      .flatMap((event) => {
        const id = toolUseId(event);
        return id ? [[id, toolName(event)] as const] : [];
      }),
  );
  const successful = events.filter((event) => {
    if (event.kind !== "tool_result" || event.payload.isError === true) return false;
    const id = toolUseId(event);
    return id !== undefined && browserCalls.has(id);
  });
  const snapshots = successful.filter((event) => {
    const id = toolUseId(event);
    return id !== undefined && browserCalls.get(id) === "browser_snapshot";
  });
  const observed = snapshots
    .map((event) => (typeof event.payload.content === "string" ? event.payload.content : ""))
    .join("\n");
  const sawEveryExpectedTicket = expectedTicketIds.every((id) => observed.includes(id));
  const sawExpectedDate = expectedDate !== "" && observed.includes(expectedDate);
  const sawBillingLabel = /\bbilling\b/i.test(observed);
  return {
    sufficient:
      successful.length > 0 &&
      snapshots.length > 0 &&
      sawEveryExpectedTicket &&
      sawExpectedDate &&
      sawBillingLabel,
    successfulBrowserCalls: successful.length,
    successfulSnapshots: snapshots.length,
    sawEveryExpectedTicket,
    sawExpectedDate,
    sawBillingLabel,
  };
}

function runConforms(diagnostic: BillingProtocolRunDiagnostic): boolean {
  return (
    diagnostic.foundExactlyOne &&
    diagnostic.threadPostCalls === 1 &&
    diagnostic.silentWithEmptyReply &&
    diagnostic.finalReplyDeduplications === 0
  );
}

/**
 * Offline protocol diagnostics for X01 raw evidence. These facts are deliberately separate from
 * the canonical business oracle: an exact final reply may be logically deduplicated by the
 * Gateway while still violating the fixture's instruction to end with an empty reply.
 */
export function analyzeBillingProtocol(input: BillingProtocolInput): BillingProtocolDiagnostic {
  const expertSet = new Set(input.expertBotIds);
  const initialChiefMatches = input.runs.filter(
    (entry) =>
      entry.run.botId === input.chiefBotId && entry.run.triggerRef === input.humanMessageId,
  );
  const initialChiefRunId =
    initialChiefMatches.length === 1 ? initialChiefMatches[0]?.run.id : undefined;
  const assignmentMessages = input.messages.filter(
    (message) =>
      message.authorKind === "bot" &&
      message.authorId === input.chiefBotId &&
      message.runId === initialChiefRunId &&
      message.body.includes(input.marker) &&
      message.mentions.filter((mention) => mention.kind === "bot").length === expertSet.size &&
      new Set(
        message.mentions
          .filter((mention) => mention.kind === "bot")
          .map((mention) => mention.botId),
      ).size === expertSet.size &&
      message.mentions
        .filter((mention) => mention.kind === "bot")
        .every((mention) => expertSet.has(mention.botId)),
  );
  const assignment = assignmentMessages.length === 1 ? assignmentMessages[0] : undefined;
  const initialChief = runDiagnostic(input.chiefBotId, initialChiefMatches);
  const experts = input.expertBotIds.map((botId) =>
    runDiagnostic(
      botId,
      assignment
        ? input.runs.filter(
            (entry) => entry.run.botId === botId && entry.run.triggerRef === assignment.id,
          )
        : [],
    ),
  );
  const initialBrowserDiscovery = successfulBrowserEvidence(
    initialChiefMatches.length === 1 ? initialChiefMatches[0] : undefined,
    input.expectedTicketIds,
    input.expectedDate,
  );
  const exactlyOneAssignment = assignmentMessages.length === 1;
  return {
    strictProtocolConformant:
      exactlyOneAssignment &&
      runConforms(initialChief) &&
      experts.every(runConforms) &&
      initialBrowserDiscovery.sufficient,
    assignmentMessageIds: assignmentMessages.map((message) => message.id),
    exactlyOneAssignment,
    initialChief,
    experts,
    initialBrowserDiscovery,
  };
}
