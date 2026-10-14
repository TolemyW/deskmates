import { describe, expect, it } from "vitest";
import { decidedByReviewer, parseApprovalReview } from "./approval-review.js";

describe("parseApprovalReview (ADR-0002 amendment 4, B4)", () => {
  it("reads each verdict with its reason", () => {
    for (const verdict of ["allow_once", "deny", "escalate"] as const)
      expect(parseApprovalReview(JSON.stringify({ verdict, reason: " why " }))).toEqual({
        verdict,
        reason: "why",
      });
  });

  it("reads a fenced reply", () => {
    expect(
      parseApprovalReview('```json\n{"verdict":"deny","reason":"not asked for"}\n```'),
    ).toEqual({ verdict: "deny", reason: "not asked for" });
  });

  it("refuses Always, unknown verdicts, a missing reason and prose", () => {
    expect(parseApprovalReview('{"verdict":"allow_always","reason":"x"}')).toBeUndefined();
    expect(parseApprovalReview('{"verdict":"allow","reason":"x"}')).toBeUndefined();
    expect(parseApprovalReview('{"verdict":"deny"}')).toBeUndefined();
    expect(parseApprovalReview('{"verdict":"deny","reason":"  "}')).toBeUndefined();
    expect(parseApprovalReview("I would allow this.")).toBeUndefined();
    expect(parseApprovalReview("[1,2]")).toBeUndefined();
    expect(parseApprovalReview("{not json}")).toBeUndefined();
  });

  it("bounds the reason", () => {
    const long = "a".repeat(2000);
    expect(
      parseApprovalReview(JSON.stringify({ verdict: "deny", reason: long }))?.reason,
    ).toHaveLength(500);
  });

  it("labels the decider with the model", () => {
    expect(decidedByReviewer("m-1")).toBe("reviewer:m-1");
  });
});
