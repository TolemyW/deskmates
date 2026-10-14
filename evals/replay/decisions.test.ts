import { describe, expect, it } from "vitest";
import { decisionPoints } from "./decisions.js";
import type { TraceEvent } from "./trace.js";

function events(rows: [TraceEvent["kind"], Record<string, unknown>][]): TraceEvent[] {
  return rows.map(([kind, payload], index) => ({
    seq: index + 1,
    kind,
    payload,
    ts: "2026-10-03T00:00:00.000Z",
  }));
}

const call: [TraceEvent["kind"], Record<string, unknown>] = [
  "tool_call",
  { toolUseId: "call-1", toolName: "Bash", input: {}, riskLevel: "L2" },
];
const ask: [TraceEvent["kind"], Record<string, unknown>] = [
  "log",
  {
    source: "pre_tool_use",
    toolUseId: "call-1",
    decision: "ask",
    reason: "egress_ask: docs.example.org is not in the workspace allowlist",
  },
];
const request = (approvalId: string): [TraceEvent["kind"], Record<string, unknown>] => [
  "approval",
  { phase: "requested", approvalId, toolUseId: "call-1" },
];
const decision = (
  approvalId: string,
  value: string,
): [TraceEvent["kind"], Record<string, unknown>] => [
  "approval",
  { phase: "decided", approvalId, decision: value },
];

describe("ADR-0020 egress approval attribution", () => {
  it.each(["deny", "defer"])("records %s as blocked", (value) => {
    const points = decisionPoints(events([call, ask, request("site"), decision("site", value)]));
    expect(points[0]?.egress).toBe("blocked");
  });

  it.each(["allow", "allow_always"])("records %s as allowed", (value) => {
    const points = decisionPoints(events([call, ask, request("site"), decision("site", value)]));
    expect(points[0]?.egress).toBe("allowed");
  });

  it("keeps a pending site ask blocked without a decision", () => {
    expect(decisionPoints(events([call, ask, request("site")]))[0]?.egress).toBe("blocked");
  });

  it("correlates a Gateway decision before the sidecar's batched ask and request", () => {
    const points = decisionPoints(
      events([decision("site", "allow_always"), call, ask, request("site")]),
    );
    expect(points[0]?.egress).toBe("allowed");
  });

  it("does not turn a later unrelated tool denial into an egress block", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        decision("site", "allow_always"),
        request("tool"),
        decision("tool", "deny"),
      ]),
    );
    expect(points[0]).toMatchObject({ egress: "allowed", hookDecision: "deny" });
  });

  it("requires every site ask in a shell call to be allowed", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("first-site"),
        decision("first-site", "allow_always"),
        ask,
        request("second-site"),
        decision("second-site", "deny"),
      ]),
    );
    expect(points[0]?.egress).toBe("blocked");
  });

  it("retains an outright block after an earlier site allowance", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        decision("site", "allow_always"),
        [
          "log",
          {
            source: "pre_tool_use",
            toolUseId: "call-1",
            decision: "deny",
            reason: "egress_blocked: localhost",
          },
        ],
      ]),
    );
    expect(points[0]?.egress).toBe("blocked");
  });

  it("recognises a resumed egress decision without a new requested event", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        [
          "approval",
          { phase: "resumed", approvalId: "site", toolUseId: "call-1", decision: "deny" },
        ],
      ]),
    );
    expect(points[0]?.egress).toBe("blocked");
  });
  it("preserves allowed egress on an earlier occurrence when an unrelated tool approval resumes", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        decision("site", "allow"),
        request("tool"),
        ["approval", { phase: "deferred", approvalId: "tool", toolUseId: "call-1" }],
        call,
        [
          "approval",
          { phase: "resumed", approvalId: "tool", toolUseId: "call-1", decision: "allow" },
        ],
      ]).map((event, index) => ({ ...event, attempt: index < 6 ? 1 : 2 })),
    );
    expect(points.map((point) => point.egress)).toEqual(["allowed", "allowed"]);
  });

  it("does not rewrite a parked occurrence when a later Gateway decision allows the site", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        ["approval", { phase: "deferred", approvalId: "site", toolUseId: "call-1" }],
        decision("site", "allow_always"),
      ]),
    );
    expect(points[0]?.egress).toBe("blocked");
  });

  it("keeps the deferred occurrence blocked and the resumed occurrence allowed with the same id", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        ["approval", { phase: "deferred", approvalId: "site", toolUseId: "call-1" }],
        decision("site", "allow_always"),
        call,
        ask,
        [
          "approval",
          { phase: "resumed", approvalId: "site", toolUseId: "call-1", decision: "allow" },
        ],
      ]).map((event, index) => ({ ...event, attempt: index < 5 ? 1 : 2 })),
    );
    expect(points.map((point) => point.egress)).toEqual(["blocked", "allowed"]);
  });

  it("keeps a failed occurrence blocked despite a later Gateway answer", () => {
    const points = decisionPoints(
      events([
        call,
        ask,
        request("site"),
        ["approval", { phase: "failed", approvalId: "site", toolUseId: "call-1" }],
        decision("site", "allow_always"),
      ]),
    );
    expect(points[0]?.egress).toBe("blocked");
  });
});
