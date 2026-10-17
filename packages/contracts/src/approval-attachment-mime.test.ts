import { describe, expect, it } from "vitest";
import { APPROVAL_ATTACHMENT_MIME, isApprovalAttachmentMime } from "./approval.js";

// T0. Thread messages are append-only: an installation that ran under a former product name keeps
// approval links written with that name's vendor segment, and the UI must still draw their cards.
describe("isApprovalAttachmentMime", () => {
  it("accepts the current type", () => {
    expect(isApprovalAttachmentMime(APPROVAL_ATTACHMENT_MIME)).toBe(true);
  });

  it("accepts the type written under any former product name", () => {
    expect(isApprovalAttachmentMime("application/vnd.cogbot.approval+json")).toBe(true);
    expect(isApprovalAttachmentMime("application/vnd.former-name2.approval+json")).toBe(true);
  });

  it("rejects other attachment types", () => {
    expect(isApprovalAttachmentMime("application/vnd.deskmates.handoff+json")).toBe(false);
    expect(isApprovalAttachmentMime("application/json")).toBe(false);
    expect(isApprovalAttachmentMime("application/vnd..approval+json")).toBe(false);
    expect(isApprovalAttachmentMime("application/vnd.Deskmates.approval+json")).toBe(false);
  });
});
