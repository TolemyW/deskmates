import { describe, expect, it } from "vitest";
import {
  WORKSPACE_NAME_MAX_UNITS,
  clipWorkspaceName,
  workspaceNameProblem,
  workspaceNameUnits,
} from "./workspace-name.js";

describe("workspace name bound (ADR-0034 decision 1)", () => {
  it("allows 32 Latin units and refuses 33", () => {
    expect(WORKSPACE_NAME_MAX_UNITS).toBe(32);
    expect(workspaceNameProblem("a".repeat(32))).toBeUndefined();
    expect(workspaceNameProblem("a".repeat(33))).toEqual({ code: "too_long", units: 33, max: 32 });
    expect(workspaceNameUnits("web-research 2026")).toBe(17);
  });

  it("counts a Han character as two: 16 pass, 17 fail", () => {
    expect(workspaceNameUnits("研")).toBe(2);
    expect(workspaceNameProblem("研".repeat(16))).toBeUndefined();
    expect(workspaceNameProblem("研".repeat(17))).toMatchObject({ code: "too_long", units: 34 });
  });

  it("weighs mixed names, kana, hangul and fullwidth forms", () => {
    expect(workspaceNameUnits("市场research")).toBe(12);
    expect(workspaceNameUnits("カタカナ")).toBe(8);
    expect(workspaceNameUnits("한국")).toBe(4);
    expect(workspaceNameUnits("ＡＢ")).toBe(4);
    expect(workspaceNameUnits("研究，组")).toBe(8);
    expect(workspaceNameUnits("Привет")).toBe(6);
  });

  it("counts an emoji, a ZWJ sequence and a flag as one wide cluster", () => {
    expect(workspaceNameUnits("🚀")).toBe(2);
    expect(workspaceNameUnits("👩‍💻")).toBe(2);
    expect(workspaceNameUnits("🇨🇳")).toBe(2);
    expect(workspaceNameUnits("ops 🚀")).toBe(6);
  });

  it("counts a letter with combining marks once, the same in NFC and NFD", () => {
    const nfc = "café";
    const nfd = nfc.normalize("NFD");
    expect(nfd.length).toBe(5);
    expect(workspaceNameUnits(nfc)).toBe(4);
    expect(workspaceNameUnits(nfd)).toBe(4);
    expect(workspaceNameUnits(`e${String.fromCodePoint(0x301, 0x302)}`)).toBe(1);
  });

  it("refuses blank names, edge whitespace and control characters", () => {
    expect(workspaceNameProblem("")).toEqual({ code: "blank" });
    expect(workspaceNameProblem("   ")).toEqual({ code: "blank" });
    expect(workspaceNameProblem(" ops")).toEqual({ code: "edge_whitespace" });
    expect(workspaceNameProblem(`ops${String.fromCodePoint(0x3000)}`)).toEqual({
      code: "edge_whitespace",
    });
    expect(workspaceNameProblem("a\nb")).toEqual({ code: "control_character" });
    expect(workspaceNameProblem(`a${String.fromCodePoint(0x2028)}b`)).toEqual({
      code: "control_character",
    });
    expect(workspaceNameProblem("research team, phase 2!")).toBeUndefined();
  });

  it("clips by whole clusters without splitting a wide one", () => {
    expect(clipWorkspaceName(`${"a".repeat(31)}研`)).toBe("a".repeat(31));
    expect(clipWorkspaceName("研".repeat(20))).toBe("研".repeat(16));
  });
});
