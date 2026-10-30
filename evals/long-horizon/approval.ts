import type { Approval } from "@deskmates/contracts";
import type { Phase } from "./mission.js";

/** Narrow fixture-only automation. Every unmatched request stops the mission for inspection. */
export function matchesFixtureApproval(
  approval: Approval,
  phase: Phase,
  origin: string,
  runId: string,
): boolean {
  return (
    !!phase.approval &&
    approval.runId === runId &&
    (approval.kind ?? "tool") === "tool" &&
    approval.action.toolName.replace(/^mcp__.+?__/, "") === phase.approval.toolName &&
    approval.action.targetOrigin === origin &&
    /(?:submit order|place order)/i.test(approval.action.argumentSummary ?? "")
  );
}
