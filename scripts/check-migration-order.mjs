// Dependency-free check that a branch's new Gateway migrations sort after every migration already
// on its target branch (ADR-0030 decision 3), use the timestamped form (decision 1), and do not
// rename or delete a migration the target already has (decision 2).
//
//   node scripts/check-migration-order.mjs [--base <ref>] [--head <ref>]
//
// `--base` defaults to `origin/main`. CI passes `origin/<base branch>` for a pull request and the
// previous commit for a push to main. An all-zero base (a newly created ref) skips the check.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/gateway/migrations";

const LEGACY = /^0\d{3}-[a-z0-9-]+\.sql$/;
const TIMESTAMPED =
  /^(2\d{3})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])([0-5]\d)-([a-z0-9-]+)\.sql$/;

/** `YYYYMMDDHHmm` for a time, in UTC. */
function stamp(date) {
  return date.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

/** A UTC timestamp that sorts after `newest`: now, or one minute after `newest` if that is later. */
function nextStamp(newest, now) {
  const m = newest && TIMESTAMPED.exec(newest);
  if (!m) return stamp(now);
  const after = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + 1));
  return stamp(after > now ? after : now);
}

function slugOf(name) {
  return name.replace(/^\d+-/, "").replace(/\.sql$/, "");
}

/**
 * Errors for a branch's migration changes. `target` is every migration file on the target branch,
 * `added` and `removed` the branch's changes since the merge base (renames appear as both).
 */
export function checkMigrationOrder({ target, added, removed, now = new Date() }) {
  const errors = [];
  const onTarget = new Set(target);
  const newest = [...target].sort().at(-1);
  // The one exception to decision 2 (ADR-0031 decision 1): the change that adds the schema
  // baseline deletes the legacy NNNN- migrations it replaces. Nothing else may be deleted.
  const baseline = added.some((name) => TIMESTAMPED.test(name) && name.endsWith("-baseline.sql"));
  for (const name of [...removed].sort()) {
    if (baseline && LEGACY.test(name)) continue;
    if (onTarget.has(name))
      errors.push(
        `${MIGRATIONS_DIR}/${name} is on the target branch; never rename or delete a migration that may have shipped (ADR-0030 decision 2). Restore it and add a new migration instead.`,
      );
  }
  for (const name of [...added].sort()) {
    if (onTarget.has(name) || !name.endsWith(".sql")) continue;
    const suggestion = `${nextStamp(newest, now)}-${slugOf(name)}.sql`;
    if (LEGACY.test(name)) {
      errors.push(
        `${MIGRATIONS_DIR}/${name} uses a legacy number; new migrations are named YYYYMMDDHHmm-slug.sql in UTC (ADR-0030 decision 1). Rename it, for example to ${suggestion}.`,
      );
    } else if (!TIMESTAMPED.test(name)) {
      errors.push(
        `${MIGRATIONS_DIR}/${name} is not a migration name the Gateway loads; use YYYYMMDDHHmm-slug.sql in UTC (ADR-0030 decision 1), for example ${suggestion}.`,
      );
    } else if (newest && name <= newest) {
      errors.push(
        `${MIGRATIONS_DIR}/${name} sorts at or before ${newest}, the newest migration on the target branch; a database that already applied ${newest} would refuse it; re-timestamp it so it sorts last, for example ${suggestion} (ADR-0030 decision 3).`,
      );
    }
  }
  return errors;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The target's migrations and the branch's migration additions and removals since the merge base. */
export function migrationChanges({ cwd = process.cwd(), base, head = "HEAD" }) {
  const mergeBase = git(cwd, ["merge-base", base, head]).trim();
  const target = git(cwd, ["ls-tree", "--name-only", base, `${MIGRATIONS_DIR}/`])
    .split("\n")
    .filter(Boolean)
    .map(basename)
    .sort();
  const added = [];
  const removed = [];
  const diff = git(cwd, [
    "diff",
    "--name-status",
    "--no-renames",
    mergeBase,
    head,
    "--",
    `${MIGRATIONS_DIR}/`,
  ]);
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    if (status === "A") added.push(basename(path));
    else if (status === "D") removed.push(basename(path));
  }
  return { target, added: added.sort(), removed: removed.sort() };
}

export function runCheck({ cwd = process.cwd(), base, head = "HEAD", now = new Date() }) {
  if (/^0+$/.test(base)) return { ok: true, errors: [], skipped: true };
  const errors = checkMigrationOrder({ ...migrationChanges({ cwd, base, head }), now });
  return { ok: errors.length === 0, errors };
}

function main(argv) {
  let base = "origin/main";
  let head = "HEAD";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) base = argv[++i];
    else if (argv[i] === "--head" && argv[i + 1]) head = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const result = runCheck({ base, head });
  if (result.skipped) {
    process.stdout.write(`check-migration-order: no base commit (${base}); skipped\n`);
    return 0;
  }
  if (!result.ok) {
    process.stderr.write(`${result.errors.map((e) => `check-migration-order: ${e}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`check-migration-order: new migrations sort after ${base}\n`);
  return 0;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).trim() : "";
    process.stderr.write(
      `check-migration-order: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ""}\n`,
    );
    process.exitCode = 2;
  }
}
