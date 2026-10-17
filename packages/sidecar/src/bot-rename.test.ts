import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BotRenameRoots, renameBotDirectories } from "./bot-rename.js";

let base: string;
let roots: BotRenameRoots;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deskmates-rename-"));
  roots = { homes: join(base, "home"), workdirs: join(base, "work", "bots") };
  mkdirSync(roots.homes, { recursive: true });
  mkdirSync(roots.workdirs, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("bot-rename (ADR-0043 decision 1)", () => {
  it("moves the home and the working directory with their files", () => {
    mkdirSync(join(roots.homes, "nova", "memory"), { recursive: true });
    writeFileSync(join(roots.homes, "nova", "memory", "2026-10-15.md"), "- 09:00 run\n");
    mkdirSync(join(roots.workdirs, "nova"));
    writeFileSync(join(roots.workdirs, "nova", "notes.txt"), "draft");
    expect(renameBotDirectories(roots, { from: "nova", to: "vega" })).toEqual({
      moved: [join(roots.homes, "vega"), join(roots.workdirs, "vega")],
    });
    expect(readFileSync(join(roots.homes, "vega", "memory", "2026-10-15.md"), "utf8")).toBe(
      "- 09:00 run\n",
    );
    expect(readFileSync(join(roots.workdirs, "vega", "notes.txt"), "utf8")).toBe("draft");
    expect(existsSync(join(roots.homes, "nova"))).toBe(false);
  });

  it("moves nothing for a bot that never ran, and replaces an empty target", () => {
    expect(renameBotDirectories(roots, { from: "nova", to: "vega" })).toEqual({ moved: [] });
    mkdirSync(join(roots.homes, "nova"));
    mkdirSync(join(roots.homes, "vega"));
    expect(renameBotDirectories(roots, { from: "nova", to: "vega" }).moved).toEqual([
      join(roots.homes, "vega"),
    ]);
  });

  it("refuses before moving anything when a target holds files", () => {
    mkdirSync(join(roots.homes, "nova"));
    mkdirSync(join(roots.workdirs, "nova"));
    mkdirSync(join(roots.workdirs, "vega"));
    writeFileSync(join(roots.workdirs, "vega", "old.txt"), "someone else's");
    expect(() => renameBotDirectories(roots, { from: "nova", to: "vega" })).toThrow(
      "already exists and is not empty",
    );
    expect(existsSync(join(roots.homes, "nova"))).toBe(true);
    expect(existsSync(join(roots.homes, "vega"))).toBe(false);
  });

  it("refuses a symlinked directory and names outside [A-Za-z0-9_-]", () => {
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(roots.homes, "nova"));
    expect(() => renameBotDirectories(roots, { from: "nova", to: "vega" })).toThrow(
      "not a plain directory",
    );
    for (const request of [
      { from: "../nova", to: "vega" },
      { from: "nova", to: "a/b" },
      { from: "nova", to: "nova" },
      { from: "nova" },
    ])
      expect(() => renameBotDirectories(roots, request)).toThrow("Invalid bot rename request");
  });
});
