// The job layout of .github/workflows/ci.yml and release.yml, and the shell step of release.yml
// that decides what a release skips, run here against stubbed `gh` and a scratch git repository.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

/** The `run: |` block of the step with this id, dedented. */
function stepScript(id) {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  expect(start, `step ${id}`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  const indent = lines[run].indexOf("run:");
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(strip)).join("\n");
}

/** `timeout-minutes` of a top-level job in a workflow file. */
function jobTimeout(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThan(-1);
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const m = /^ {4}timeout-minutes: (\d+)$/.exec(line);
    if (m) return Number(m[1]);
  }
  throw new Error(`job ${job} has no timeout-minutes`);
}

/** The lines of a top-level job in a workflow file, its own header included. */
function jobBlock(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Names of the top-level jobs in a workflow file. */
function jobNames(workflow) {
  const lines = workflow.split("\n");
  const from = lines.indexOf("jobs:");
  return lines
    .slice(from + 1)
    .map((l) => /^ {2}([A-Za-z0-9_-]+):$/.exec(l)?.[1])
    .filter(Boolean);
}

/** The `on:` block of a workflow file. */
function triggers(workflow) {
  const lines = workflow.split("\n");
  const from = lines.indexOf("on:");
  expect(from, "on:").toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > from && /^\S/.test(l));
  return lines.slice(from + 1, end).join("\n");
}

let temp;
let bin;

function stub(name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(script, env, cwd = temp) {
  const output = join(temp, "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, ...env },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { stdout: result.stdout, stderr: result.stderr, outputs };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "release-workflow-"));
  bin = join(temp, "bin");
  mkdirSync(bin);
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("ci workflow: one gate job, on ready pull requests only", () => {
  // Actions minutes are limited and billed per job rounded up: one job, no run on main pushes.
  it("runs on pull requests, including when a draft is marked ready, and never on a push", () => {
    const on = triggers(CI);
    expect(on).not.toMatch(/^ {2}push:/m);
    expect(on).toMatch(/^ {2}pull_request:$/m);
    expect(on).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    expect(on).toMatch(/^ {2}workflow_call:$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it("skips draft pull requests and cancels a superseded run", () => {
    expect(jobBlock(CI, "gate")).toContain(
      "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );
    expect(CI).toContain("cancel-in-progress: true");
  });

  it("has one gate job covering typecheck, lint, docs, web build and T0/T1", () => {
    expect(jobNames(CI)).toEqual(["gate"]);
    const gate = jobBlock(CI, "gate");
    const steps = [...gate.matchAll(/^ {6}- run: (.+)$/gm)].map((m) => m[1]);
    expect(steps).toEqual([
      "npm ci",
      "npm run typecheck",
      "npm run lint",
      "npm run docs:check",
      "npm run build -w packages/web",
    ]);
    expect(jobTimeout(CI, "gate")).toBe(45);
  });

  it("runs as one job in the private repository and in parallel parts in the public mirror", () => {
    const gate = jobBlock(CI, "gate");
    const include =
      /^ {8}include: \$\{\{ fromJSON\(github\.event\.repository\.private && '(.+?)' \|\| '(.+?)'\) \}\}$/m.exec(
        gate,
      );
    expect(include, "matrix include").not.toBeNull();
    const [, privateParts, publicParts] = include;
    expect(JSON.parse(privateParts)).toEqual([{ part: "all" }]);
    const parts = JSON.parse(publicParts);
    expect(parts.map((p) => p.part)).toEqual([
      "checks",
      "layout-tabs",
      "layout-rows",
      "tests",
      "tests",
      "tests",
    ]);
    expect(parts.filter((p) => p.shard).map((p) => p.shard)).toEqual(["1/3", "2/3", "3/3"]);
    // The private job keeps the plain check name `gate`.
    expect(gate).toContain(
      "name: ${{ matrix.name && format('gate ({0})', matrix.name) || 'gate' }}",
    );
    expect(gate).toContain("fail-fast: false");
    // Together the layout halves run exactly the scripts of `check:layout`.
    const web = JSON.parse(readFileSync(join(REPO, "packages/web/package.json"), "utf8"));
    const all = [...web.scripts["check:layout"].matchAll(/npm run (\S+)/g)].map((m) => m[1]);
    const halves =
      /LAYOUT_CHECKS: \$\{\{ matrix\.part == 'layout-tabs' && '([^']+)' \|\| matrix\.part == 'layout-rows' && '([^']+)' \|\| 'check:layout' \}\}/.exec(
        gate,
      );
    expect(halves, "layout split").not.toBeNull();
    expect([...halves[1].split(" "), ...halves[2].split(" ")]).toEqual(all);
    expect(gate).toContain("name: layout-failures-${{ matrix.part }}");
  });

  it("pins scope selection to the PR base before expensive build steps", () => {
    const gate = jobBlock(CI, "gate");
    expect(gate).toContain("BASE: ${{ github.event.pull_request.base.sha }}");
    expect(gate).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(gate).toContain("run: node scripts/ci/test-scope.mjs");
    expect(gate.indexOf("id: scope")).toBeLessThan(gate.indexOf("run: npm run typecheck"));
    expect(gate).not.toContain("origin/${{ github.base_ref }}");
    expect(gate).not.toContain("FULL_SUITE_PATHS");
    expect(gate).toContain("if: steps.scope.outputs.typecheck == 'true'");
    expect(gate).toContain("if: steps.scope.outputs.web_build == 'true'");
  });

  it("runs import-related tests separately from explicit text-input guards", () => {
    const gate = jobBlock(CI, "gate");
    expect(gate).toContain(
      "if: steps.scope.outputs.mode == 'full' && (matrix.part == 'all' || matrix.part == 'tests')",
    );
    expect(gate).toContain(
      'run: node scripts/ci/test-metrics.mjs ${TEST_SHARD:+"--shard=$TEST_SHARD"}\n',
    );
    expect(gate).toContain(
      'node scripts/ci/test-metrics.mjs --changed "${{ github.event.pull_request.base.sha }}" --passWithNoTests ${TEST_SHARD:+"--shard=$TEST_SHARD"}',
    );
    expect(gate).toContain("TEST_SHARD: ${{ matrix.shard }}");
    expect(gate).toContain(
      "if: steps.scope.outputs.mode != 'full' && (matrix.part == 'all' || matrix.part == 'checks')",
    );
    expect(gate).toContain("CI_GUARD_TESTS: ${{ steps.scope.outputs.guards }}");
    expect(gate).toContain("run: node scripts/ci/test-guards.mjs");
    expect(gate).not.toContain("--no-isolate");
  });
});

describe("workflows: third-party actions are pinned", () => {
  // #63 L20: a tag can be moved to other code, and release.yml runs with packages: write. A full
  // commit SHA cannot; the trailing comment names the release it was resolved from.
  it("names every action by full commit SHA with its version as a comment", () => {
    for (const [file, workflow] of [
      ["ci.yml", CI],
      ["release.yml", WORKFLOW],
    ]) {
      const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((m) => m[1]);
      expect(uses.length, file).toBeGreaterThan(0);
      for (const ref of uses)
        expect(ref, `${file}: ${ref}`).toMatch(
          /^(?:\.\/\S+|[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+)$/,
        );
    }
  });
});

describe("release workflow: packages only; tests run on the target host", () => {
  it("builds the base first and publishes when it passes, with no online test gate", () => {
    expect(jobNames(WORKFLOW)).toEqual(["base", "publish"]);
    expect(WORKFLOW).not.toContain("uses: ./.github/workflows/ci.yml");
    expect(jobBlock(WORKFLOW, "base")).not.toMatch(/^ {4}needs:/m);
    const publish = jobBlock(WORKFLOW, "publish");
    expect(publish).toContain("needs: base");
    expect(publish).toContain("needs.base.result == 'success'");
    expect(publish).toContain('ci: "not run online: T0/T1 and T2 run on the target host');
    expect(publish).toContain('t2: "external: not evaluated by packaging;');
    expect(publish).toContain("target host .release/t2.json for result, scope and image IDs");
    expect(publish).toContain("counts and skips are in .release/t2.log");
    expect(publish).not.toContain('t2: "pending:');
    expect(WORKFLOW).not.toContain("prior");
    expect(WORKFLOW).not.toContain("CI_RUN");
  });
});

describe("release workflow: app-layer smoke build", () => {
  let src;
  let checkout;
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const git = (...args) => gitIn(src, ...args);
  const commit = (path, content, tag) => {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), content);
    git("add", "-A");
    git("commit", "-q", "-m", `change ${path}`);
    if (tag) git("tag", "-a", tag, "-m", tag);
    return git("rev-parse", "HEAD");
  };

  beforeEach(() => {
    src = join(temp, "src");
    checkout = join(temp, "checkout");
    mkdirSync(join(src, "scripts"), { recursive: true });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    copyFileSync(join(REPO, "scripts/image-tag.mjs"), join(src, "scripts/image-tag.mjs"));
    commit("packages/sidecar/src/a.ts", "1", "v1.0.0");
    mkdirSync(join(temp, "manifests"));
    // `gh release view <tag>` succeeds for tags listed in $RELEASED; `gh release download <tag>`
    // prints $MANIFESTS/<tag>.json.
    stub(
      "gh",
      `case "$1 $2" in
  "release view") grep -qx "$3" "$RELEASED" ;;
  "release download") cat "$MANIFESTS/$3.json" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac`,
    );
  });

  /** Run the step in a depth-1 clone of `tag`, the way actions/checkout leaves a tag build. */
  const decide = (tag, released, digests = {}) => {
    writeFileSync(join(temp, "released"), `${released.join("\n")}\n`);
    for (const t of released)
      writeFileSync(
        join(temp, "manifests", `${t}.json`),
        JSON.stringify({ base: { digest: digests[t] ?? DIGEST } }),
      );
    rmSync(checkout, { recursive: true, force: true });
    execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      tag,
      `file://${src}`,
      checkout,
    ]);
    return run(
      stepScript("smoke"),
      {
        GITHUB_REF_NAME: tag,
        GITHUB_SHA: gitIn(checkout, "rev-parse", "HEAD"),
        RELEASED: join(temp, "released"),
        MANIFESTS: join(temp, "manifests"),
        BASE_DIGEST: DIGEST,
        GH_TOKEN: "x",
      },
      checkout,
    ).outputs;
  };

  it("skips it when nothing it reads changed since the previous published release", () => {
    commit("packages/web/src/app.tsx", "ui", "v1.0.1");
    expect(decide("v1.0.1", ["v1.0.0"])).toEqual({
      needed: "false",
      result: "unchanged since v1.0.0",
    });
    // Only the one tag it compares against was fetched into the shallow clone.
    expect(gitIn(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(gitIn(checkout, "tag", "--list")).toBe("v1.0.0\nv1.0.1");
  });

  it("runs it when an input changed, or when there is no published release to compare with", () => {
    commit("packages/sidecar/src/a.ts", "2", "v1.0.1");
    expect(decide("v1.0.1", ["v1.0.0"]).needed).toBe("true");
    commit("images/workspace/entry.sh", "x", "v1.0.2");
    expect(decide("v1.0.2", ["v1.0.0", "v1.0.1"]).needed).toBe("true");
    commit("tsconfig.base.json", "{}", "v1.0.3");
    expect(decide("v1.0.3", ["v1.0.2"]).needed).toBe("true");
    commit("packages/web/src/app.tsx", "ui", "v1.0.4");
    expect(decide("v1.0.4", [])).toMatchObject({ needed: "true" });
  });

  it("runs it when the base differs from the one the previous release built on", () => {
    commit("packages/web/src/app.tsx", "ui", "v1.0.1");
    const other = `sha256:${"b".repeat(64)}`;
    expect(decide("v1.0.1", ["v1.0.0"], { "v1.0.0": other }).needed).toBe("true");
    // A manifest without a base digest proves nothing either.
    expect(decide("v1.0.1", ["v1.0.0"], { "v1.0.0": "" }).needed).toBe("true");
  });

  it("compares with the newest earlier tag that has a release, never with a later one", () => {
    commit("packages/sidecar/src/a.ts", "2", "v1.0.1"); // tagged, but its release failed
    commit("packages/web/src/app.tsx", "ui", "v1.0.2");
    commit("packages/web/src/app.tsx", "ui2", "v1.0.3");
    // Against v1.0.0 the sidecar changed, so the build runs although v1.0.1 has the same inputs.
    expect(decide("v1.0.2", ["v1.0.0", "v1.0.3"]).needed).toBe("true");
  });

  it("takes its inputs from scripts/image-tag.mjs and clones without full history", () => {
    expect(stepScript("smoke")).toContain("node scripts/image-tag.mjs workspace --source-inputs");
    expect(WORKFLOW).not.toContain("APP_LAYER_INPUTS");
    expect(WORKFLOW).not.toContain("fetch-depth: 0");
  });
});

describe("release workflow: how long release-main.sh waits for it", () => {
  it("covers the longest passing run the job timeouts allow", () => {
    // base, then publish.
    const longest = jobTimeout(WORKFLOW, "base") + jobTimeout(WORKFLOW, "publish");
    const script = readFileSync(join(REPO, "scripts/stable/release-main.sh"), "utf8");
    const wait = Number(/RELEASE_WAIT_MINUTES:-(\d+)/.exec(script)?.[1]);
    expect(wait).toBeGreaterThanOrEqual(longest + 15); // and a margin for queueing
  });
});
