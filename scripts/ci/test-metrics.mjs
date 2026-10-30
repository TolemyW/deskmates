// CI-only test entry point. Keep npm's existing tier filters and test exit status.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { constants, availableParallelism, cpus, platform, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const TEST_WORKERS = 2;

export function testCommand(args, directory) {
  return [
    "-q",
    "-f",
    '{"wallSeconds":%e,"maxProcessRssKiB":%M,"exitCode":%x}',
    "-o",
    join(directory, "resources.json"),
    "npm",
    "test",
    "--",
    ...args,
    `--minWorkers=${TEST_WORKERS}`,
    `--maxWorkers=${TEST_WORKERS}`,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${join(directory, "tests.json")}`,
  ];
}

/** File test intervals exclude module collection and worker startup: not a process count. */
export function testStatistics(report) {
  if (!report || !Array.isArray(report.testResults)) return null;
  const intervals = report.testResults.filter(
    (file) =>
      Number.isFinite(file.startTime) &&
      Number.isFinite(file.endTime) &&
      file.endTime > file.startTime,
  );
  const events = intervals.flatMap((file) => [
    [file.startTime, 1],
    [file.endTime, -1],
  ]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of events.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += delta;
    peak = Math.max(peak, active);
  }
  return {
    files: report.testResults.length,
    tests: report.numTotalTests ?? null,
    passed: report.numPassedTests ?? null,
    failed: report.numFailedTests ?? null,
    skipped: report.numPendingTests ?? null,
    observedConcurrentTestFiles: peak,
    slowestFiles: intervals
      .map((file) => ({
        file: relative(process.cwd(), file.name),
        ms: file.endTime - file.startTime,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5),
  };
}

function readReport(path, warn) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`CI metrics unavailable: ${path}`);
    return null;
  }
}

export function runCiTests(
  args,
  {
    env = process.env,
    execute = spawnSync,
    system = platform(),
    log = console.log,
    warn = console.warn,
  } = {},
) {
  if (system !== "linux") throw new Error("CI test metrics require Linux /usr/bin/time (GNU time)");
  const directory = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "ci-test-metrics-"));
  const host = {
    availableCpus: availableParallelism(),
    logicalCpus: cpus().length,
    totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    minWorkers: TEST_WORKERS,
    maxWorkers: TEST_WORKERS,
    node: process.version,
  };
  log(`CI_TEST_CONFIG ${JSON.stringify(host)}`);
  const result = execute("/usr/bin/time", testCommand(args, directory), { env, stdio: "inherit" });
  const exitCode =
    result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1);
  if (result.error) warn(`CI test command could not start: ${result.error.message}`);
  const resources = readReport(join(directory, "resources.json"), warn);
  const tests = testStatistics(readReport(join(directory, "tests.json"), warn));
  log(
    `CI_TEST_METRICS ${JSON.stringify({ ...host, exitCode, signal: result.signal ?? null, resources, tests })}`,
  );
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `
### Test execution

| Metric | Value |
| --- | ---: |
| Available CPUs / logical CPUs | ${host.availableCpus} / ${host.logicalCpus} |
| Fixed worker minimum / maximum | ${TEST_WORKERS} / ${TEST_WORKERS} |
| Observed concurrent file tests | ${tests?.observedConcurrentTestFiles ?? "unknown"} |
| Test files / passed tests | ${tests?.files ?? "unknown"} / ${tests?.passed ?? "unknown"} |
| Test wall seconds | ${resources?.wallSeconds ?? "unknown"} |
| GNU time maximum process RSS (KiB) | ${resources?.maxProcessRssKiB ?? "unknown"} |
| Test exit code | ${exitCode} |

RSS is GNU time's maximum-process measurement, not the sum of concurrent processes.
File concurrency measures overlapping test execution, excluding collection/startup.
`,
      );
    } catch (error) {
      warn(`CI summary unavailable: ${error.message}`);
    }
  }
  // Diagnostics cannot turn a failing test command into a passing gate.
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCiTests(process.argv.slice(2));
}
