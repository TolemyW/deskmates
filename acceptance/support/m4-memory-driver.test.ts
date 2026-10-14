import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MemoryAttemptUsage,
  MemoryBudget,
  type MemoryCampaignAuthorization,
  memoryDigest,
} from "./m4-memory-budget.js";
import {
  type MemoryDriverPlan,
  type MemoryJournal,
  type MemoryJournalEvent,
  type MemoryRuntimeAdapter,
  boundedMemoryAttempt,
  memoryReservationKey,
  runMemoryDriver,
  validateMemoryDriverPlan,
} from "./m4-memory-driver.js";
import { MemoryFileJournal } from "./m4-memory-journal.js";

const hash = (text: string) => memoryDigest(text);
const NOW = 1_800_000_000_000;
const usage: MemoryAttemptUsage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheCreate: 1,
  costMicrousd: 100,
};
function planFixture(): MemoryDriverPlan {
  return {
    version: "m4-memory-driver-v1",
    campaignId: "fabricated-offline-contract-only",
    decisionPlanSha256: hash("decision"),
    sourceManifest: hash("source"),
    knobManifests: { "retention-on": hash("on"), "retention-off": hash("off") },
    model: "fabricated-no-model",
    baseline: {
      commonFilesSha256: hash("files"),
      browserProfileSha256: hash("profile"),
      rulesSha256: hash("rules"),
      imageSha256: hash("image"),
    },
    limits: { maxTokens: 100, maxCostMicrousd: 1_000, maxTurns: 20, maxDurationMs: 1_000 },
    reservations: ["retention-off", "retention-on"].map((arm) => ({
      caseId: "case-1",
      arm: arm as "retention-on" | "retention-off",
      repeat: 1,
      sourceManifest: hash("source"),
      knobManifest: hash(arm === "retention-on" ? "on" : "off"),
      sessions: Array.from({ length: 5 }, (_, index) => ({
        id: `session-${index + 1}`,
        index: index + 1,
        role: index > 0 ? "peer" : "learner",
      })),
    })),
  };
}
function authorize(plan = planFixture()): MemoryCampaignAuthorization {
  return {
    approvalReference: "fabricated-test-approval-never-live-authority",
    approvedBy: "test",
    campaignId: plan.campaignId,
    driverPlanSha256: memoryDigest(plan),
    approvedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    maxAttempts: 10,
    maxTokens: 1_000,
    maxCostMicrousd: 10_000,
  };
}

function harness(plan = planFixture()) {
  const calls: string[] = [];
  const events: MemoryJournalEvent[] = [];
  const persist = async (event: MemoryJournalEvent) => {
    events.push(structuredClone(event));
    calls.push(`journal:${event.kind}`);
    return { sequence: event.sequence, sha256: event.sha256, durable: true as const };
  };
  const journal: MemoryJournal = { claim: persist, append: persist };
  let next = 0;
  const runtime: MemoryRuntimeAdapter<{ value: string }> = {
    async freezeBaseline(baseline) {
      calls.push("freeze");
      return {
        artifact: "host/baseline",
        baseline,
        frozenBeforeQueries: true,
        gatewayDatabaseOutsideBaseline: true,
      };
    },
    async startCampaign(reservation) {
      calls.push(`campaign:${reservation.arm}`);
      return {
        workspaceId: `workspace-${memoryReservationKey(reservation)}`,
        learnerBotId: "learner",
        peerBotId: "peer",
        fixtureReady: true,
      };
    },
    async stopAndRestore(_ref, previousRunId) {
      calls.push(`reset:${previousRunId ?? "none"}`);
      return {
        artifact: "host/reset",
        priorRunTerminal: true,
        browserCloseAcknowledged: true,
        runtimeStopped: true,
        writableLayerDiscarded: true,
        commonFilesSha256: plan.baseline.commonFilesSha256,
        browserProfileSha256: plan.baseline.browserProfileSha256,
        sdkTranscriptAndDiaryInventoryClear: true,
      };
    },
    async applyRetention(ref) {
      calls.push(`retention:${ref.reservation.arm}`);
      return {
        artifact: "host/retention",
        state: ref.reservation.arm === "retention-on" ? "kept" : "forgotten",
        searchCount: 0,
        indexCount: 0,
        canonicalExportCount: 0,
        rulesSha256: plan.baseline.rulesSha256,
      };
    },
    async prepareFreshQuery(ref) {
      calls.push("prepare");
      next++;
      return {
        artifact: "host/query",
        runId: `run-${next}`,
        threadId: `thread-${next}`,
        workspaceId: ref.workspaceId,
        botId: ref.botId,
        sourceManifest: ref.reservation.sourceManifest,
        knobManifest: ref.reservation.knobManifest,
        driverPlanSha256: ref.driverPlanSha256,
        canonicalExportRegeneratedFromGateway: true,
        oldTaskTranscriptUnavailable: true,
        oldConfirmationsUnavailable: true,
        sessionOptions: {},
        enforcedLimits: plan.limits,
        model: plan.model,
      };
    },
    async execute(_ref, prepared, control) {
      expect(control.deadlineMs).toBe(NOW + plan.limits.maxDurationMs);
      expect(control.signal.aborted).toBe(false);
      expect(events.at(-1)?.kind).toBe("attempt-intent");
      calls.push("execute");
      return {
        runId: prepared.runId,
        threadId: prepared.threadId,
        sdkSessionId: `sdk-${next}`,
        status: "succeeded",
        usage,
        observation: { value: "synthetic" },
      };
    },
  };
  const input = {
    plan,
    frozenDriverPlanSha256: memoryDigest(plan),
    authorization: authorize(plan),
    journal,
    runtime,
    now: () => NOW,
  };
  return { calls, events, runtime, journal, input, run: () => runMemoryDriver(input) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("M4 memory budget (offline only)", () => {
  it("requires explicit authorization bound to the exact plan", () => {
    const plan = planFixture();
    for (const authorization of [
      null,
      { ...authorize(plan), driverPlanSha256: hash("other") },
      { ...authorize(plan), campaignId: "another" },
      { ...authorize(plan), approvalReference: "" },
    ]) {
      expect(
        () =>
          new MemoryBudget(authorization, plan.campaignId, memoryDigest(plan), plan.limits, NOW),
      ).toThrow();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.2, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cap %s before a reservation",
    (invalid) => {
      const plan = planFixture();
      for (const key of ["maxTokens", "maxCostMicrousd", "maxAttempts"] as const) {
        expect(
          () =>
            new MemoryBudget(
              { ...authorize(plan), [key]: invalid },
              plan.campaignId,
              memoryDigest(plan),
              plan.limits,
              NOW,
            ),
        ).toThrow(/positive bounded/);
      }
      for (const key of ["maxTokens", "maxCostMicrousd", "maxTurns", "maxDurationMs"] as const) {
        expect(
          () =>
            new MemoryBudget(
              authorize(plan),
              plan.campaignId,
              memoryDigest(plan),
              { ...plan.limits, [key]: invalid },
              NOW,
            ),
        ).toThrow(/positive bounded/);
      }
    },
  );

  it("counts a reserved but unconfirmed invocation and forbids retries", () => {
    const plan = planFixture();
    const budget = new MemoryBudget(
      authorize(plan),
      plan.campaignId,
      memoryDigest(plan),
      plan.limits,
      NOW,
    );
    budget.reserve("attempt-1", NOW);
    expect(() => budget.reserve("attempt-1", NOW)).toThrow(/duplicate/);
    expect(() => budget.reserve("attempt-2", NOW)).toThrow(/unresolved/);
    expect(budget.snapshot()).toMatchObject({ chargedTokens: 100, chargedCostMicrousd: 1_000 });
    budget.settle("attempt-1", null);
    expect(() => budget.reserve("attempt-2", NOW)).toThrow(/unknown/);
    expect(budget.snapshot().attempts[0]).toMatchObject({ state: "unknown", usage: null });
  });

  it.each(["input", "output", "cacheRead", "cacheCreate", "costMicrousd"] as const)(
    "retains the ceiling when %s usage is missing",
    (field) => {
      const plan = planFixture();
      const budget = new MemoryBudget(
        authorize(plan),
        plan.campaignId,
        memoryDigest(plan),
        plan.limits,
        NOW,
      );
      budget.reserve("one", NOW);
      budget.settle("one", { ...usage, [field]: null });
      expect(budget.snapshot()).toMatchObject({ chargedTokens: 100, chargedCostMicrousd: 1_000 });
      expect(() => budget.reserve("two", NOW)).toThrow(/unknown/);
    },
  );

  it("preserves known over-cap subtotals alongside missing counters, including exact overflow", () => {
    const plan = planFixture();
    for (const output of [1_001, Number.MAX_SAFE_INTEGER]) {
      const budget = new MemoryBudget(
        authorize(plan),
        plan.campaignId,
        memoryDigest(plan),
        plan.limits,
        NOW,
      );
      budget.reserve("one", NOW);
      budget.settle("one", { ...usage, input: null, output });
      const exact = BigInt(output) + 4n;
      expect(budget.snapshot().chargedTokensExact).toBe(exact.toString());
      expect(budget.snapshot().chargedTokens).toBe(
        exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : null,
      );
      expect(() => budget.reserve("two", NOW)).toThrow(/unknown/);
    }
  });

  it("retains failed-run charges, counts all token classes and enforces both total ceilings", () => {
    const plan = planFixture();
    for (const overrides of [{ maxAttempts: 1 }, { maxTokens: 100 }, { maxCostMicrousd: 1_000 }]) {
      const budget = new MemoryBudget(
        { ...authorize(plan), ...overrides },
        plan.campaignId,
        memoryDigest(plan),
        plan.limits,
        NOW,
      );
      budget.reserve("one", NOW);
      budget.settle("one", usage);
      expect(budget.snapshot()).toMatchObject({ chargedTokens: 16, chargedCostMicrousd: 100 });
      expect(() => budget.reserve("two", NOW)).toThrow(/exhausted/);
    }
  });

  it("retains overrun evidence and blocks instead of clamping to the approved cap", () => {
    const plan = planFixture();
    const budget = new MemoryBudget(
      authorize(plan),
      plan.campaignId,
      memoryDigest(plan),
      plan.limits,
      NOW,
    );
    budget.reserve("one", NOW);
    budget.settle("one", { ...usage, costMicrousd: 1_001 });
    expect(budget.snapshot().chargedCostMicrousd).toBe(1_001);
    expect(() => budget.reserve("two", NOW)).toThrow(/exceeds/);
    expect(() => budget.settle("one", usage)).toThrow(/settled/);
  });
});

describe("M4 combined memory orchestration protocol", () => {
  it("journals first, executes paired whole campaigns in frozen order and never grants acceptance", async () => {
    const h = harness();
    const report = await h.run();
    expect(report).toMatchObject({
      orchestrationCompleted: true,
      runtimeIntegrationVerified: false,
      statisticalGatePassed: false,
      fullM4Acceptance: false,
      expectedSessions: 10,
      journalHealthy: true,
    });
    expect(report.records).toHaveLength(10);
    expect(report.budget).toMatchObject({ chargedTokens: 160, chargedCostMicrousd: 1_000 });
    expect(h.calls.slice(0, 11)).toEqual([
      "journal:frozen-plan",
      "freeze",
      "journal:baseline",
      "campaign:retention-off",
      "reset:none",
      "retention:retention-off",
      "prepare",
      "journal:prepared",
      "journal:attempt-intent",
      "execute",
      "journal:attempt-result",
    ]);
    expect(h.calls).toContain("reset:run-1");
    expect(h.events.at(-1)?.kind).toBe("completed");
    let previousSha256: string | null = null;
    for (const [index, event] of h.events.entries()) {
      const { sha256, ...body } = event;
      expect(sha256).toBe(memoryDigest(body));
      expect(event.sequence).toBe(index + 1);
      expect(event.previousSha256).toBe(previousSha256);
      previousSha256 = sha256;
    }
  });

  it("rejects absent/expired/mismatched approval before any journal or adapter operation", async () => {
    for (const change of [
      null,
      { ...authorize(), expiresAtMs: NOW },
      { ...authorize(), approvedAtMs: NOW + 1 },
      { ...authorize(), driverPlanSha256: hash("wrong") },
    ]) {
      const h = harness();
      await expect(runMemoryDriver({ ...h.input, authorization: change })).rejects.toThrow();
      expect(h.calls).toEqual([]);
    }
  });

  it("rejects post-freeze mutation and invalid reservation inventory", async () => {
    const h = harness();
    h.input.plan.model = "changed";
    await expect(h.run()).rejects.toThrow(/frozen driver plan/);
    expect(h.calls).toEqual([]);
    const plan = planFixture();
    expect(() =>
      validateMemoryDriverPlan({ ...plan, reservations: plan.reservations.slice(1) }),
    ).toThrow(/both paired/);
    expect(() =>
      validateMemoryDriverPlan({
        ...plan,
        reservations: [...plan.reservations, ...plan.reservations],
      }),
    ).toThrow(/duplicate/);
    for (const field of ["sourceManifest", "knobManifest"] as const) {
      const changed = structuredClone(plan);
      const first = changed.reservations[0];
      if (!first) throw new Error("missing fixture");
      first[field] = hash("other");
      expect(() => validateMemoryDriverPlan(changed)).toThrow(/source\/knob/);
    }
  });

  it("rejects missing baseline hashes and mismatched paired schedules", () => {
    const missing = planFixture();
    missing.baseline = {} as MemoryDriverPlan["baseline"];
    expect(() => validateMemoryDriverPlan(missing)).toThrow(/baseline/);
    const mismatch = planFixture();
    const paired = mismatch.reservations[1]?.sessions[0];
    if (!paired) throw new Error("missing fixture");
    paired.id = "different-session";
    expect(() => validateMemoryDriverPlan(mismatch)).toThrow(/schedules differ/);
  });

  it.each(["resume", "continue"] as const)(
    "blocks a query with %s even when undefined",
    async (field) => {
      const h = harness();
      const original = h.runtime.prepareFreshQuery;
      vi.spyOn(h.runtime, "prepareFreshQuery").mockImplementation(async (ref) => ({
        ...(await original(ref)),
        sessionOptions: { [field]: undefined },
      }));
      const result = await h.run();
      expect(result.stopReason).toContain("no-resume");
      expect(h.calls).not.toContain("execute");
    },
  );

  it.each([
    "sourceManifest",
    "knobManifest",
    "driverPlanSha256",
    "workspaceId",
    "botId",
    "model",
  ] as const)("rejects prepared query %s substitution", async (field) => {
    const h = harness();
    const original = h.runtime.prepareFreshQuery;
    vi.spyOn(h.runtime, "prepareFreshQuery").mockImplementation(async (ref) => ({
      ...(await original(ref)),
      [field]: "wrong",
    }));
    expect((await h.run()).stopReason).toContain("ownership");
    expect(h.calls).not.toContain("execute");
  });

  it("rejects unbound execution caps and altered human rules before invocation", async () => {
    const capHarness = harness();
    const prepare = capHarness.runtime.prepareFreshQuery;
    vi.spyOn(capHarness.runtime, "prepareFreshQuery").mockImplementation(async (ref) => ({
      ...(await prepare(ref)),
      enforcedLimits: { ...capHarness.input.plan.limits, maxTurns: 21 },
    }));
    expect((await capHarness.run()).stopReason).toContain("caps");
    expect(capHarness.calls).not.toContain("execute");
    const ruleHarness = harness();
    const retention = ruleHarness.runtime.applyRetention;
    vi.spyOn(ruleHarness.runtime, "applyRetention").mockImplementation(async (ref) => ({
      ...(await retention(ref)),
      rulesSha256: hash("changed-rule"),
    }));
    expect((await ruleHarness.run()).stopReason).toContain("retention/rule");
    expect(ruleHarness.calls).not.toContain("execute");
  });

  it.each([
    "canonicalExportRegeneratedFromGateway",
    "oldTaskTranscriptUnavailable",
    "oldConfirmationsUnavailable",
  ] as const)("requires %s", async (field) => {
    const h = harness();
    const original = h.runtime.prepareFreshQuery;
    vi.spyOn(h.runtime, "prepareFreshQuery").mockImplementation(async (ref) => ({
      ...(await original(ref)),
      [field]: false,
    }));
    expect((await h.run()).orchestrationCompleted).toBe(false);
    expect(h.calls).not.toContain("execute");
  });

  it.each([
    "priorRunTerminal",
    "browserCloseAcknowledged",
    "runtimeStopped",
    "writableLayerDiscarded",
    "sdkTranscriptAndDiaryInventoryClear",
  ] as const)("does not forget, regenerate or invoke before %s", async (field) => {
    const h = harness();
    const original = h.runtime.stopAndRestore;
    vi.spyOn(h.runtime, "stopAndRestore").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      [field]: false,
    }));
    expect((await h.run()).stopReason).toContain("reset receipt");
    expect(h.calls.some((call) => call.startsWith("retention:"))).toBe(false);
  });

  it.each(["searchCount", "indexCount", "canonicalExportCount"] as const)(
    "requires empty off-arm %s",
    async (field) => {
      const h = harness();
      const original = h.runtime.applyRetention;
      vi.spyOn(h.runtime, "applyRetention").mockImplementation(async (ref) => ({
        ...(await original(ref)),
        [field]: null,
      }));
      expect((await h.run()).stopReason).toContain("retention/rule");
      expect(h.calls).not.toContain("execute");
    },
  );

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects unknown/malformed on-arm counts (%s)",
    async (count) => {
      for (const field of ["searchCount", "indexCount", "canonicalExportCount"] as const) {
        const h = harness();
        const original = h.runtime.applyRetention;
        vi.spyOn(h.runtime, "applyRetention").mockImplementation(async (ref) => ({
          ...(await original(ref)),
          ...(ref.reservation.arm === "retention-on" ? { [field]: count } : {}),
        }));
        const report = await h.run();
        expect(report.stopReason).toContain("retention/rule");
        expect(report.budget.attempts).toHaveLength(5);
      }
    },
  );

  it.each(["runId", "threadId"] as const)(
    "refuses reused physical %s before the second invocation",
    async (field) => {
      const h = harness();
      const original = h.runtime.prepareFreshQuery;
      vi.spyOn(h.runtime, "prepareFreshQuery").mockImplementation(async (ref) => ({
        ...(await original(ref)),
        [field]: "reused",
      }));
      expect((await h.run()).stopReason).toContain("reused physical");
      expect(h.calls.filter((call) => call === "execute")).toHaveLength(1);
    },
  );

  it("retains a duplicate SDK result but stops all later sessions", async () => {
    const h = harness();
    const original = h.runtime.execute;
    vi.spyOn(h.runtime, "execute").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      sdkSessionId: "reused",
    }));
    const report = await h.run();
    expect(report.stopReason).toContain("reused physical sdk");
    expect(report.records).toHaveLength(2);
    expect(report.budget.attempts).toHaveLength(2);
    expect(h.events.filter((event) => event.kind === "attempt-result")).toHaveLength(2);
  });

  it("refuses shared workspaces across arm reservations", async () => {
    const h = harness();
    const original = h.runtime.startCampaign;
    vi.spyOn(h.runtime, "startCampaign").mockImplementation(async (ref) => ({
      ...(await original(ref)),
      workspaceId: "reused",
    }));
    const report = await h.run();
    expect(report.stopReason).toContain("reused physical workspace");
    expect(report.records).toHaveLength(5);
  });

  it("retains task failures without selecting retries or dropping later reserved sessions", async () => {
    const h = harness();
    const original = h.runtime.execute;
    vi.spyOn(h.runtime, "execute").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      status: "failed",
    }));
    const report = await h.run();
    expect(report.orchestrationCompleted).toBe(true);
    expect(report.records).toHaveLength(10);
    expect(report.records.every((record) => record.execution?.status === "failed")).toBe(true);
  });

  it.each(["parked", "wrong-attribution", "unknown-usage"])(
    "retains %s and stops",
    async (mode) => {
      const h = harness();
      const original = h.runtime.execute;
      vi.spyOn(h.runtime, "execute").mockImplementation(async (...args) => ({
        ...(await original(...args)),
        ...(mode === "parked"
          ? { status: "parked" as const }
          : mode === "wrong-attribution"
            ? { runId: "not-reserved" }
            : { usage: null }),
      }));
      const report = await h.run();
      expect(report.orchestrationCompleted).toBe(false);
      expect(report.records).toHaveLength(1);
      expect(report.records[0]?.execution).not.toBeNull();
      expect(h.events.some((event) => event.kind === "attempt-result")).toBe(true);
    },
  );

  it.each([
    "wrong-run",
    "wrong-thread",
    "missing-sdk",
    "blank-sdk",
    "reused-sdk",
    "parked",
    "malformed-status",
  ])(
    "keeps the actual attempt ceiling when untrustworthy %s evidence claims zero usage",
    async (mode) => {
      const h = harness();
      const original = h.runtime.execute;
      let count = 0;
      vi.spyOn(h.runtime, "execute").mockImplementation(async (...args) => {
        const normal = await original(...args);
        count++;
        if (mode === "reused-sdk" && count === 1) return normal;
        return {
          ...normal,
          usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costMicrousd: 0 },
          ...(mode === "wrong-run"
            ? { runId: "another-run" }
            : mode === "wrong-thread"
              ? { threadId: "another-thread" }
              : mode === "missing-sdk"
                ? { sdkSessionId: null }
                : mode === "blank-sdk"
                  ? { sdkSessionId: " " }
                  : mode === "reused-sdk"
                    ? { sdkSessionId: "sdk-1" }
                    : mode === "parked"
                      ? { status: "parked" as const }
                      : { status: "malformed" as "failed" }),
        };
      });
      const report = await h.run();
      expect(report.orchestrationCompleted).toBe(false);
      const attempt = report.budget.attempts.at(-1);
      expect(attempt).toMatchObject({
        state: "unknown",
        usage: null,
        chargedTokens: 100,
        chargedCostMicrousd: 1_000,
      });
      expect(report.records.at(-1)?.execution?.usage?.costMicrousd).toBe(0);
      expect(report.budget.attempts).toHaveLength(mode === "reused-sdk" ? 2 : 1);
      const result = h.events.filter((event) => event.kind === "attempt-result").at(-1);
      expect(result?.payload).toMatchObject({
        usageAttributionVerified: false,
        execution: { usage: { costMicrousd: 0 } },
      });
    },
  );

  it("retains unknown accounting for a malformed null execution reply", async () => {
    const h = harness();
    vi.spyOn(h.runtime, "execute").mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof h.runtime.execute>>,
    );
    const report = await h.run();
    expect(report.stopReason).toContain("malformed execution");
    expect(report.budget.attempts[0]).toMatchObject({
      state: "unknown",
      usage: null,
      chargedTokens: 100,
      chargedCostMicrousd: 1_000,
    });
    expect(
      h.events.filter((event) => event.kind === "attempt-result").at(-1)?.payload,
    ).toMatchObject({ execution: null, usageAttributionVerified: false });
  });

  it("does not invoke after failed/lying durable acknowledgement; intent stays charged", async () => {
    for (const mode of ["throw", "false-durable", "wrong-hash", "wrong-sequence"]) {
      const h = harness();
      const original = h.journal.append;
      vi.spyOn(h.journal, "append").mockImplementation(async (event) => {
        const ack = await original(event); // Write may have succeeded even though reply is bad.
        if (event.kind !== "attempt-intent") return ack;
        if (mode === "throw") throw new Error("uncertain write");
        return {
          ...ack,
          ...(mode === "false-durable"
            ? { durable: false }
            : mode === "wrong-hash"
              ? { sha256: hash("other") }
              : { sequence: 99 }),
        } as typeof ack;
      });
      const report = await h.run();
      expect(report.journalHealthy).toBe(false);
      expect(h.calls).not.toContain("execute");
      expect(report.budget.attempts).toHaveLength(1);
      expect(report.budget.chargedCostMicrousd).toBe(1_000);
      expect(h.events.some((event) => event.kind === "attempt-intent")).toBe(true);
    }
  });

  it("does not continue if result persistence is uncertain", async () => {
    const h = harness();
    const original = h.journal.append;
    vi.spyOn(h.journal, "append").mockImplementation(async (event) => {
      if (event.kind === "attempt-result") throw new Error("disk failed");
      return original(event);
    });
    const report = await h.run();
    expect(report.journalHealthy).toBe(false);
    expect(report.records).toHaveLength(1);
    expect(h.calls.filter((call) => call === "execute")).toHaveLength(1);
  });

  it("retains uncertain model invocation with unknown usage and no automatic retry", async () => {
    const h = harness();
    vi.spyOn(h.runtime, "execute").mockRejectedValue(
      new Error("sensitive adapter error must not be journaled"),
    );
    const report = await h.run();
    expect(report.stopReason).toContain("remote stop unconfirmed");
    expect(report.budget.attempts[0]?.state).toBe("unknown");
    expect(JSON.stringify(h.events)).not.toContain("sensitive adapter error");
    expect(report.expectedSessions).toBe(10);
    expect(report.records).toHaveLength(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe invocation window %s before calling the adapter",
    async (duration) => {
      const operation = vi.fn();
      await expect(boundedMemoryAttempt(operation, duration)).rejects.toThrow(/positive bounded/);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it("uses one post-journal time snapshot to validate approval and bound the query", async () => {
    const h = harness();
    let afterIntent = false;
    let clockReads = 0;
    const original = h.journal.append;
    vi.spyOn(h.journal, "append").mockImplementation(async (event) => {
      const ack = await original(event);
      if (event.kind === "attempt-intent") afterIntent = true;
      return ack;
    });
    h.input.now = () => {
      if (!afterIntent) return NOW;
      clockReads++;
      return clockReads === 1 ? NOW + 59_999 : NOW + 60_000;
    };
    vi.spyOn(h.runtime, "execute").mockImplementation(async (_ref, prepared, control) => {
      expect(clockReads).toBe(1);
      expect(control.deadlineMs).toBe(NOW + 60_000);
      return {
        runId: prepared.runId,
        threadId: prepared.threadId,
        sdkSessionId: "sdk-first",
        status: "succeeded",
        usage,
        observation: { value: "synthetic" },
      };
    });
    const report = await h.run();
    expect(report.stopReason).toContain("not currently valid");
    expect(report.records).toHaveLength(1);
  });

  it("rejects truthy nonboolean evidence rather than accepting unknown receipt flags", async () => {
    const h = harness();
    const original = h.runtime.stopAndRestore;
    vi.spyOn(h.runtime, "stopAndRestore").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      runtimeStopped: "unknown" as unknown as boolean,
    }));
    expect((await h.run()).stopReason).toContain("reset receipt");
    expect(h.calls).not.toContain("execute");
  });

  it("aborts a hung query at its cap and never assumes the remote process terminated", async () => {
    vi.useFakeTimers();
    const h = harness();
    let signal: AbortSignal | undefined;
    vi.spyOn(h.runtime, "execute").mockImplementation(async (_ref, _prepared, control) => {
      signal = control.signal;
      return new Promise(() => {});
    });
    const pending = h.run();
    await vi.advanceTimersByTimeAsync(1_001);
    const report = await pending;
    expect(signal?.aborted).toBe(true);
    expect(report.stopReason).toContain("remote stop unconfirmed");
    expect(report.budget.chargedTokens).toBe(100);
    expect(report.records).toHaveLength(1);
  });

  it("rechecks expiry after a slow intent acknowledgement", async () => {
    const h = harness();
    let now = NOW;
    h.input.now = () => now;
    const original = h.journal.append;
    vi.spyOn(h.journal, "append").mockImplementation(async (event) => {
      const ack = await original(event);
      if (event.kind === "attempt-intent") now = NOW + 60_000;
      return ack;
    });
    const report = await h.run();
    expect(report.stopReason).toContain("not currently valid");
    expect(h.calls).not.toContain("execute");
    expect(report.budget.attempts[0]?.state).toBe("intent");
  });

  it("stops on a spent invocation budget while preserving not-started denominator", async () => {
    const h = harness();
    h.input.authorization.maxAttempts = 1;
    const report = await h.run();
    expect(report.stopReason).toContain("budget exhausted");
    expect(report.budget.attempts).toHaveLength(1);
    expect(report.expectedSessions).toBe(10);
    expect(report.records.filter((record) => record.execution !== null)).toHaveLength(1);
  });
});

describe("M4 local durable campaign journal", () => {
  it("leaves a durable uncertain intent on crash and refuses reuse rather than refunding it", async () => {
    const h = harness();
    await h.run();
    const root = await mkdtemp(join(tmpdir(), "m4-memory-crash-"));
    const path = join(root, "campaign");
    const writer = new MemoryFileJournal(path);
    try {
      for (const event of h.events) {
        if (event.sequence === 1) await writer.claim(event);
        else await writer.append(event);
        if (event.kind === "attempt-intent") break;
      }
      await writer.close();
      const text = await readFile(join(path, "events.jsonl"), "utf8");
      const last = JSON.parse(text.trim().split("\n").at(-1) ?? "null") as MemoryJournalEvent;
      expect(last.kind).toBe("attempt-intent");
      expect(text).not.toContain('"kind":"attempt-result"');
      const restarted = new MemoryFileJournal(path);
      const retry = harness();
      try {
        const report = await runMemoryDriver({ ...retry.input, journal: restarted });
        expect(report.journalHealthy).toBe(false);
        expect(retry.calls).toEqual([]);
        expect(await readFile(join(path, "events.jsonl"), "utf8")).toBe(text);
      } finally {
        await restarted.close();
      }
    } finally {
      await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("poisons a writer after a forged event and refuses to append a later valid event", async () => {
    const h = harness();
    await h.run();
    const first = h.events[0];
    const next = h.events[1];
    if (!first || !next) throw new Error("missing journal fixtures");
    const root = await mkdtemp(join(tmpdir(), "m4-memory-journal-invalid-"));
    const writer = new MemoryFileJournal(join(root, "campaign"));
    try {
      await writer.claim(first);
      await expect(writer.append({ ...next, sha256: hash("forged") })).rejects.toThrow(/mismatch/);
      await expect(writer.append(next)).rejects.toThrow(/unavailable/);
    } finally {
      await writer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a hash chain to exclusive files and refuses crash/restart reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "m4-memory-journal-"));
    const path = join(root, "campaign");
    const journal = new MemoryFileJournal(path);
    const h = harness();
    vi.spyOn(h.runtime, "execute").mockImplementation(async (_ref, prepared) => ({
      runId: prepared.runId,
      threadId: prepared.threadId,
      sdkSessionId: `sdk-${prepared.runId}`,
      status: "succeeded",
      usage,
      observation: { value: "synthetic" },
    }));
    try {
      const report = await runMemoryDriver({ ...h.input, journal });
      expect(report.orchestrationCompleted).toBe(true);
      const events = (await readFile(join(path, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as MemoryJournalEvent);
      expect(events[0]?.kind).toBe("frozen-plan");
      expect(events.at(-1)?.kind).toBe("completed");
      const fresh = harness();
      const restarted = new MemoryFileJournal(path);
      try {
        const denied = await runMemoryDriver({ ...fresh.input, journal: restarted });
        expect(denied.journalHealthy).toBe(false);
        expect(fresh.calls).toEqual([]);
      } finally {
        await restarted.close();
      }
      expect(await readFile(join(path, "events.jsonl"), "utf8")).toContain("attempt-intent");
    } finally {
      await journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
