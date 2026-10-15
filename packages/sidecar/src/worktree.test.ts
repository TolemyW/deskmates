import { describe, expect, it } from "vitest";
import { createMemoryFs } from "./testing/in-memory-fs.js";
import { type GitResult, prepareWorktree } from "./worktree.js";

// ADR-0036 decision 4: which `git` commands the sidecar runs, and which it never builds.
function fakeGit(answers: (args: readonly string[]) => GitResult | undefined = () => undefined) {
  const calls: string[][] = [];
  const git = async (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    return answers(args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}

const FORBIDDEN = ["reset", "clean", "pull", "fetch", "checkout", "merge", "rebase", "remove"];

function expectNoDestructiveArgs(calls: string[][]): void {
  for (const call of calls) for (const word of FORBIDDEN) expect(call).not.toContain(word);
}

describe("prepareWorktree", () => {
  it("reuses a directory that already holds a .git entry without running git", async () => {
    const fs = createMemoryFs({
      "/work/bots/nova/app/.git": "gitdir: /work/app/.git/worktrees/app",
    });
    const { git, calls } = fakeGit();
    const result = await prepareWorktree("nova", "/work/app", { fs, git });
    expect(result).toEqual({ outcome: "reused", path: "/work/bots/nova/app", branch: "bots/nova" });
    expect(calls).toEqual([]);
  });

  it("prunes, then creates a new branch from HEAD when the bot has none", async () => {
    const { git, calls } = fakeGit((args) =>
      args.includes("--verify") ? { code: 1, stdout: "", stderr: "" } : undefined,
    );
    const result = await prepareWorktree("nova", "/work/app", { fs: createMemoryFs({}), git });
    expect(result.outcome).toBe("created");
    expect(calls).toEqual([
      ["-C", "/work/app", "rev-parse", "--git-dir"],
      ["-C", "/work/app", "worktree", "prune"],
      ["-C", "/work/app", "rev-parse", "--verify", "--quiet", "refs/heads/bots/nova"],
      ["-C", "/work/app", "worktree", "add", "-b", "bots/nova", "/work/bots/nova/app"],
    ]);
    expectNoDestructiveArgs(calls);
  });

  it("re-creates a missing directory from the bot's existing branch", async () => {
    const { git, calls } = fakeGit();
    const result = await prepareWorktree("nova", "/work/app", { fs: createMemoryFs({}), git });
    expect(result.outcome).toBe("created");
    expect(calls.at(-1)).toEqual([
      "-C",
      "/work/app",
      "worktree",
      "add",
      "/work/bots/nova/app",
      "bots/nova",
    ]);
    expectNoDestructiveArgs(calls);
  });

  it("fails without throwing when the path is not a repository", async () => {
    const { git, calls } = fakeGit((args) =>
      args.includes("--git-dir")
        ? { code: 128, stdout: "", stderr: "fatal: not a git repo" }
        : undefined,
    );
    const result = await prepareWorktree("nova", "/work/app", { fs: createMemoryFs({}), git });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "/work/app is not a git repository",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports the first line of a failing worktree add", async () => {
    const { git } = fakeGit((args) =>
      args.includes("add")
        ? { code: 128, stdout: "", stderr: "fatal: '/work/bots/nova/app' already exists\nmore" }
        : undefined,
    );
    const result = await prepareWorktree("nova", "/work/app", { fs: createMemoryFs({}), git });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "git worktree add failed: fatal: '/work/bots/nova/app' already exists",
    });
  });

  it("fails when no git runner is available", async () => {
    const result = await prepareWorktree("nova", "/work/app", { fs: createMemoryFs({}) });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "git is not available to the sidecar",
    });
  });
});
