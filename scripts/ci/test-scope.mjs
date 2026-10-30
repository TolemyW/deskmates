// Run what a change touches, not the whole suite. Import graphs miss files read as text, so every
// changed path also brings the tests that name it (or its directory) and its owner's tests. Only
// the root toolchain, which every test runs through, falls back to the full suite.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { layoutScope } from "./layout-scope.mjs";

/** Inputs every test runs through: dependencies, the compiler base and the test runner. */
const TOOLCHAIN = /^(package(-lock)?\.json|tsconfig\.base\.json|vitest\.config\.[^/]+)$/;
const PROSE =
  /^(docs\/(design|runbooks|releases|adr)\/.*\.md$|(?:README|AGENTS|CLAUDE)\.md$|packages\/[^/]+\/(?:README\.md|docs\/.*\.md)$)/;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
/** Where a guard or reader test may live; npm's tier filters still drop T2/T3 files. */
export const TEST_ROOTS = /^(scripts|packages|images|evals|acceptance)\//;
const GUARDS = ["scripts/public-scan.test.mjs", "scripts/hotspot-budgets.test.mjs"];
const DOC_GUARDS = [
  "scripts/docs-consistency.test.mjs",
  "packages/sidecar/src/approval-docs.test.ts",
  "packages/sidecar/src/desktop/grouping-docs.test.ts",
];
/**
 * Owners of text inputs outside packages/ that no test names by path: a directory's contents are
 * read through code that builds the path. Everything else is found by `readers`.
 */
const OWNERS = [
  [/^images\/workspace(-base|-desktop)?\//, ["packages/sandbox-docker/", "scripts/"]],
  [/^images\/egress\//, ["packages/sandbox-docker/", "scripts/"]],
  [/^images\//, ["scripts/"]],
  [
    /^observability\//,
    ["packages/observability-dashboards/", "packages/gateway/src/observability/"],
  ],
  [/^docs\/generated\//, ["packages/gateway/src/api/permission-matrix.test.ts"]],
  [/^docs\/guide\//, ["packages/web/"]],
  [/^examples\//, ["scripts/scenarios/"]],
  [/^(scripts|\.github)\//, ["scripts/"]],
];

/**
 * The test files that name a changed path or its directory, read as text: `git grep` over the
 * tracked unit and integration tests. Injected so the plan stays a pure function in tests.
 */
export function findReaders(files, execute = execFileSync) {
  const needles = new Set();
  for (const file of files) {
    needles.add(file);
    const dir = file.split("/").slice(0, -1).join("/");
    // A top-level directory alone ("images", "docs") names too much to be a signal.
    if (dir.includes("/")) needles.add(dir);
  }
  if (!needles.size) return [];
  const args = ["grep", "-l", "-F"];
  for (const needle of needles) args.push("-e", needle);
  args.push("--", "*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.js");
  try {
    return execute("git", args, { encoding: "utf8" })
      .split("\n")
      .filter(
        (path) => path && TEST_ROOTS.test(path) && !/\.(container|acceptance)\.test\./.test(path),
      );
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (error?.status === 1) return [];
    throw error;
  }
}

export function chooseTestScope(files, event = "pull_request", readers = () => []) {
  const full = (reason) => ({ mode: "full", reason, typecheck: true, webBuild: true, guards: [] });
  if (event !== "pull_request") return full("manual or reusable workflow");
  if (files.some((file) => TOOLCHAIN.test(file))) return full("root dependencies or toolchain");

  const proseOnly = files.length > 0 && files.every((file) => PROSE.test(file));
  const guards = new Set(GUARDS);
  if (files.some((file) => file.startsWith("docs/") || PROSE.test(file)))
    for (const guard of DOC_GUARDS) guards.add(guard);
  for (const file of files) {
    for (const [pattern, owners] of OWNERS) {
      if (!pattern.test(file)) continue;
      for (const owner of owners) guards.add(owner);
      break;
    }
    // A test outside the import graph's reach (images/, evals/ fixtures) runs itself.
    if (TEST.test(file) && TEST_ROOTS.test(file)) guards.add(file);
    // Its own directory's tests cover a changed image or tool directory.
    const top = /^(images\/[^/]+)\//.exec(file)?.[1];
    if (top) guards.add(`${top}/`);
    const pkg = /^(packages\/[^/]+)\//.exec(file)?.[1];
    if (
      pkg &&
      (/\/migrations\/|\/route-policies\/|\/messages\/|\/__golden__\/|\/__snapshots__\//.test(
        file,
      ) ||
        /^packages\/[^/]+\/package\.json$/.test(file) ||
        (!PROSE.test(file) && !/\.(?:[cm]?[jt]sx?|css)$/.test(file)))
    )
      guards.add(`${pkg}/`);
  }
  for (const reader of readers(files)) guards.add(reader);
  // A directory guard already covers the files under it.
  const sorted = [...guards].sort();
  const kept = sorted.filter(
    (path) =>
      !sorted.some((other) => other !== path && other.endsWith("/") && path.startsWith(other)),
  );
  return {
    mode: proseOnly ? "docs" : "affected",
    reason: proseOnly
      ? "prose documentation and its guards"
      : "import graph plus the tests that read the changed paths",
    typecheck: files.some(
      (file) => CODE.test(file) || /^packages\/[^/]+\/(package\.json|tsconfig[^/]*)$/.test(file),
    ),
    webBuild: files.some((file) => /^(packages\/(web|ui)\/|docs\/guide\/)/.test(file)),
    guards: kept,
  };
}

export function readChangedFiles(base, execute = execFileSync) {
  if (!/^[0-9a-f]{40}$/i.test(base ?? "")) throw new Error("A pinned PR base SHA is required");
  // Include both names of a rename/deletion: removing a lockfile must not hide a full trigger.
  return execute("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.EVENT_NAME;
  const files = event === "pull_request" ? readChangedFiles(process.env.BASE) : [];
  const plan = chooseTestScope(files, event, findReaders);
  console.log(`CI_TEST_SCOPE ${JSON.stringify({ ...plan, files })}`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${plan.mode}\ntypecheck=${plan.typecheck}\nweb_build=${plan.webBuild}\nguards=${JSON.stringify(plan.guards)}\nlayout_features=${layoutScope(files, event)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Test scope\n\n${plan.mode}: ${plan.reason}. Changed paths: ${files.length}. Guard and reader tests: ${plan.guards.length}.\n`,
    );
}
