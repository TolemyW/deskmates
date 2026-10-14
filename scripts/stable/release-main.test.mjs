// scripts/stable/release-main.sh against a scratch repository with a bare `origin`, a stubbed `gh`
// and no host: tagging, resuming and refusing, without shipping (--no-ship).

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let temp;
let bin;
let work;
let origin;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function stub(name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** `gh run list` answers "<id> <status> <conclusion>" from $RELEASE_RUN. */
function release(state) {
  writeFileSync(join(temp, "release-run"), `${state}\n`);
}

function releaseMain(...args) {
  return releaseMainWith({}, ...args);
}

function releaseMainWith(env, ...args) {
  return spawnSync("bash", [join(work, "scripts/stable/release-main.sh"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_RUN: join(temp, "release-run"),
      GH_ERROR: join(temp, "gh-error"),
      ...env,
    },
  });
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "release-main-"));
  bin = join(temp, "bin");
  origin = join(temp, "origin.git");
  work = join(temp, "work");
  mkdirSync(bin);
  stub("sleep", "exit 0");
  stub(
    "gh",
    `[ "$1 $2" = "run list" ] || { echo "unexpected gh $*" >&2; exit 9; }
[ -f "$GH_ERROR" ] && { cat "$GH_ERROR" >&2; exit 1; }
cat "$RELEASE_RUN"`,
  );
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "remote", "add", "origin", origin);
  mkdirSync(join(work, "scripts/stable"), { recursive: true });
  for (const f of ["release-main.sh", "release-plan.mjs"])
    copyFileSync(join(REPO, "scripts/stable", f), join(work, "scripts/stable", f));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "First release");
  git(work, "tag", "-a", "v0.1.9", "-m", "Release v0.1.9");
  // A pull request merged the way GitHub merges one.
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "a.txt"), "a");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Add a");
  git(work, "checkout", "-q", "main");
  git(
    work,
    "merge",
    "-q",
    "--no-ff",
    "feature",
    "-m",
    "Merge pull request #12 from o/feature",
    "-m",
    "Add the a file",
  );
  git(work, "push", "-q", "origin", "main", "--tags");
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("release-main.sh", () => {
  it("--dry-run names the next patch and its notes and tags nothing", () => {
    const r = releaseMain("--dry-run");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(
      `tagging ${git(work, "rev-parse", "main")} as v0.1.10 (previous v0.1.9)`,
    );
    expect(r.stdout).toContain("- Add the a file (#12)");
    expect(git(work, "tag", "--list", "v0.1.10")).toBe("");
    expect(git(origin, "tag", "--list", "v0.1.10")).toBe("");
  });

  it("tags main, waits for its release workflow, and resumes instead of tagging twice", () => {
    release("41 completed success");
    let r = releaseMain("--no-ship");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("release workflow run 41 passed");
    expect(git(origin, "rev-parse", "v0.1.10^{commit}")).toBe(git(work, "rev-parse", "main"));
    expect(git(origin, "tag", "-l", "--format=%(contents)", "v0.1.10")).toContain(
      "- Add the a file (#12)",
    );

    r = releaseMain("--no-ship");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("is already tagged v0.1.10; resuming");
    expect(git(origin, "tag", "--list", "v0.1.*").split("\n")).toEqual(["v0.1.10", "v0.1.9"]);
  });

  it("stops when the release workflow fails, and refuses a version that already exists", () => {
    release("41 completed failure");
    let r = releaseMain("--no-ship");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("release workflow run 41 for v0.1.10 ended failure");

    writeFileSync(join(work, "b.txt"), "b");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Add b");
    git(work, "push", "-q", "origin", "main");
    r = releaseMain("--version", "v0.1.9", "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("v0.1.9 already exists on origin");
  });

  it("pushes a release tag that exists only locally instead of resuming as if it were released", () => {
    // A tag created by an earlier run whose push failed.
    git(work, "tag", "-a", "v0.1.10", "main", "-m", "Release v0.1.10");
    release("41 completed success");
    const r = releaseMain("--no-ship");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("v0.1.10 exists only locally; pushing it");
    expect(git(origin, "rev-parse", "v0.1.10^{commit}")).toBe(git(work, "rev-parse", "main"));
  });

  it("takes the notes from the nearest released ancestor, not the highest tag", () => {
    // A higher release tag on a commit that is not an ancestor of main.
    git(work, "checkout", "-q", "-b", "hotfix", "v0.1.9");
    writeFileSync(join(work, "h.txt"), "h");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Hotfix");
    git(work, "tag", "-a", "v0.2.0", "-m", "Release v0.2.0");
    git(work, "checkout", "-q", "main");
    git(work, "push", "-q", "origin", "v0.2.0");
    const r = releaseMain("--dry-run");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("as v0.2.1 (previous v0.1.9)");
    expect(r.stdout).toContain("- Add the a file (#12)");
    expect(r.stdout).not.toContain("Hotfix");
  });

  it("refuses to plan notes when no release tag is an ancestor of the commit", () => {
    git(work, "checkout", "-q", "--orphan", "other");
    writeFileSync(join(work, "o.txt"), "o");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "Unrelated");
    git(work, "push", "-q", "--force", "origin", "other:main");
    const r = releaseMain("--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no release tag is an ancestor of");
  });

  it("fails fast with gh's own error when gh cannot list runs", () => {
    release("41 completed success");
    writeFileSync(join(temp, "gh-error"), "HTTP 401: Bad credentials\n");
    const r = releaseMain("--no-ship");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("HTTP 401: Bad credentials");
    expect(r.stderr).not.toContain("did not finish");
  });

  it("says the workflow may still be running, and how to resume, when the wait runs out", () => {
    release("41 in_progress null");
    const r = releaseMainWith({ RELEASE_WAIT_MINUTES: "1" }, "--no-ship");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("may still be running");
    expect(r.stderr).toContain("rerun scripts/stable/release-main.sh");
  });
});
