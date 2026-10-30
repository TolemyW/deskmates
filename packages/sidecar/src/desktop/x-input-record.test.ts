// T0 (ADR-0048 amendment 1, A5): the X input record. Only the reader's raw key press, button
// press and motion events count, never releases, detail lines or non-raw events; an event counts
// towards every call open when it arrives and towards none when no call is open; overlapping
// calls are marked; nothing is kept but counts.

import { describe, expect, it } from "vitest";
import { InputRecorder, rawEventKind } from "./x-input-record.js";

describe("rawEventKind", () => {
  it.each([
    ["EVENT type 13 (RawKeyPress)", "key"],
    ["EVENT type 15 (RawButtonPress)", "button"],
    ["EVENT type 17 (RawMotion)", "motion"],
    ["  EVENT type 13 (RawKeyPress)  ", "key"],
    ["EVENT type 14 (RawKeyRelease)", undefined],
    ["EVENT type 16 (RawButtonRelease)", undefined],
    ["EVENT type 2 (KeyPress)", undefined],
    ["    detail: 38", undefined],
    ["", undefined],
  ])("%j -> %s", (line, kind) => {
    expect(rawEventKind(line)).toBe(kind);
  });
});

describe("InputRecorder", () => {
  it("counts per open call, marks overlap, and drops input while no call is open", () => {
    const recorder = new InputRecorder();
    recorder.line("EVENT type 13 (RawKeyPress)");
    recorder.begin("a");
    recorder.line("EVENT type 13 (RawKeyPress)");
    recorder.begin("b");
    recorder.line("EVENT type 15 (RawButtonPress)");
    expect(recorder.end("a")).toEqual({ keys: 1, buttons: 1, motions: 0, overlapped: true });
    recorder.line("EVENT type 17 (RawMotion)");
    expect(recorder.end("b")).toEqual({ keys: 0, buttons: 1, motions: 1, overlapped: true });
    recorder.begin("c");
    expect(recorder.end("c")).toEqual({ keys: 0, buttons: 0, motions: 0, overlapped: false });
    expect(recorder.end("missing")).toBeUndefined();
  });
});
