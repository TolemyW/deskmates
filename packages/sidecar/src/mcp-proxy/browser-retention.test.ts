import { describe, expect, it } from "vitest";
import { parseRetentionReceipt, retentionCloseCall } from "./browser-retention.js";

describe("browser retention cleanup", () => {
  it("builds fixed code around an inert exact target id", () => {
    const hostile = "target'; throw new Error('injected');//";
    const call = retentionCloseCall(hostile);
    const code = call.arguments.code as string;
    expect(call.name).toBe("browser_run_code_unsafe");
    expect(code).toContain(`const targetId = ${JSON.stringify(hostile)}`);
    expect(code).toContain("targetId === currentId");
    expect(code).toContain("pages.length <= 1");
  });

  it("accepts only an exact host receipt for the requested target", () => {
    const result = (targetId: string, closed: boolean) => ({
      content: [
        {
          type: "text",
          text: `### Result\n${JSON.stringify({ deskmatesRetention: 1, targetId, closed })}`,
        },
      ],
    });
    expect(parseRetentionReceipt(result("old-target", true), "old-target")).toBe("closed");
    expect(parseRetentionReceipt(result("old-target", false), "old-target")).toBe("missing");
    expect(parseRetentionReceipt(result("other-target", true), "old-target")).toBeUndefined();
  });
});
