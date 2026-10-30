// T0 (ADR-0048 decision 2): the effect labels and literal targets of desktop `js` bodies. The
// labels are recorded, never a tier; scanning compiles and never executes.

import { describe, expect, it } from "vitest";
import {
  desktopCodeEffects,
  desktopCodeTargets,
  desktopLeaseMode,
  desktopToolCode,
} from "./desktop-code-effects.js";

describe("desktopCodeEffects", () => {
  it.each([
    ["const s = await cua.getState(); s.windows", ["read"]],
    ["await cua.screenshot({ window: w })", ["capture"]],
    ["await w.type('héllo 验证 ✅')", ["input"]],
    ["await w.press('ctrl+a')", ["input"]],
    ["await el('Send').click()", ["input send"]],
    ["await el('Delete draft').click()", ["input delete"]],
    ["require('child_process').spawn('gedit')", ["launch"]],
    ["await cua.launchApp('gedit')", ["launch"]],
    ["require('fs').writeFileSync('/work/x', 'y')", ["file"]],
    ["await fetch('https://example.test/')", ["network"]],
    ["await cua.clipboard.write('x')", ["clipboard"]],
    ["eval('cua.' + name + '()')", ["opaque"]],
    ["cua['cl' + 'ick']()", ["opaque"]],
    ["const s = '\\x63lick'", ["opaque"]],
    ["this is not javascript (", ["opaque"]],
  ])("%s -> %j", (code, labels) => {
    expect(desktopCodeEffects(code)).toEqual(labels);
  });

  it("labels missing code opaque and plain arithmetic with nothing", () => {
    expect(desktopCodeEffects(undefined)).toEqual(["opaque"]);
    expect(desktopCodeEffects("  ")).toEqual(["opaque"]);
    expect(desktopCodeEffects("1 + 1")).toEqual([]);
  });

  it("never executes the code it scans", () => {
    const marker = "__desktopScanRan";
    desktopCodeEffects(`globalThis.${marker} = true`);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("combines labels, sorted", () => {
    expect(
      desktopCodeEffects(
        "const s = await cua.getState(); await w.type('x'); await cua.screenshot()",
      ),
    ).toEqual(["capture", "input", "read"]);
  });
});

describe("amendment 1 labels and the shared-screen lease (A2, A3)", () => {
  it.each([
    ["await el('Save').doAction(0)", ["a11y"]],
    ["await field.set_text_contents('héllo')", ["a11y"]],
    [
      "const w = (await cua.getWindows()).find((x) => x.title.includes('Chromium'))",
      ["browser", "read"],
    ],
    ["await cua.focusWindow('Google Chrome')", ["browser"]],
  ])("%s -> %j", (code, labels) => {
    expect(desktopCodeEffects(code)).toEqual(labels);
  });

  it.each([
    ["js", "const s = await cua.getState(); s.windows", "shared"],
    ["js", "await cua.screenshot({ window: w })", "shared"],
    ["js", "const t = await el('Body').getText(); await el('Save').doAction(0)", "shared"],
    ["js_reset", undefined, "shared"],
    ["js", "await w.type('x')", "exclusive"],
    ["js", "const s = await cua.getState(); await el('Send').click()", "exclusive"],
    ["js", "await cua.launchApp('gedit')", "exclusive"],
    ["js", "await cua.clipboard.read()", "exclusive"],
    ["js", "const w = (await cua.getWindows()).find((x) => x.title === 'Chromium')", "exclusive"],
    ["js", "eval(s)", "exclusive"],
    // Nothing the scan can place: fail safe.
    ["js", "await cua.moveMouse(10, 10)", "exclusive"],
    ["js", "1 + 1", "exclusive"],
    ["other", "x", "exclusive"],
  ])("%s %s -> %s", (tool, code, mode) => {
    expect(desktopLeaseMode(tool, code === undefined ? {} : { code })).toBe(mode);
  });
});

describe("desktopCodeTargets", () => {
  it("lists the literal URLs a body names, deduplicated and sorted", () => {
    expect(
      desktopCodeTargets(
        "await fetch('https://b.example.test/x?y=1'); open(\"http://10.0.0.5:8080/\"); fetch('https://b.example.test/x?y=1')",
      ),
    ).toEqual(["http://10.0.0.5:8080/", "https://b.example.test/x?y=1"]);
    expect(desktopCodeTargets("const host = 'a' + '.test'")).toEqual([]);
    expect(desktopCodeTargets(42)).toEqual([]);
  });

  it("reads the code of js only", () => {
    expect(desktopToolCode("js", { code: "x" })).toBe("x");
    expect(desktopToolCode("js_reset", { code: "x" })).toBeUndefined();
  });
});
