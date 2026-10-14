// Host orchestration protocol only. Production Docker/Gateway/SDK adapters do not exist here.
import {
  type MemoryAttemptLimits,
  type MemoryAttemptUsage,
  MemoryBudget,
  type MemoryCampaignAuthorization,
  memoryDigest,
  requireMemoryHash,
  requireMemoryInteger,
} from "./m4-memory-budget.js";

export type MemoryArm = "retention-on" | "retention-off";
export interface MemoryReservation {
  caseId: string;
  arm: MemoryArm;
  repeat: number;
  sourceManifest: string;
  knobManifest: string;
  sessions: readonly { id: string; index: number; role: "learner" | "peer" }[];
}
export interface MemoryBaseline {
  commonFilesSha256: string;
  browserProfileSha256: string;
  rulesSha256: string;
  imageSha256: string;
}
export interface MemoryDriverPlan {
  version: "m4-memory-driver-v1";
  campaignId: string;
  decisionPlanSha256: string;
  sourceManifest: string;
  knobManifests: Record<MemoryArm, string>;
  model: string;
  baseline: MemoryBaseline;
  limits: MemoryAttemptLimits;
  reservations: readonly MemoryReservation[];
}

export interface MemoryJournalEvent {
  sequence: number;
  previousSha256: string | null;
  driverPlanSha256: string;
  kind:
    | "frozen-plan"
    | "baseline"
    | "prepared"
    | "attempt-intent"
    | "attempt-result"
    | "stopped"
    | "completed";
  payload: unknown;
  sha256: string;
}
export interface MemoryJournalAck {
  sequence: number;
  sha256: string;
  durable: true;
}
/** claim MUST atomically create a NEW campaign journal, rejecting existing/incomplete runs.
 * append MUST durably persist exact events before acknowledging. No automatic crash resume.
 * The included local-file implementation fsyncs; remote stores need equivalent guarantees. */
export interface MemoryJournal {
  claim(event: MemoryJournalEvent): Promise<MemoryJournalAck>;
  append(event: MemoryJournalEvent): Promise<MemoryJournalAck>;
}

export interface MemorySessionRef {
  driverPlanSha256: string;
  reservation: MemoryReservation;
  session: MemoryReservation["sessions"][number];
  workspaceId: string;
  botId: string;
}
export interface MemoryResetReceipt {
  artifact: string;
  priorRunTerminal: boolean;
  browserCloseAcknowledged: boolean;
  runtimeStopped: boolean;
  writableLayerDiscarded: boolean;
  commonFilesSha256: string;
  browserProfileSha256: string;
  sdkTranscriptAndDiaryInventoryClear: boolean;
}
export interface MemoryRetentionReceipt {
  artifact: string;
  state: "kept" | "forgotten";
  searchCount: number | null;
  indexCount: number | null;
  canonicalExportCount: number | null;
  rulesSha256: string;
}
export interface MemoryPreparedQuery {
  artifact: string;
  runId: string;
  threadId: string;
  workspaceId: string;
  botId: string;
  sourceManifest: string;
  knobManifest: string;
  driverPlanSha256: string;
  canonicalExportRegeneratedFromGateway: boolean;
  oldTaskTranscriptUnavailable: boolean;
  oldConfirmationsUnavailable: boolean;
  /** Exact SDK session options inspected by the adapter, not synthetic claims about a session ID. */
  sessionOptions: { resume?: unknown; continue?: unknown };
  /** The future adapter must enforce every cap across its entire query, retries and subrequests. */
  enforcedLimits: MemoryAttemptLimits;
  model: string;
}
export interface MemoryExecution<T> {
  runId: string;
  threadId: string;
  sdkSessionId: string | null;
  status: "succeeded" | "silent" | "failed" | "cancelled" | "parked";
  usage: MemoryAttemptUsage | null;
  observation: T;
}

/** All operations are evaluator-host operations; private answer keys never appear in this API.
 * stopAndRestore restores ALL common trees/profile after acknowledged browser shutdown and
 * discards the writable layer. applyRetention uses only campaign-owned learned entries.
 * prepareFreshQuery regenerates canonical exports AFTER retention changes, advances the
 * fixture, reserves a fresh thread/run and proves old transcript/confirmation inaccessibility.
 * execute must issue exactly one fresh SDK query, with its own enforced deadline/abort/kill
 * path and proxy caps. The host timeout alone cannot prove a remote query has stopped.
 * No hidden consolidation/model calls are permitted in other methods. Such work needs
 * separate predeclared reservations and accounting before this adapter can support it. */
export interface MemoryRuntimeAdapter<T> {
  freezeBaseline(baseline: MemoryBaseline): Promise<{
    artifact: string;
    baseline: MemoryBaseline;
    frozenBeforeQueries: boolean;
    gatewayDatabaseOutsideBaseline: boolean;
  }>;
  startCampaign(reservation: MemoryReservation): Promise<{
    workspaceId: string;
    learnerBotId: string;
    peerBotId: string;
    fixtureReady: boolean;
  }>;
  stopAndRestore(ref: MemorySessionRef, previousRunId: string | null): Promise<MemoryResetReceipt>;
  applyRetention(ref: MemorySessionRef): Promise<MemoryRetentionReceipt>;
  prepareFreshQuery(ref: MemorySessionRef): Promise<MemoryPreparedQuery>;
  execute(
    ref: MemorySessionRef,
    prepared: MemoryPreparedQuery,
    control: { deadlineMs: number; signal: AbortSignal },
  ): Promise<MemoryExecution<T>>;
}

export function memoryReservationKey(reservation: MemoryReservation): string {
  return JSON.stringify([reservation.caseId, reservation.repeat, reservation.arm]);
}

export function validateMemoryDriverPlan(plan: MemoryDriverPlan): void {
  if (plan.version !== "m4-memory-driver-v1" || !plan.campaignId.trim() || !plan.model.trim()) {
    throw new Error("invalid driver plan identity/model");
  }
  requireMemoryHash(plan.decisionPlanSha256, "decision plan");
  requireMemoryHash(plan.sourceManifest, "source");
  for (const key of [
    "commonFilesSha256",
    "browserProfileSha256",
    "rulesSha256",
    "imageSha256",
  ] as const) {
    requireMemoryHash(plan.baseline[key], `baseline ${key}`);
  }
  for (const arm of ["retention-on", "retention-off"] as const) {
    requireMemoryHash(plan.knobManifests[arm], "knob");
  }
  const keys = new Set<string>();
  for (const reservation of plan.reservations) {
    const key = memoryReservationKey(reservation);
    if (
      keys.has(key) ||
      !reservation.caseId ||
      !["retention-on", "retention-off"].includes(reservation.arm) ||
      !Number.isSafeInteger(reservation.repeat) ||
      reservation.repeat < 1 ||
      reservation.sourceManifest !== plan.sourceManifest ||
      reservation.knobManifest !== plan.knobManifests[reservation.arm] ||
      reservation.sessions.length !== 5 ||
      new Set(reservation.sessions.map((session) => session.id)).size !== 5 ||
      reservation.sessions.some(
        (session, index) =>
          !session.id || session.index !== index + 1 || !["learner", "peer"].includes(session.role),
      )
    ) {
      throw new Error("invalid/duplicate ordered reservation or source/knob mismatch");
    }
    keys.add(key);
  }
  if (!keys.size) throw new Error("empty reservations");
  for (const reservation of plan.reservations) {
    const other = reservation.arm === "retention-on" ? "retention-off" : "retention-on";
    const paired = plan.reservations.find(
      (item) => memoryReservationKey(item) === memoryReservationKey({ ...reservation, arm: other }),
    );
    if (!paired) {
      throw new Error("both paired arms must be reserved before execution");
    }
    if (memoryDigest(paired.sessions) !== memoryDigest(reservation.sessions)) {
      throw new Error("paired arm session schedules differ");
    }
  }
}

async function adapterCall<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return structuredClone(await operation());
  } catch {
    // Arbitrary adapter errors can contain request bodies/credentials. Raw logs belong in
    // separately redacted host artifacts, not the campaign journal or user-facing report.
    throw new Error(`runtime adapter failed at ${phase}; no automatic retry`);
  }
}

export async function boundedMemoryAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  durationMs: number,
): Promise<T> {
  requireMemoryInteger(durationMs, "invocation window", 86_400_000);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("attempt deadline expired; remote stop unconfirmed"));
        }, durationMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs serially in frozen reservation/session order. Task failure is retained and continues;
 * protocol failure, uncertain invocation/usage, invalid acknowledgement or budget stops all
 * later work. A new process cannot resume this journal automatically or retry an attempt. */
export async function runMemoryDriver<T>(input: {
  plan: MemoryDriverPlan;
  frozenDriverPlanSha256: string;
  authorization: MemoryCampaignAuthorization | null;
  journal: MemoryJournal;
  runtime: MemoryRuntimeAdapter<T>;
  now: () => number;
}) {
  const plan = structuredClone(input.plan);
  const authorization = structuredClone(input.authorization);
  validateMemoryDriverPlan(plan);
  const driverPlanSha256 = memoryDigest(plan);
  if (input.frozenDriverPlanSha256 !== driverPlanSha256)
    throw new Error("frozen driver plan mismatch");
  const budget = new MemoryBudget(
    authorization,
    plan.campaignId,
    driverPlanSha256,
    plan.limits,
    input.now(),
  );
  const records: {
    ref: MemorySessionRef;
    reset: MemoryResetReceipt;
    retention: MemoryRetentionReceipt;
    prepared: MemoryPreparedQuery;
    execution: MemoryExecution<T> | null;
  }[] = [];
  let sequence = 0;
  let previousSha256: string | null = null;
  let journalHealthy = true;
  let stopReason: string | null = null;
  async function persist(kind: MemoryJournalEvent["kind"], payload: unknown): Promise<void> {
    const body = { sequence: sequence + 1, previousSha256, driverPlanSha256, kind, payload };
    const event = { ...body, sha256: memoryDigest(body) };
    try {
      const ack = await (sequence === 0
        ? input.journal.claim(structuredClone(event))
        : input.journal.append(structuredClone(event)));
      if (ack.durable !== true || ack.sequence !== event.sequence || ack.sha256 !== event.sha256) {
        throw new Error("invalid acknowledgement");
      }
    } catch {
      journalHealthy = false;
      throw new Error(
        "durable journal acknowledgement missing; do not retry or reuse this campaign",
      );
    }
    sequence = event.sequence;
    previousSha256 = event.sha256;
  }
  const used = {
    workspace: new Set<string>(),
    run: new Set<string>(),
    thread: new Set<string>(),
    sdk: new Set<string>(),
  };
  function fresh(kind: keyof typeof used, value: string | null): void {
    if (typeof value !== "string" || !value.trim() || used[kind].has(value))
      throw new Error(`missing/reused physical ${kind} identity`);
    used[kind].add(value);
  }
  try {
    await persist("frozen-plan", { plan, authorization });
    const baseline = await adapterCall("freeze-baseline", () =>
      input.runtime.freezeBaseline(structuredClone(plan.baseline)),
    );
    if (
      !baseline.artifact ||
      baseline.frozenBeforeQueries !== true ||
      baseline.gatewayDatabaseOutsideBaseline !== true ||
      memoryDigest(baseline.baseline) !== memoryDigest(plan.baseline)
    ) {
      throw new Error("common baseline not frozen outside Gateway before queries");
    }
    await persist("baseline", baseline);
    for (const reservation of plan.reservations) {
      budget.assertAvailable(input.now());
      const campaign = await adapterCall("start-campaign", () =>
        input.runtime.startCampaign(structuredClone(reservation)),
      );
      fresh("workspace", campaign.workspaceId);
      if (
        campaign.fixtureReady !== true ||
        !campaign.learnerBotId ||
        !campaign.peerBotId ||
        campaign.learnerBotId === campaign.peerBotId
      ) {
        throw new Error("fixture readiness or learner/peer attribution missing");
      }
      let previousRunId: string | null = null;
      for (const session of reservation.sessions) {
        budget.assertAvailable(input.now());
        const ref: MemorySessionRef = {
          driverPlanSha256,
          reservation,
          session,
          workspaceId: campaign.workspaceId,
          botId: session.role === "learner" ? campaign.learnerBotId : campaign.peerBotId,
        };
        const reset = await adapterCall("stop-and-restore", () =>
          input.runtime.stopAndRestore(structuredClone(ref), previousRunId),
        );
        if (
          !reset.artifact ||
          reset.priorRunTerminal !== true ||
          reset.browserCloseAcknowledged !== true ||
          reset.runtimeStopped !== true ||
          reset.writableLayerDiscarded !== true ||
          reset.sdkTranscriptAndDiaryInventoryClear !== true ||
          reset.commonFilesSha256 !== plan.baseline.commonFilesSha256 ||
          reset.browserProfileSha256 !== plan.baseline.browserProfileSha256
        )
          throw new Error("stopped-runtime/file/profile reset receipt incomplete or mismatched");
        const retention = await adapterCall("apply-retention", () =>
          input.runtime.applyRetention(structuredClone(ref)),
        );
        if (
          !retention.artifact ||
          retention.rulesSha256 !== plan.baseline.rulesSha256 ||
          [retention.searchCount, retention.indexCount, retention.canonicalExportCount].some(
            (count) => count === null || !Number.isSafeInteger(count) || count < 0,
          ) ||
          (reservation.arm === "retention-on"
            ? retention.state !== "kept"
            : retention.state !== "forgotten" ||
              retention.searchCount !== 0 ||
              retention.indexCount !== 0 ||
              retention.canonicalExportCount !== 0)
        )
          throw new Error("retention/rule receipt incomplete or mismatched");
        const prepared = await adapterCall("prepare-fresh-query", () =>
          input.runtime.prepareFreshQuery(structuredClone(ref)),
        );
        if (
          !prepared.artifact ||
          prepared.workspaceId !== ref.workspaceId ||
          prepared.botId !== ref.botId ||
          prepared.sourceManifest !== plan.sourceManifest ||
          prepared.knobManifest !== reservation.knobManifest ||
          prepared.driverPlanSha256 !== driverPlanSha256 ||
          prepared.model !== plan.model ||
          prepared.canonicalExportRegeneratedFromGateway !== true ||
          prepared.oldTaskTranscriptUnavailable !== true ||
          prepared.oldConfirmationsUnavailable !== true ||
          !prepared.sessionOptions ||
          "resume" in prepared.sessionOptions ||
          "continue" in prepared.sessionOptions ||
          memoryDigest(prepared.enforcedLimits) !== memoryDigest(plan.limits)
        )
          throw new Error(
            "fresh-query ownership/source/knob/plan/caps/context/no-resume proof missing",
          );
        fresh("run", prepared.runId);
        fresh("thread", prepared.threadId);
        const record = {
          ref,
          reset,
          retention,
          prepared,
          execution: null as MemoryExecution<T> | null,
        };
        records.push(record);
        await persist("prepared", record);
        const attemptKey = JSON.stringify([memoryReservationKey(reservation), session.id]);
        const limits = budget.reserve(attemptKey, input.now());
        await persist("attempt-intent", {
          attemptKey,
          ref,
          prepared,
          limits,
          budget: budget.snapshot(),
        });
        // Recheck time after persistence: a delayed acknowledgement must not extend approval.
        const invocationNow = input.now();
        budget.assertAvailable(invocationNow);
        const deadlineMs = Math.min(
          invocationNow + limits.maxDurationMs,
          authorization?.expiresAtMs ?? 0,
        );
        let execution: MemoryExecution<T>;
        try {
          execution = await boundedMemoryAttempt(
            (signal) =>
              adapterCall("execute", () =>
                input.runtime.execute(structuredClone(ref), structuredClone(prepared), {
                  deadlineMs,
                  signal,
                }),
              ),
            deadlineMs - invocationNow,
          );
        } catch {
          budget.settle(attemptKey, null);
          await persist("attempt-result", {
            attemptKey,
            execution: null,
            budget: budget.snapshot(),
            remoteStopConfirmed: false,
          });
          throw new Error(
            "invocation interrupted/uncertain; charged attempt retained, remote stop unconfirmed",
          );
        }
        record.execution = execution;
        // Inspect attribution/completeness BEFORE releasing the reserved ceiling. A zero-cost
        // receipt for another run, an old SDK session, or a still-running query says nothing
        // about this invocation's eventual cost. Preserve that raw receipt separately.
        let executionIssue: string | null = null;
        if (!execution || typeof execution !== "object") {
          executionIssue = "malformed execution evidence; invocation outcome unknown";
        } else if (execution.runId !== prepared.runId || execution.threadId !== prepared.threadId) {
          executionIssue = "execution attribution differs from reserved run/thread";
        } else if (
          typeof execution.sdkSessionId !== "string" ||
          !execution.sdkSessionId.trim() ||
          used.sdk.has(execution.sdkSessionId)
        ) {
          executionIssue = "missing/reused physical sdk identity";
        } else if (!["succeeded", "silent", "failed", "cancelled"].includes(execution.status)) {
          executionIssue = "nonterminal/unknown run status; cannot reset or continue";
        }
        budget.settle(attemptKey, executionIssue === null ? execution.usage : null);
        await persist("attempt-result", {
          attemptKey,
          execution,
          usageAttributionVerified: executionIssue === null,
          budget: budget.snapshot(),
        });
        if (executionIssue !== null) throw new Error(executionIssue);
        fresh("sdk", execution.sdkSessionId);
        budget.assertAvailable(input.now());
        previousRunId = execution.runId;
      }
    }
    await persist("completed", { observedSessions: records.length, budget: budget.snapshot() });
  } catch (error) {
    stopReason = error instanceof Error ? error.message : "campaign stopped";
    if (journalHealthy) {
      try {
        await persist("stopped", { reason: stopReason, budget: budget.snapshot() });
      } catch {
        /* Keep the original blocker; journalHealthy exposes uncertain persistence. */
      }
    }
  }
  return {
    driverPlanSha256,
    orchestrationCompleted: stopReason === null,
    runtimeIntegrationVerified: false as const,
    statisticalGatePassed: false as const,
    fullM4Acceptance: false as const,
    stopReason,
    journalHealthy,
    // The frozen plan retains every not-started reservation. Never export accepted-only rows.
    expectedSessions: plan.reservations.reduce((sum, row) => sum + row.sessions.length, 0),
    records,
    budget: budget.snapshot(),
  };
}
