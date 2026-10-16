import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sdkInitLog } from "./sdk-init-log.js";

describe("sdkInitLog", () => {
  it("carries the CLI build, the resolved model and the context window (issue #9)", () => {
    expect(
      sdkInitLog({ session_id: "s-1", claude_code_version: "2.1.0", model: "m-large" }, 180000),
    ).toEqual({
      source: "sdk",
      usageSessionFingerprint: createHash("sha256").update("s-1").digest("hex"),
      cliVersion: "2.1.0",
      model: "m-large",
      maxContextTokens: 180000,
    });
  });

  it("omits what the SDK or the environment did not say, never the session fingerprint", () => {
    const log = sdkInitLog({ session_id: "s-2" }, undefined);
    expect(Object.keys(log).sort()).toEqual(["source", "usageSessionFingerprint"]);
    expect(JSON.stringify(log)).not.toContain("s-2");
  });
});
