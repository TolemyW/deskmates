import {
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunEvent,
  type ThreadMessage,
} from "@deskmates/contracts";
import type { CheckResult, TicketArm } from "./b3-calibration.js";

export type AssessmentStatus = "pass" | "fail" | "unknown";
export interface AssessmentCheck {
  name: string;
  status: AssessmentStatus;
  reason?: string;
}
export interface AssessmentDimension {
  status: AssessmentStatus;
  checks: AssessmentCheck[];
  observedToolErrorCount?: number;
}
export interface M2Assessment {
  businessOutcome: AssessmentDimension;
  executionConstraints: AssessmentDimension;
  diagnostics: AssessmentDimension;
}

function dimension(checks: AssessmentCheck[]): AssessmentDimension {
  return {
    status: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "unknown") || checks.length === 0
        ? "unknown"
        : "pass",
    checks,
  };
}

export function aggregateAssessments(
  assessments: readonly (M2Assessment | undefined)[],
): M2Assessment {
  const names = ["businessOutcome", "executionConstraints", "diagnostics"] as const;
  return Object.fromEntries(
    names.map((name) => [
      name,
      dimension(
        assessments.flatMap((assessment, index) =>
          assessment
            ? [{ name: `arm ${index}`, status: assessment[name].status }]
            : [{ name: `arm ${index}`, status: "unknown" as const }],
        ),
      ),
    ]),
  ) as unknown as M2Assessment;
}

function fromCheck(checks: readonly CheckResult[] | undefined, name: string): AssessmentCheck {
  const found = checks?.find((check) => check.name === name);
  return {
    name,
    status: found ? (found.passed ? "pass" : "fail") : "unknown",
    ...(found ? {} : { reason: "required check absent from recorded arm" }),
  };
}

const LOCK_MESSAGES = ["Another run is operating this browser tab.", HUMAN_HOLDS_BROWSER_MESSAGE];

function lockWaitCount(events: readonly RunEvent[]): number {
  return events.filter(
    (event) =>
      event.kind === "tool_result" &&
      LOCK_MESSAGES.some((message) =>
        JSON.stringify(event.payload.content ?? "").includes(message),
      ),
  ).length;
}

/** Preserve the historical oracle in `checks`; this is an additional attribution-aware view. */
export function assessTicketArm(
  arm: TicketArm & { events?: RunEvent[][]; targets?: string[][]; eventsComplete?: boolean },
): M2Assessment {
  const checks = arm.checks;
  const businessOutcome = dimension([
    fromCheck(checks, "requested writes"),
    fromCheck(checks, "unchanged unrelated state"),
  ]);
  const execution = [
    fromCheck(checks, "runtime"),
    fromCheck(checks, "distinct stable targets"),
    ...arm.indices.flatMap((_, index) => [
      fromCheck(checks, `run ${index}: browser-only protocol`),
      fromCheck(checks, `run ${index}: screenshot attribution`),
      {
        name: `run ${index}: own-tab lock wait`,
        status: ((): AssessmentStatus => {
          const events = arm.events?.[index];
          const targets = arm.targets?.[index];
          if (!arm.eventsComplete || !events || !targets) return "unknown";
          const waits = lockWaitCount(events);
          if (waits === 0) return "pass";
          // The wait text alone has no target ID. Even one stable run tab does not establish
          // that this wait was for that tab; keep ownership unresolved.
          return "unknown";
        })(),
        ...(!arm.eventsComplete || !arm.events?.[index] || !arm.targets?.[index]
          ? { reason: "complete run events and tab targets unavailable" }
          : lockWaitCount(arm.events[index] ?? []) > 0
            ? { reason: "wait message has no attributable target ID" }
            : {}),
      },
    ]),
    ...(arm.indices.length === 2 ? [fromCheck(checks, "runs overlap")] : []),
  ];
  const diagnosticChecks = arm.indices.flatMap((_, index) => [
    fromCheck(checks, `run ${index}: tool errors and takeover`),
    {
      name: `run ${index}: lock wait observed`,
      status:
        arm.eventsComplete && arm.events?.[index]
          ? lockWaitCount(arm.events[index] ?? []) > 0
            ? ("fail" as const)
            : ("pass" as const)
          : ("unknown" as const),
    },
  ]);
  return {
    businessOutcome,
    executionConstraints: dimension(execution),
    diagnostics: {
      ...dimension(diagnosticChecks),
      ...(arm.eventsComplete && arm.events?.length === arm.indices.length
        ? {
            observedToolErrorCount: arm.events
              .flat()
              .filter((event) => event.kind === "tool_result" && event.payload.isError === true)
              .length,
          }
        : {}),
    },
  };
}

interface FoundationRun {
  id: string;
  botId: string;
  status: string;
  events: readonly RunEvent[];
  lane?: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
}

export function assessFoundationCase(args: {
  label: string;
  chiefId: string;
  analystId: string;
  reviewerId: string;
  messages: readonly ThreadMessage[];
  runs: readonly FoundationRun[];
  evidenceComplete: boolean;
}): M2Assessment {
  const { label, chiefId, analystId, reviewerId, messages, runs, evidenceComplete } = args;
  if (label.startsWith("chief"))
    return assessChiefExchange({
      marker: label,
      chiefId,
      analystId,
      reviewerId,
      messages,
      runs,
      evidenceComplete,
    });
  const authored = (id: string, token: string) =>
    messages.some(
      (message) =>
        message.authorKind === "bot" &&
        message.authorId === id &&
        message.body.includes(token) &&
        message.body.includes(label),
    );
  const status = (found: boolean): AssessmentStatus =>
    found ? "pass" : evidenceComplete ? "fail" : "unknown";
  const completed =
    runs.length > 0 && runs.every((run) => run.status === "succeeded" || run.status === "silent");
  const completedCheck = { name: "runs completed", status: status(completed) };
  const errorCount = runs
    .flatMap((run) => run.events)
    .filter((item) => item.kind === "tool_result" && item.payload.isError === true).length;
  const diagnostics = {
    ...dimension([
      {
        name: "tool errors",
        status: evidenceComplete
          ? errorCount
            ? ("fail" as const)
            : ("pass" as const)
          : ("unknown" as const),
      },
    ]),
    ...(evidenceComplete ? { observedToolErrorCount: errorCount } : {}),
  };
  if (label.startsWith("ordered")) {
    const botMessages = messages.filter((message) => message.authorKind === "bot");
    const orderedRuns =
      runs.length >= 3 &&
      runs[0]?.botId === chiefId &&
      runs[1]?.botId === analystId &&
      runs[2]?.botId === reviewerId &&
      runs.slice(1, 3).every((run) => run.status === "silent");
    return {
      businessOutcome: dimension([
        { name: "chief ordered answer", status: status(authored(chiefId, "ORDERED_OK")) },
        {
          name: "only chief answered",
          status: status(botMessages.length === 1 && botMessages[0]?.authorId === chiefId),
        },
      ]),
      executionConstraints: dimension([
        completedCheck,
        { name: "ordered silent delivery", status: status(orderedRuns) },
      ]),
      diagnostics,
    };
  }
  if (label.startsWith("parallel")) {
    const peers = [analystId, reviewerId].map((id) => runs.find((run) => run.botId === id));
    const overlap =
      peers.every((run) => run?.startedAt && run.finishedAt) &&
      Math.max(...peers.map((run) => Date.parse(run?.startedAt ?? ""))) <
        Math.min(...peers.map((run) => Date.parse(run?.finishedAt ?? "")));
    return {
      businessOutcome: dimension([
        { name: "analyst parallel answer", status: status(authored(analystId, "ANALYST_OK")) },
        { name: "reviewer parallel answer", status: status(authored(reviewerId, "REVIEWER_OK")) },
      ]),
      executionConstraints: dimension([
        completedCheck,
        { name: "peer runs overlap", status: status(overlap) },
      ]),
      diagnostics,
    };
  }
  if (label.startsWith("direct")) {
    const busAnalyst = runs.some((run) => run.botId === analystId && run.lane === "background");
    const busChiefSilent = runs.some(
      (run) => run.botId === chiefId && run.lane === "background" && run.status === "silent",
    );
    const toolCall = runs.some((run) =>
      run.events.some(
        (item) => item.kind === "tool_call" && JSON.stringify(item.payload).includes("message_bot"),
      ),
    );
    return {
      businessOutcome: dimension([
        { name: "direct result", status: status(authored(analystId, "DIRECT_RESULT:19")) },
        { name: "handoff notice", status: status(authored(chiefId, "HANDOFF_SENT")) },
      ]),
      executionConstraints: dimension([
        completedCheck,
        { name: "background analyst run", status: status(busAnalyst) },
        { name: "chief silent on bus", status: status(busChiefSilent) },
        { name: "message_bot call", status: status(toolCall) },
      ]),
      diagnostics,
    };
  }
  return {
    businessOutcome: dimension([]),
    executionConstraints: dimension([]),
    diagnostics,
  };
}

export function assessChiefExchange(args: {
  marker: string;
  chiefId: string;
  analystId: string;
  reviewerId: string;
  messages: readonly ThreadMessage[];
  runs: readonly FoundationRun[];
  evidenceComplete?: boolean;
}): M2Assessment {
  const { marker, chiefId, analystId, reviewerId, messages, runs, evidenceComplete } = args;
  const authored = (id: string, text: string) =>
    messages.find(
      (message) =>
        message.authorKind === "bot" && message.authorId === id && message.body.includes(text),
    );
  const analyst = authored(analystId, "A_RESULT:42");
  const reviewer = authored(reviewerId, "R_RESULT:54");
  const total = authored(chiefId, "CHIEF_TOTAL:96");
  const chiefRuns = runs.filter((run) => run.botId === chiefId);
  const delegationMessages = messages.filter(
    (message) =>
      message.authorKind === "bot" &&
      message.authorId === chiefId &&
      message.body.includes("17+25") &&
      message.body.includes("9*6") &&
      message.mentions.some((mention) => mention.kind === "bot" && mention.botId === analystId) &&
      message.mentions.some((mention) => mention.kind === "bot" && mention.botId === reviewerId),
  );
  const delegationLogs = chiefRuns.flatMap((run) =>
    run.events.filter(
      (event) =>
        event.kind === "log" &&
        event.payload.source === "thread_post" &&
        typeof event.payload.body === "string" &&
        event.payload.body.includes("@") &&
        event.payload.body.includes("17+25") &&
        event.payload.body.includes("9*6"),
    ),
  );
  const observedDelegation = delegationMessages.length > 0 || delegationLogs.length > 0;
  const observedStatus = (found: boolean): AssessmentStatus =>
    found ? "pass" : evidenceComplete ? "fail" : "unknown";
  const assignment = messages.find(
    (message) =>
      message.authorKind === "bot" &&
      message.authorId === chiefId &&
      message.body.includes("CHIEF_ASSIGN") &&
      message.body.includes(marker),
  );
  return {
    businessOutcome: dimension([
      { name: "analyst answer", status: observedStatus(Boolean(analyst)) },
      { name: "reviewer answer", status: observedStatus(Boolean(reviewer)) },
      { name: "chief total", status: observedStatus(Boolean(total)) },
      {
        name: "total after answers",
        status:
          total && analyst && reviewer
            ? total.seq > Math.max(analyst.seq, reviewer.seq)
              ? "pass"
              : "fail"
            : "unknown",
      },
    ]),
    executionConstraints: dimension([
      {
        name: "delegation observed",
        status: observedDelegation ? "pass" : evidenceComplete ? "fail" : "unknown",
      },
      {
        name: "CHIEF_ASSIGN protocol marker",
        status: assignment ? "pass" : evidenceComplete ? "fail" : "unknown",
      },
      ...[analyst, reviewer, total].map((message, index) => ({
        name: ["analyst marker", "reviewer marker", "total marker"][index] ?? "marker",
        status: (message
          ? message.body.includes(marker)
            ? "pass"
            : "fail"
          : "unknown") as AssessmentStatus,
      })),
      {
        name: "chief run completed",
        status: chiefRuns.length
          ? chiefRuns.every((run) => run.status === "succeeded" || run.status === "silent")
            ? "pass"
            : "fail"
          : "unknown",
      },
    ]),
    diagnostics: dimension([
      {
        name: "delegation provenance",
        status: observedDelegation ? "pass" : evidenceComplete ? "fail" : "unknown",
      },
    ]),
  };
}
