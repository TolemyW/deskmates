import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCiTests, testCommand, testStatistics } from "./test-metrics.mjs";

let directory;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const report = {
  numTotalTests: 7,
  numPassedTests: 6,
  numFailedTests: 0,
  numPendingTests: 1,
  testResults: [
    { name: "/repo/a.test.ts", startTime: 10, endTime: 30 },
    { name: "/repo/b.test.ts", startTime: 20, endTime: 40 },
    { name: "/repo/c.test.ts", startTime: 40, endTime: 50 },
    { name: "/repo/skipped.test.ts", startTime: 0, endTime: 0 },
  ],
};

describe("CI test metrics", () => {
  it("preserves scoped npm test arguments and fixes both worker bounds", () => {
    const args = testCommand(["--changed", "base-sha", "--passWithNoTests"], "/reports");
    expect(args.slice(5, 11)).toEqual([
      "npm",
      "test",
      "--",
      "--changed",
      "base-sha",
      "--passWithNoTests",
    ]);
    expect(args).toContain("--minWorkers=2");
    expect(args).toContain("--maxWorkers=2");
    expect(args).toContain("--reporter=default");
    expect(args).toContain("--outputFile.json=/reports/tests.json");
    expect(args).not.toContain("--no-isolate");
  });

  it("measures overlap without counting touching intervals or skipped files as parallel", () => {
    expect(testStatistics(report)).toMatchObject({
      files: 4,
      tests: 7,
      passed: 6,
      skipped: 1,
      observedConcurrentTestFiles: 2,
    });
    expect(
      testStatistics({ testResults: [report.testResults[0], report.testResults[2]] }),
    ).toMatchObject({ observedConcurrentTestFiles: 1, tests: null });
    expect(testStatistics({ testResults: [] }).observedConcurrentTestFiles).toBe(0);
    expect(testStatistics(null)).toBeNull();
  });

  it.each([0, 1, 137])("preserves test exit %s while recording measured resources", (status) => {
    directory = mkdtempSync(join(tmpdir(), "ci-metrics-test-"));
    const summary = join(directory, "summary.md");
    const logs = [];
    const exit = runCiTests([], {
      system: "linux",
      env: { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary },
      log: (line) => logs.push(line),
      execute: (command, args, options) => {
        expect(command).toBe("/usr/bin/time");
        expect(options.stdio).toBe("inherit");
        const resourceFile = args[args.indexOf("-o") + 1];
        const testFile = args.find((a) => a.startsWith("--outputFile.json=")).split("=")[1];
        writeFileSync(
          resourceFile,
          JSON.stringify({ wallSeconds: 3.2, maxProcessRssKiB: 2048, exitCode: status }),
        );
        writeFileSync(testFile, JSON.stringify(report));
        return { status, signal: null };
      },
    });
    expect(exit).toBe(status);
    const metrics = JSON.parse(logs.at(-1).slice("CI_TEST_METRICS ".length));
    expect(metrics).toMatchObject({
      exitCode: status,
      resources: { wallSeconds: 3.2, maxProcessRssKiB: 2048 },
      tests: { observedConcurrentTestFiles: 2 },
    });
    expect(readFileSync(summary, "utf8")).toContain("not the sum of concurrent processes");
  });

  it.each([0, 1])(
    "keeps exit %s and unknown coverage when measurement files are absent",
    (status) => {
      directory = mkdtempSync(join(tmpdir(), "ci-metrics-missing-"));
      const logs = [];
      const warnings = [];
      expect(
        runCiTests([], {
          system: "linux",
          env: { RUNNER_TEMP: directory },
          execute: () => ({ status }),
          log: (s) => logs.push(s),
          warn: (s) => warnings.push(s),
        }),
      ).toBe(status);
      expect(JSON.parse(logs.at(-1).slice("CI_TEST_METRICS ".length))).toMatchObject({
        resources: null,
        tests: null,
      });
      expect(warnings).toHaveLength(2);
    },
  );

  it("fails when the command cannot be launched", () => {
    directory = mkdtempSync(join(tmpdir(), "ci-metrics-spawn-"));
    expect(
      runCiTests([], {
        system: "linux",
        env: { RUNNER_TEMP: directory },
        execute: () => ({ status: null, error: new Error("missing time") }),
        log: () => {},
        warn: () => {},
      }),
    ).toBe(1);
  });

  it("keeps a signal termination nonzero with its conventional exit code", () => {
    directory = mkdtempSync(join(tmpdir(), "ci-metrics-signal-"));
    expect(
      runCiTests([], {
        system: "linux",
        env: { RUNNER_TEMP: directory },
        execute: () => ({ status: null, signal: "SIGKILL" }),
        log: () => {},
        warn: () => {},
      }),
    ).toBe(137);
  });
});
