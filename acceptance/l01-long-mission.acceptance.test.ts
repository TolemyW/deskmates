import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import { gradeL01, l2Evidence } from "./support/l01-long-mission.js";
import { getRun, postMessage, runEvents, waitForRun } from "./support/runs.js";
import { siteLog, siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const fixture = JSON.parse(
  readFileSync(new URL("./support/l01-long-mission.json", import.meta.url), "utf8"),
) as {
  version: string;
  instruction: string;
  expectedSeedIds: string[];
  comment: string;
  maxTurns: number;
  taskTimeoutSeconds: number;
};
const output = process.env.L01_REPORT_DIR;
const skip = missingModelEnv().length > 0 || !(await dockerAvailable());
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe.skipIf(skip)("L01 coherent long mission on the golden site", () => {
  let stack: Stack | undefined;
  beforeAll(async () => {
    requireWorkspaceImageId();
    stack = await startStack({ ...modelEnv(), label: "l01-long" });
    stack.config.maxTurns = fixture.maxTurns;
    stack.config.runTimeoutSeconds = fixture.taskTimeoutSeconds;
    stack.config.strategyEvidence = {
      taskVersion: fixture.version,
      fixtureSha256: createHash("sha256")
        .update(readFileSync(new URL("./support/l01-long-mission.json", import.meta.url)))
        .digest("hex"),
    };
  }, 120_000);
  afterAll(async () => {
    await stopStack(stack);
  }, 120_000);

  it("discovers, comments and closes the eligible tickets in one run", async () => {
    if (!stack) throw new Error("stack unavailable");
    const before = await siteState(stack);
    const startedAt = new Date().toISOString();
    const { run: initial } = await postMessage(stack, fixture.instruction);
    let waitError: string | undefined;
    try {
      await waitForRun(stack, initial.id, (fixture.taskTimeoutSeconds + 30) * 1000);
    } catch (error) {
      waitError = String(error);
    }
    const [afterResult, logResult, runResult, eventsResult] = await Promise.allSettled([
      siteState(stack),
      siteLog(stack),
      getRun(stack, initial.id),
      runEvents(stack, initial.id),
    ]);
    const after = afterResult.status === "fulfilled" ? afterResult.value : undefined;
    const log = logResult.status === "fulfilled" ? logResult.value : undefined;
    const run = runResult.status === "fulfilled" ? runResult.value.run : undefined;
    const events = eventsResult.status === "fulfilled" ? eventsResult.value : undefined;
    // Eligibility is judged as of when the agent saw the site, never the grading clock.
    const eligibilityAsOf = run?.startedAt ?? startedAt;
    const checks = gradeL01(
      before,
      after,
      log,
      fixture.expectedSeedIds,
      fixture.comment,
      new Date(eligibilityAsOf),
    );
    const business = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "unknown")
        ? "unknown"
        : "pass";
    const l2 = events && l2Evidence(events);
    const elapsedMs =
      run?.startedAt && run.finishedAt
        ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
        : undefined;
    const constraintChecks = [
      {
        name: "terminal successful run",
        status: run ? (run.status === "succeeded" && !waitError ? "pass" : "fail") : "unknown",
      },
      {
        name: "task deadline",
        status:
          elapsedMs === undefined
            ? "unknown"
            : elapsedMs <= fixture.taskTimeoutSeconds * 1000
              ? "pass"
              : "fail",
      },
      {
        name: "configured turn cap",
        status: !run ? "unknown" : run.config.maxTurns === fixture.maxTurns ? "pass" : "fail",
      },
      {
        name: "no approval or L2 event",
        status: !l2 ? "unknown" : l2.length > 0 ? "fail" : "pass",
        ...(l2?.length ? { reason: l2.join("; ") } : {}),
      },
      {
        name: "single run attempt",
        status: !run ? "unknown" : run.attempt === 1 ? "pass" : "fail",
      },
      {
        name: "complete ledger sequence",
        status: !events?.length
          ? "unknown"
          : events.every((e, i) => e.seq === i + 1)
            ? "pass"
            : "unknown",
      },
    ];
    const constraints = constraintChecks.some((c) => c.status === "fail")
      ? "fail"
      : constraintChecks.some((c) => c.status === "unknown")
        ? "unknown"
        : "pass";
    const result = {
      schemaVersion: 1,
      fixtureVersion: fixture.version,
      startedAt,
      eligibilityAsOf,
      finishedAt: new Date().toISOString(),
      runId: initial.id,
      runStatus: run?.status,
      runAttempt: run?.attempt,
      runError: run?.error,
      waitError,
      maxTurns: fixture.maxTurns,
      taskTimeoutSeconds: fixture.taskTimeoutSeconds,
      businessOutcome: business,
      executionConstraints: constraints,
      checks,
      constraintChecks,
      elapsedMs,
      turnCount: null,
      turnCountNote:
        "SDK turn count is not exposed in this read path; successful termination below the configured cap is observed, exact count unknown",
      evidence: {
        beforeSha256: hash(before),
        afterSha256: after && hash(after),
        logSha256: log && hash(log),
        ledgerSha256: events && hash(events),
        eventCount: events?.length,
        operationCount: log?.length,
      },
      before: { ...before, settings: { ...before.settings, apiToken: "[REDACTED]" } },
      after: after && { ...after, settings: { ...after.settings, apiToken: "[REDACTED]" } },
      operationLog: log,
      ledgerIndex: events?.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        toolName: e.kind === "tool_call" ? e.payload.toolName : undefined,
      })),
    };
    if (output) {
      mkdirSync(output, { recursive: true, mode: 0o700 });
      writeFileSync(join(output, "l01-result.json"), JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
    }
    expect(business, JSON.stringify(checks.filter((c) => c.status !== "pass"))).toBe("pass");
    expect(constraints, waitError).toBe("pass");
  }, 700_000);
});
