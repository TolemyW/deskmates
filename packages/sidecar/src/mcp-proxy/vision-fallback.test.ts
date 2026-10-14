import { describe, expect, it } from "vitest";
import { VisionFallbackTracker, failedTargetKey } from "./vision-fallback.js";

const missing = (ref: string) => ({
  isError: true,
  content: [
    { type: "text", text: `### Error\nRef ${ref} not found in the current page snapshot.` },
  ],
});
const click = (element: string, ref: string) => ({
  name: "browser_click",
  arguments: { element, ref },
});
const pinnedClick = (target: string, element?: string) => ({
  name: "browser_click",
  arguments: { target, ...(element === undefined ? {} : { element }) },
});

describe("VisionFallbackTracker", () => {
  it("uses the pinned MCP target even when element is omitted", () => {
    const tracker = new VisionFallbackTracker();
    expect(tracker.observe(pinnedClick("e3"), missing("e3"))).toBe(false);
    expect(
      tracker.observe(
        { name: "browser_snapshot", arguments: {} },
        { content: [{ type: "text", text: "fresh snapshot" }] },
      ),
    ).toBe(false);
    expect(tracker.observe(pinnedClick("e3"), missing("e3"))).toBe(true);
    expect(tracker.observe(pinnedClick("e3"), missing("e3"))).toBe(false);
  });

  it("does not conflate different pinned targets or unrelated ref errors", () => {
    const tracker = new VisionFallbackTracker();
    expect(tracker.observe(pinnedClick("e3", "Save"), missing("e3"))).toBe(false);
    expect(tracker.observe(pinnedClick("e4", "Save"), missing("e4"))).toBe(false);
    expect(tracker.observe(pinnedClick("e3", "Save"), missing("e3"))).toBe(false);
    expect(failedTargetKey(pinnedClick("e3"), missing("e4"))).toBeUndefined();
    expect(
      failedTargetKey(pinnedClick("e3"), { ...missing("e3"), isError: false }),
    ).toBeUndefined();
  });

  it("requests vision only after two consecutive failures for the same semantic target", () => {
    const tracker = new VisionFallbackTracker();
    expect(tracker.observe(click("Save", "e3"), missing("e3"))).toBe(false);
    expect(tracker.observe(click("Save", "e9"), missing("e9"))).toBe(true);
    expect(tracker.observe(click("Save", "e10"), missing("e10"))).toBe(false);
  });

  it("resets on success or a different target", () => {
    const tracker = new VisionFallbackTracker();
    expect(tracker.observe(click("Save", "e3"), missing("e3"))).toBe(false);
    expect(tracker.observe(click("Cancel", "e4"), missing("e4"))).toBe(false);
    expect(tracker.observe(click("Save", "e5"), missing("e5"))).toBe(false);
    expect(tracker.observe(click("Save", "e5"), { content: [{ type: "text", text: "ok" }] })).toBe(
      false,
    );
    expect(tracker.observe(click("Save", "e6"), missing("e6"))).toBe(false);
  });

  it("preserves the first failure across the snapshot refresh MCP asks the model to take", () => {
    const tracker = new VisionFallbackTracker();
    expect(tracker.observe(click("Save", "e3"), missing("e3"))).toBe(false);
    expect(
      tracker.observe(
        { name: "browser_snapshot", arguments: {} },
        { content: [{ type: "text", text: "fresh snapshot" }] },
      ),
    ).toBe(false);
    expect(tracker.observe(click("Save", "e9"), missing("e9"))).toBe(true);
  });

  it("does not trigger on unrelated errors or errors without a reviewed target description", () => {
    expect(
      failedTargetKey(click("Save", "e3"), {
        isError: true,
        content: [{ type: "text", text: "Timeout while clicking" }],
      }),
    ).toBeUndefined();
    expect(
      failedTargetKey({ name: "browser_click", arguments: { ref: "e3" } }, missing("e3")),
    ).toBeUndefined();
  });
});
