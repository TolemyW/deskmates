import type { Approval } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { matchesFixtureApproval } from "./approval.js";
import type { Phase } from "./mission.js";

const phase: Phase = {
  id: "checkout",
  trigger: { kind: "message", text: "place the fixture order" },
  checkpoints: [],
  approval: { decision: "allow_once", holdSeconds: 0, toolName: "browser_click" },
};
const origin = "http://fixture.test:1234";
const approval: Approval = {
  id: "approval_fixture" as Approval["id"],
  botId: "bot_fixture" as Approval["botId"],
  runId: "run_fixture" as Approval["runId"],
  riskLevel: "L2",
  waitMode: "deferred",
  createdAt: "2026-10-19T00:00:00.000Z",
  kind: "tool",
  action: {
    toolName: "mcp__browser__browser_click",
    targetOrigin: origin,
    argumentSummary: "Submit order button",
    input: { element: "Submit order", ref: "e42" },
  },
};
describe("long-horizon fixture approval scope", () => {
  it("matches only the declared fixture checkout action on the declared logical run", () => {
    expect(matchesFixtureApproval(approval, phase, origin, "run_fixture")).toBe(true);
  });
  it.each([
    "other run",
    "other origin",
    "other tool",
    "egress",
    "unmatched description",
    "undeclared",
  ])("refuses %s", (change) => {
    const changed = structuredClone(approval);
    let declaration = structuredClone(phase);
    if (change === "other run") changed.runId = "run_other" as Approval["runId"];
    if (change === "other origin") changed.action.targetOrigin = "http://other.test:1234";
    if (change === "other tool") changed.action.toolName = "Bash";
    if (change === "egress") changed.kind = "egress";
    if (change === "unmatched description") changed.action.argumentSummary = "Delete all orders";
    if (change === "undeclared") declaration = { id: phase.id, checkpoints: [] };
    expect(matchesFixtureApproval(changed, declaration, origin, "run_fixture")).toBe(false);
  });
});
