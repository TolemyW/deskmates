// T0: the error-code guard, and the list it is built from staying exhaustive against the union.

import { describe, expect, it } from "vitest";
import { DeskmatesError, isDeskmatesErrorCode } from "./errors.js";

describe("isDeskmatesErrorCode", () => {
  it("accepts every code a DeskmatesError can carry", () => {
    for (const code of [
      "not_found",
      "invalid_transition",
      "lane_busy",
      "queue_full",
      "egress_blocked",
      "browser_held_by_human",
      "relay_cap_breached",
      "turn_budget_breached",
      "sandbox_unavailable",
      "token_rejected",
      "rate_limited",
      "budget_exceeded",
      "budget_exhausted",
      "validation",
      "forbidden",
      "model_not_selected",
      "payload_too_large",
      "invitation_unusable",
      "memory_rule_refused",
      "connector_unavailable",
      "connector_protocol",
      "connector_validation_missing",
      "connector_validation_stale",
      "connector_validation_wrong_connector",
      "connector_validation_invalid",
      "connector_hash_mismatch",
      "integration_unavailable",
      "integration_connection_not_allowed",
      "integration_not_adopted",
      "integration_protocol",
      "channel_thread_read_only",
    ]) {
      expect(isDeskmatesErrorCode(code), code).toBe(true);
    }
  });

  it("refuses a code-shaped string the union does not define, and non-strings", () => {
    for (const value of [
      "internal",
      "body_too_large",
      "gateway_unavailable",
      "",
      "NOT_FOUND",
      409,
      null,
      undefined,
      {},
    ]) {
      expect(isDeskmatesErrorCode(value), String(value)).toBe(false);
    }
  });

  it("narrows to the union, so a checked body can construct a DeskmatesError without a cast", () => {
    const body: unknown = { code: "invalid_transition", message: "x" };
    const code = (body as { code: unknown }).code;
    if (!isDeskmatesErrorCode(code)) throw new Error("guard rejected a real code");
    expect(new DeskmatesError(code, "x").code).toBe("invalid_transition");
  });
});
