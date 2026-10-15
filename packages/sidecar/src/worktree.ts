// ADR-0036 decision 4: the bot's own git worktree of the workspace's chosen repository, prepared
// before the query. Tooling, not a boundary: nothing else in the sidecar reads it, and every bot
// can still edit every path. The only program run is the image's preinstalled `git`; the only
// git operations are read-only checks, `worktree prune` and `worktree add`. Nothing here resets,
// cleans, pulls, checks out over, merges or removes a bot's work.

import { execFile } from "node:child_process";
import { botWorkDir, botWorktreeBranch, botWorktreePath } from "@deskmates/contracts";
import type { SidecarFs } from "./deps.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git` with these arguments; never a shell, never another program. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

export const GIT_TIMEOUT_MS = 30_000;

export type WorktreeOutcome =
  | { outcome: "created" | "reused"; path: string; branch: string }
  | { outcome: "failed"; path: string; branch: string; reason: string };

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

export async function prepareWorktree(
  botName: string,
  repo: string,
  deps: { fs: SidecarFs; git?: GitRunner },
): Promise<WorktreeOutcome> {
  const path = botWorktreePath(botName, repo);
  const branch = botWorktreeBranch(botName);
  const fail = (reason: string): WorktreeOutcome => ({ outcome: "failed", path, branch, reason });
  try {
    // A worktree (its `.git` is a file) or a clone the bot made itself: either way, its work.
    if (await deps.fs.exists(`${path}/.git`)) return { outcome: "reused", path, branch };
    const git = deps.git;
    if (!git) return fail("git is not available to the sidecar");
    const probe = await git(["-C", repo, "rev-parse", "--git-dir"]);
    if (probe.code !== 0) return fail(`${repo} is not a git repository`);
    const prune = await git(["-C", repo, "worktree", "prune"]);
    if (prune.code !== 0) return fail(`git worktree prune failed: ${firstLine(prune.stderr)}`);
    const known = await git([
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    await deps.fs.mkdir(botWorkDir(botName));
    const add = await git(
      known.code === 0
        ? ["-C", repo, "worktree", "add", path, branch]
        : ["-C", repo, "worktree", "add", "-b", branch, path],
    );
    if (add.code !== 0) return fail(`git worktree add failed: ${firstLine(add.stderr)}`);
    return { outcome: "created", path, branch };
  } catch (err) {
    return fail(String(err));
  }
}

/** Production `GitRunner`: `execFile`, so arguments are never parsed by a shell. */
export const runGit: GitRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : error.killed ? 124 : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
      },
    );
  });
