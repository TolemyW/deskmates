import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiaryDayView, manageDiary } from "./diary-file.js";

let root: string;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskmates-diary-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function day(name: string, body: string): string {
  mkdirSync(join(root, "nova", "memory"), { recursive: true });
  const path = join(root, "nova", "memory", `${name}.md`);
  writeFileSync(path, body);
  return path;
}

describe("diary (ADR-0043 decision 4)", () => {
  it("lists only YYYY-MM-DD.md day files, newest first", () => {
    expect(manageDiary(root, { op: "list", botName: "nova" })).toEqual({ days: [] });
    day("2026-10-14", "- a\n");
    day("2026-10-15", "- b\n- c\n");
    writeFileSync(join(root, "nova", "memory", "notes.md"), "not a day");
    expect(manageDiary(root, { op: "list", botName: "nova" })).toEqual({
      days: [
        { day: "2026-10-15", bytes: 8 },
        { day: "2026-10-14", bytes: 4 },
      ],
    });
  });

  it("reads a day as lines with its version, and an absent day as empty", () => {
    day("2026-10-15", "- 09:00 run one\n- 10:00 run two\n");
    expect(manageDiary(root, { op: "read", botName: "nova", day: "2026-10-15" })).toEqual({
      day: "2026-10-15",
      lines: ["- 09:00 run one", "- 10:00 run two"],
      version: sha("- 09:00 run one\n- 10:00 run two\n"),
    });
    expect(manageDiary(root, { op: "read", botName: "nova", day: "2026-10-01" })).toEqual({
      day: "2026-10-01",
      lines: [],
      version: sha(""),
    });
  });

  it("deletes exactly the named line, and refuses after the bot appended", () => {
    const path = day("2026-10-15", "- one\n- two\n- three\n");
    const read = manageDiary(root, {
      op: "read",
      botName: "nova",
      day: "2026-10-15",
    }) as DiaryDayView;
    const after = manageDiary(root, {
      op: "delete-line",
      botName: "nova",
      day: "2026-10-15",
      line: 1,
      text: "- two",
      version: read.version,
    }) as DiaryDayView;
    expect(after.lines).toEqual(["- one", "- three"]);
    expect(readFileSync(path, "utf8")).toBe("- one\n- three\n");
    appendFileSync(path, "- four\n");
    expect(() =>
      manageDiary(root, {
        op: "delete-line",
        botName: "nova",
        day: "2026-10-15",
        line: 0,
        text: "- one",
        version: after.version,
      }),
    ).toThrow("changed");
    expect(() =>
      manageDiary(root, {
        op: "delete-line",
        botName: "nova",
        day: "2026-10-15",
        line: 0,
        text: "- three",
        version: sha("- one\n- three\n- four\n"),
      }),
    ).toThrow("changed");
    expect(readFileSync(path, "utf8")).toBe("- one\n- three\n- four\n");
  });

  it("opens nothing outside <bot>/memory and follows no link", () => {
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "2026-10-15.md"), "secret\n");
    mkdirSync(join(root, "nova"));
    symlinkSync(join(root, "elsewhere"), join(root, "nova", "memory"));
    expect(() => manageDiary(root, { op: "list", botName: "nova" })).toThrow("Unsafe");
    unlinkSync(join(root, "nova", "memory"));
    mkdirSync(join(root, "nova", "memory"));
    symlinkSync(
      join(root, "elsewhere", "2026-10-15.md"),
      join(root, "nova", "memory", "2026-10-15.md"),
    );
    expect(() => manageDiary(root, { op: "read", botName: "nova", day: "2026-10-15" })).toThrow(
      "regular file",
    );
    for (const request of [
      { op: "read", botName: "../nova", day: "2026-10-15" },
      { op: "read", botName: "nova", day: "../../etc/passwd" },
      { op: "write", botName: "nova" },
    ])
      expect(() => manageDiary(root, request)).toThrow("Invalid");
  });
});
