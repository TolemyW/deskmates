import { describe, expect, it } from "vitest";
import {
  DEFAULT_M2_BROWSER_SNAPSHOT_MODE,
  selectM2BrowserSnapshotMode,
} from "./m2-browser-snapshot-mode.js";

describe("M2 browser snapshot mode selection", () => {
  it("defaults absent and blank values to explicit-v1", () => {
    expect(DEFAULT_M2_BROWSER_SNAPSHOT_MODE).toBe("explicit-v1");
    expect(selectM2BrowserSnapshotMode(undefined)).toBe("explicit-v1");
    expect(selectM2BrowserSnapshotMode("  ")).toBe("explicit-v1");
  });

  it("accepts only the two versioned modes", () => {
    expect(selectM2BrowserSnapshotMode(" explicit-v1 ")).toBe("explicit-v1");
    expect(selectM2BrowserSnapshotMode("inline-v2")).toBe("inline-v2");
    expect(() => selectM2BrowserSnapshotMode("inline")).toThrow(
      "M2_BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2",
    );
  });
});
