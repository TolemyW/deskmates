import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS_DIR,
  checkMigrationOrder,
  migrationChanges,
  runCheck,
} from "./check-migration-order.mjs";

const NOW = new Date("2026-10-13T14:20:00Z");

describe("checkMigrationOrder (ADR-0030 decisions 2, 3 and 5)", () => {
  const target = ["0001-init.sql", "0056-last-legacy.sql", "202610131200-main.sql"];

  it("passes new timestamped migrations that sort after the target's newest", () => {
    expect(
      checkMigrationOrder({
        target,
        added: ["202610131300-a.sql", "202610131301-b.sql"],
        removed: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("passes a branch with no migrations, and needs no reservation input", () => {
    expect(checkMigrationOrder({ target, added: [], removed: [] })).toEqual([]);
    expect(checkMigrationOrder({ target: [], added: ["202610131300-a.sql"], removed: [] })).toEqual(
      [],
    );
  });

  it("fails a migration that sorts at or before the target's newest and says to re-timestamp", () => {
    const errors = checkMigrationOrder({
      target,
      added: ["202610131100-early.sql", "202610131200-main.sql", "202610131300-ok.sql"],
      removed: [],
      now: NOW,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("202610131100-early.sql");
    expect(errors[0]).toContain("202610131200-main.sql");
    expect(errors[0]).toContain("re-timestamp");
    expect(errors[0]).toContain("202610131420-early.sql");
  });

  it("suggests a timestamp after the target's newest even when the clock is behind it", () => {
    const [error] = checkMigrationOrder({
      target: ["202610131500-main.sql"],
      added: ["202610131400-early.sql"],
      removed: [],
      now: NOW,
    });
    expect(error).toContain("202610131501-early.sql");
  });

  it("fails a new legacy-numbered migration and a name the loader would ignore", () => {
    const errors = checkMigrationOrder({
      target,
      added: ["0057-reserved.sql", "2026101314-short.sql", "notes.md"],
      removed: [],
      now: NOW,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("0057-reserved.sql");
    expect(errors[0]).toContain("YYYYMMDDHHmm");
    expect(errors[1]).toContain("2026101314-short.sql");
  });

  it("fails a rename or deletion of a migration that is on the target", () => {
    const errors = checkMigrationOrder({
      target,
      added: ["202610131300-init.sql"],
      removed: ["0001-init.sql"],
      now: NOW,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("0001-init.sql");
    expect(errors[0]).toContain("never rename or delete");
  });

  it("allows legacy deletions only beside a baseline (ADR-0031 decision 1)", () => {
    expect(
      checkMigrationOrder({
        target,
        added: ["202610131300-baseline.sql"],
        removed: ["0001-init.sql", "0056-last-legacy.sql"],
        now: NOW,
      }),
    ).toEqual([]);
    // Without a baseline the same deletions still fail.
    expect(
      checkMigrationOrder({ target, added: [], removed: ["0001-init.sql"], now: NOW }),
    ).toHaveLength(1);
  });

  it("still refuses deleting a timestamped migration, baseline or not", () => {
    const errors = checkMigrationOrder({
      target,
      added: ["202610131300-baseline.sql"],
      removed: ["202610131200-main.sql"],
      now: NOW,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("202610131200-main.sql");
  });
});

describe("check against a git repository", () => {
  let repo;
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const add = (name) => {
    writeFileSync(join(repo, MIGRATIONS_DIR, name), "SELECT 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", `add ${name}`);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "migration-order-"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, MIGRATIONS_DIR), { recursive: true });
    add("0001-init.sql");
    add("0002-second.sql");
    git("checkout", "-q", "-b", "feature");
    add("202610131300-feature.sql");
    git("checkout", "-q", "main");
    add("202610131400-main.sql");
    git("checkout", "-q", "feature");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("lists the target's migrations and the branch's additions since the merge base", () => {
    expect(migrationChanges({ cwd: repo, base: "main" })).toEqual({
      target: ["0001-init.sql", "0002-second.sql", "202610131400-main.sql"],
      added: ["202610131300-feature.sql"],
      removed: [],
    });
  });

  it("fails a branch whose migration sorts before one main merged meanwhile, passes after re-timestamping", () => {
    const failed = runCheck({ cwd: repo, base: "main", now: NOW });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join("\n")).toMatch(/202610131300-feature\.sql.*202610131400-main\.sql/);

    renameSync(
      join(repo, MIGRATIONS_DIR, "202610131300-feature.sql"),
      join(repo, MIGRATIONS_DIR, "202610131500-feature.sql"),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "re-timestamp");
    expect(runCheck({ cwd: repo, base: "main", now: NOW })).toEqual({ ok: true, errors: [] });
  });

  it("fails a branch that renames a migration already on main", () => {
    git("mv", `${MIGRATIONS_DIR}/0002-second.sql`, `${MIGRATIONS_DIR}/202610131500-second.sql`);
    git("commit", "-q", "-m", "rename");
    const result = runCheck({ cwd: repo, base: "main", now: NOW });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("0002-second.sql");
  });

  it("compares a push to main with the previous commit", () => {
    git("checkout", "-q", "main");
    add("202610131500-next.sql");
    expect(runCheck({ cwd: repo, base: "HEAD~1", now: NOW }).ok).toBe(true);
  });

  it("skips a missing base (all-zero SHA of a new ref)", () => {
    expect(runCheck({ cwd: repo, base: "0".repeat(40), now: NOW })).toEqual({
      ok: true,
      errors: [],
      skipped: true,
    });
  });

  it("runs as a command and exits non-zero with the message", () => {
    const script = fileURLToPath(new URL("./check-migration-order.mjs", import.meta.url));
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, "--base", "main"], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toContain("re-timestamp");
  });
});
