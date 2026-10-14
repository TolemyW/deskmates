import { describe, expect, it } from "vitest";
import { integrationApprovalPreview } from "./integration-approval-preview.js";

describe("Drive approval proposal preview", () => {
  it("shows the exact target and outgoing text, redacting credentials before truncation", () => {
    const preview = integrationApprovalPreview(
      "googledrive.files.create",
      {
        parents: ["dedicated-folder"],
        name: "acceptance.txt",
        text: "synthetic text",
        accessToken: "private-value",
        description: "known-private-value",
      },
      ["known-private-value"],
    );
    expect(preview).toMatchObject({
      complete: true,
      target: { parents: ["dedicated-folder"], name: "acceptance.txt" },
    });
    expect(String(preview?.proposedInput)).toContain("synthetic text");
    expect(JSON.stringify(preview)).not.toContain("private-value");
  });
  it("identifies binary content by byte count/hash and marks incomplete text previews", () => {
    const binary = integrationApprovalPreview(
      "googledrive.files.create",
      { contentBase64: "aGVsbG8=" },
      [],
    );
    expect(binary?.proposedInput).toContain('"bytes":5');
    expect(binary?.proposedInput).toContain(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    const large = integrationApprovalPreview(
      "googledrive.files.create",
      { text: "x".repeat(5000), parents: ["target"] },
      [],
    );
    expect(large).toMatchObject({ complete: false, target: { parents: ["target"] } });
    expect(String(large?.proposedInput).length).toBe(4096);
  });
  it("does not add a proposal preview for other providers or malformed inputs", () => {
    expect(integrationApprovalPreview("slack.post_message", {}, [])).toBeUndefined();
    expect(integrationApprovalPreview("googledrive.files.create", [], [])).toBeUndefined();
  });
});
