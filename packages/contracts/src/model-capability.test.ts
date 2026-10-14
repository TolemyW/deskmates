// ADR-0023 amendment 2, decision 11: the vision policy a run derives from its recorded capability.
import { describe, expect, it } from "vitest";
import {
  type CapabilityStatus,
  type VisionProbeReason,
  visionPolicyFor,
} from "./model-capability.js";

describe("visionPolicyFor", () => {
  const cases: [CapabilityStatus, VisionProbeReason | null, "deliver" | "withhold"][] = [
    ["supported", "verified_answer", "deliver"],
    ["unsupported", "explicit_refusal", "withhold"],
    ["unknown", "wrong_answer", "withhold"],
    ["unknown", "no_transport_evidence", "deliver"],
    ["unknown", "job_failed", "deliver"],
    ["unknown", "blocked", "deliver"],
    ["unknown", "not_probed", "deliver"],
    ["pending", null, "deliver"],
  ];
  it.each(cases)("%s / %s -> %s", (status, reason, policy) => {
    expect(visionPolicyFor({ status, reason })).toBe(policy);
  });
});
