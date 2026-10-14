import { describe, expect, it } from "vitest";
import { probePngBase64 } from "./probe-image.js";
import { toolResultText } from "./tool-result-text.js";

describe("toolResultText (issue #87)", () => {
  it("records an image result of Read as a placeholder, never an empty string or its bytes", () => {
    const data = probePngBase64("1234");
    const text = toolResultText([
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ]);
    expect(text).toBe(`[image: image/png, ${Buffer.from(data, "base64").length} bytes]`);
    expect(text).not.toContain(data.slice(0, 16));
  });

  it("keeps text blocks and orders them with images", () => {
    expect(
      toolResultText([
        { type: "text", text: "before" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\n[image: image/jpeg, 3 bytes]\nafter");
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText([{ type: "image" }])).toBe("[image]");
  });
});
