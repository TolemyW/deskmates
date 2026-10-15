import { describe, expect, it } from "vitest";
import { botWorktreeBranch, botWorktreePath, worktreeRepoProblem } from "./workdir-settings.js";

describe("worktreeRepoProblem (ADR-0036 decision 2)", () => {
  it("accepts a plain path under /work", () => {
    expect(worktreeRepoProblem("/work/app")).toBeUndefined();
    expect(worktreeRepoProblem("/work/src/mini-sql_2.0")).toBeUndefined();
  });

  it.each([
    ["relative", "work/app"],
    ["the root itself", "/work"],
    ["the root with a slash", "/work/"],
    ["outside /work", "/home/alice/app"],
    ["a parent segment", "/work/../etc"],
    ["a dot segment", "/work/./app"],
    ["an empty segment", "/work//app"],
    ["a trailing slash", "/work/app/"],
    ["a bot directory", "/work/bots/alice/app"],
    ["the bots root", "/work/bots"],
    ["a space", "/work/my app"],
    ["a shell character", "/work/app;rm"],
    ["too long", `/work/${"a".repeat(200)}`],
  ])("refuses %s", (_label, path) => {
    expect(worktreeRepoProblem(path)).toBeTypeOf("string");
  });
});

describe("bot worktree naming (ADR-0036 decision 4)", () => {
  it("puts the worktree in the bot's directory under the repository's last segment", () => {
    expect(botWorktreePath("alice", "/work/src/app")).toBe("/work/bots/alice/app");
    expect(botWorktreeBranch("alice")).toBe("bots/alice");
  });
});
