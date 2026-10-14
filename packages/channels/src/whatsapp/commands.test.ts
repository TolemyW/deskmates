import { describe, expect, it } from "vitest";
import { approvalInstruction, parseApprovalCommand } from "./commands.js";

const TOOL_ID = "3f2a9c1e-8b4d-4e6f-9a0b-1c2d3e4f5a6b";
const CONTINUATION_ID = "approval_0123456789abcdef0123456789abcdef";

describe("approval commands", () => {
  it("reads approve and deny with an optional reason, case-insensitively", () => {
    expect(parseApprovalCommand(`approve ${TOOL_ID}`)).toEqual({
      decision: "allow_once",
      approvalId: TOOL_ID,
    });
    expect(parseApprovalCommand(`  APPROVE ${TOOL_ID}  `)).toEqual({
      decision: "allow_once",
      approvalId: TOOL_ID,
    });
    expect(parseApprovalCommand(`deny ${TOOL_ID} not during business hours`)).toEqual({
      decision: "deny",
      approvalId: TOOL_ID,
      reason: "not during business hours",
    });
    expect(parseApprovalCommand(`reject ${CONTINUATION_ID}`)).toEqual({
      decision: "deny",
      approvalId: CONTINUATION_ID,
    });
    expect(parseApprovalCommand(`allow ${CONTINUATION_ID}`)?.decision).toBe("allow_once");
  });

  it("treats ordinary chat and anything without a real approval id as plain text", () => {
    for (const text of [
      "yes please",
      "no thanks",
      "ok",
      "approve",
      "approve this",
      "approve it now",
      "deny everything",
      `always ${TOOL_ID}`,
      `allow always ${TOOL_ID}`,
      `please approve ${TOOL_ID}`,
      `approve ${TOOL_ID}; deny ${CONTINUATION_ID}`,
      `approve <${TOOL_ID}>`,
      "approve apr_123",
      "",
    ]) {
      expect(parseApprovalCommand(text), text).toBeUndefined();
    }
  });

  it("writes the instruction the sender is asked to copy", () => {
    expect(approvalInstruction(TOOL_ID)).toBe(
      `Reply "approve ${TOOL_ID}" or "deny ${TOOL_ID} [reason]".`,
    );
    expect(parseApprovalCommand(`approve ${TOOL_ID}`)?.approvalId).toBe(TOOL_ID);
  });
});
