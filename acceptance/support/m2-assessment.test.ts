import type { RunEvent, ThreadMessage } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  aggregateAssessments,
  assessChiefExchange,
  assessFoundationCase,
  assessTicketArm,
} from "./m2-assessment.js";

const event = (kind: RunEvent["kind"], payload: Record<string, unknown>): RunEvent =>
  ({ kind, payload }) as RunEvent;
const message = (
  authorId: string,
  body: string,
  seq: number,
  mentions: ThreadMessage["mentions"] = [],
): ThreadMessage => ({ authorKind: "bot", authorId, body, seq, mentions }) as ThreadMessage;

function ticket(checkOverrides: Record<string, boolean> = {}, events: RunEvent[][] = [[]]) {
  const names = [
    "runtime",
    "requested writes",
    "unchanged unrelated state",
    "distinct stable targets",
    "run 0: screenshot attribution",
    "run 0: no own-tab lock wait",
    "run 0: browser-only protocol",
    "run 0: tool errors and takeover",
  ];
  return {
    indices: [0],
    checks: names.map((name) => ({ name, passed: checkOverrides[name] ?? true })),
    events,
    targets: [["tab-a"]],
    eventsComplete: true,
  };
}

describe("M2 separated assessment", () => {
  it("reports omitted requested writes without turning clean diagnostics into success", () => {
    const score = assessTicketArm(ticket({ "requested writes": false }));
    expect(score.businessOutcome.status).toBe("fail");
    expect(score.executionConstraints.status).toBe("pass");
    expect(score.diagnostics.status).toBe("pass");
  });

  it("reports unintended writes as business failure", () => {
    const score = assessTicketArm(ticket({ "unchanged unrelated state": false }));
    expect(score.businessOutcome.checks).toContainEqual({
      name: "unchanged unrelated state",
      status: "fail",
    });
  });

  it("keeps recovered tool errors in diagnostics while counting their events", () => {
    const score = assessTicketArm(
      ticket({ "run 0: tool errors and takeover": false }, [
        [event("tool_result", { isError: true })],
      ]),
    );
    expect(score.businessOutcome.status).toBe("pass");
    expect(score.diagnostics.status).toBe("fail");
    expect(score.diagnostics.observedToolErrorCount).toBe(1);
  });

  it("leaves ownership unknown when lock text has no target provenance", () => {
    const score = assessTicketArm(
      ticket({ "run 0: no own-tab lock wait": false, "distinct stable targets": false }, [
        [event("tool_result", { content: "Another run is operating this browser tab." })],
      ]),
    );
    expect(
      score.executionConstraints.checks.find((check) => check.name === "run 0: own-tab lock wait"),
    ).toMatchObject({ status: "unknown", reason: "wait message has no attributable target ID" });
    expect(score.diagnostics.checks).toContainEqual({
      name: "run 0: lock wait observed",
      status: "fail",
    });
    expect(score.executionConstraints.status).toBe("fail"); // stable target itself failed
  });

  it("does not turn absent event lists and checks into a clean sample", () => {
    const score = assessTicketArm({ indices: [0] });
    expect(score.businessOutcome.status).toBe("unknown");
    expect(score.executionConstraints.status).toBe("unknown");
    expect(score.diagnostics.status).toBe("unknown");
    expect(score.diagnostics.observedToolErrorCount).toBeUndefined();
    expect(aggregateAssessments([score, undefined]).businessOutcome.status).toBe("unknown");
  });

  it("keeps a known wait failure separate from unknown state when reads abort", () => {
    const score = assessTicketArm({
      indices: [0],
      checks: [{ name: "runtime", passed: false }],
    });
    expect(score.businessOutcome.status).toBe("unknown");
    expect(score.executionConstraints.status).toBe("fail");
  });

  it("does not count tool errors from a partial event stream", () => {
    const score = assessTicketArm({
      ...ticket({}, [[event("tool_result", { isError: true })]]),
      eventsComplete: false,
    });
    expect(score.diagnostics.observedToolErrorCount).toBeUndefined();
    expect(
      score.executionConstraints.checks.find((check) => check.name === "run 0: own-tab lock wait"),
    ).toMatchObject({
      status: "unknown",
      reason: "complete run events and tab targets unavailable",
    });
  });

  it("separates actual chief delegation from the missing required marker", () => {
    const score = assessChiefExchange({
      marker: "chief2",
      chiefId: "chief",
      analystId: "analyst",
      reviewerId: "reviewer",
      messages: [
        message("chief", "@analyst @reviewer please compute 17+25 and 9*6", 2, [
          { kind: "bot", botId: "analyst" as never },
          { kind: "bot", botId: "reviewer" as never },
        ]),
        message("analyst", "A_RESULT:42 chief2", 3),
        message("reviewer", "R_RESULT:54 chief2", 4),
        message("chief", "CHIEF_TOTAL:96 chief2", 5),
      ],
      runs: [{ id: "r1", botId: "chief", status: "silent", events: [] }],
      evidenceComplete: true,
    });
    expect(score.businessOutcome.status).toBe("pass");
    expect(score.executionConstraints.checks).toContainEqual({
      name: "delegation observed",
      status: "pass",
    });
    expect(score.executionConstraints.checks).toContainEqual({
      name: "CHIEF_ASSIGN protocol marker",
      status: "fail",
    });
  });

  it("does not call a missing assignment proof of no delegation without provenance", () => {
    const score = assessChiefExchange({
      marker: "chief2",
      chiefId: "chief",
      analystId: "analyst",
      reviewerId: "reviewer",
      messages: [],
      runs: [],
    });
    expect(score.executionConstraints.checks).toContainEqual({
      name: "delegation observed",
      status: "unknown",
    });
    expect(score.businessOutcome.status).toBe("unknown");
    expect(score.diagnostics.status).toBe("unknown");
  });

  it("scores ordered replies independently of ordered execution", () => {
    const score = assessFoundationCase({
      label: "ordered1",
      chiefId: "chief",
      analystId: "analyst",
      reviewerId: "reviewer",
      messages: [message("chief", "ORDERED_OK ordered1", 2)],
      runs: [
        { id: "r1", botId: "chief", status: "succeeded", events: [] },
        { id: "r2", botId: "analyst", status: "silent", events: [] },
        { id: "r3", botId: "reviewer", status: "failed", events: [] },
      ],
      evidenceComplete: true,
    });
    expect(score.businessOutcome.status).toBe("pass");
    expect(score.executionConstraints.status).toBe("fail");
  });

  it("keeps a partial foundation transcript unknown", () => {
    const score = assessFoundationCase({
      label: "parallel1",
      chiefId: "chief",
      analystId: "analyst",
      reviewerId: "reviewer",
      messages: [],
      runs: [],
      evidenceComplete: false,
    });
    expect(score.businessOutcome.status).toBe("unknown");
    expect(score.executionConstraints.status).toBe("unknown");
    expect(score.diagnostics.observedToolErrorCount).toBeUndefined();
  });
});
