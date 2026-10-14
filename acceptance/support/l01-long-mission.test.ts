import type { RunEvent, RunId } from "@deskmates/contracts";
import { GoldenSiteState } from "@deskmates/golden-site";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeL01, l2Evidence } from "./l01-long-mission.js";
const ids = ["1003", "1011", "1019", "1027", "1035", "1043"];
const DAY_MS = 86_400_000;
describe("L01 independent grader controls", () => {
  const caseOf = () => {
    const state = new GoldenSiteState();
    const before = structuredClone(state.view());
    const asOf = new Date();
    for (const id of ids) {
      state.commentOnTicket(id, "Overdue", "test");
      state.closeTicket(id, "test");
    }
    return { state, before, asOf };
  };
  afterEach(() => {
    vi.useRealTimers();
  });
  it("accepts exact reference completion", () => {
    const { state, before, asOf } = caseOf();
    expect(
      gradeL01(before, state.view(), [...state.opLog()], ids, "Overdue", asOf).every(
        (c) => c.status === "pass",
      ),
    ).toBe(true);
  });
  it("rejects a missing write, duplicate and collateral edit", () => {
    for (const mutation of ["missing", "duplicate", "collateral"]) {
      const { state, before, asOf } = caseOf();
      if (mutation === "missing") state.data.tickets["1003"]?.comments.pop();
      if (mutation === "duplicate") state.commentOnTicket("1003", "Overdue", "test");
      if (mutation === "collateral") state.closeTicket("1042", "test");
      const failed = gradeL01(before, state.view(), [...state.opLog()], ids, "Overdue", asOf)
        .filter((c) => c.status === "fail")
        .map((c) => c.name);
      if (mutation === "collateral") expect(failed).toContain("no unrelated state changes");
      else expect(failed).toContain("ticket 1003 one comment and closed");
    }
  });
  it("rejects an inverted operation receipt", () => {
    const { state, before, asOf } = caseOf();
    const log = [...state.opLog()];
    const comment = log.find((e) => e.op === "ticket_comment" && e.details.id === "1003");
    const close = log.find((e) => e.op === "ticket_close" && e.details.id === "1003");
    if (!comment || !close) throw new Error("reference receipts missing");
    comment.op = "ticket_close";
    close.op = "ticket_comment";
    expect(gradeL01(before, state.view(), log, ids, "Overdue", asOf)).toContainEqual(
      expect.objectContaining({ name: "ticket 1003 comment before close", status: "fail" }),
    );
  });
  it("marks unavailable evidence unknown", () => {
    const { before, asOf } = caseOf();
    expect(
      gradeL01(before, undefined, undefined, ids, "Overdue", asOf).filter(
        (c) => c.status === "unknown",
      ),
    ).toHaveLength(2);
  });
  // The seed ages the six targets 45 days and every other ticket 5 to 28 days. On a fresh seed
  // the six are the only open bug tickets, so the clock cannot move the set. In a long-lived
  // workspace an earlier task can leave a younger bug ticket open; 1022 is a 26-day bug ticket.
  // Graded days after the agent saw the site, it would cross 30 days and join the set, and the
  // failure would read as a broken seed. Eligibility is judged as of the run's start.
  const withYoungOpenBug = () => {
    const c = caseOf();
    const young = c.before.tickets["1022"];
    if (!young?.tags.includes("bug")) throw new Error("fixture: 1022 is no longer a bug ticket");
    young.status = "open";
    return c;
  };
  it("judges eligibility as of the run's start, not the grading clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = new Date("2026-09-27T00:00:00.000Z");
    vi.setSystemTime(started);
    const { state, before } = withYoungOpenBug();
    vi.setSystemTime(new Date(started.getTime() + 10 * DAY_MS));
    const checks = gradeL01(before, state.view(), [...state.opLog()], ids, "Overdue", started);
    expect(checks.find((c) => c.name === "frozen eligible seed")?.status).toBe("pass");
  });
  it("uses the time it is given: ten days later the 26-day bug ticket is eligible too", () => {
    const { state, before, asOf } = withYoungOpenBug();
    const later = new Date(asOf.getTime() + 10 * DAY_MS);
    const checks = gradeL01(before, state.view(), [...state.opLog()], ids, "Overdue", later);
    expect(checks.find((c) => c.name === "frozen eligible seed")).toEqual({
      name: "frozen eligible seed",
      status: "fail",
      reason: "observed 1003,1011,1019,1022,1027,1035,1043",
    });
  });
});

describe("L01 L2 evidence", () => {
  const event = (seq: number, kind: RunEvent["kind"], payload: Record<string, unknown>): RunEvent =>
    ({ runId: "run_1" as RunId, seq, kind, payload, ts: "2026-09-27T00:00:00.000Z" }) as RunEvent;
  it("finds nothing in a run of L0 and L1 tool calls", () => {
    expect(
      l2Evidence([
        event(1, "tool_call", { toolName: "browser_snapshot", riskLevel: "L0" }),
        event(2, "tool_call", { toolName: "browser_click", riskLevel: "L1" }),
        event(3, "tool_result", { toolName: "browser_click" }),
      ]),
    ).toEqual([]);
  });
  it("reports an approval event", () => {
    expect(l2Evidence([event(4, "approval", { approvalId: "apr_1" })])).toEqual([
      "seq 4: approval",
    ]);
  });
  // A stored Always rule answers an L2 call before any approval is posted, so the approval kind
  // alone does not prove the run made no L2 call. The tool call carries the sidecar's tier.
  it("reports an L2 tool call even when no approval was posted", () => {
    expect(
      l2Evidence([event(7, "tool_call", { toolName: "browser_click", riskLevel: "L2" })]),
    ).toEqual(["seq 7: L2 tool_call browser_click"]);
  });
});
