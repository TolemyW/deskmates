// Two-lane scheduler (design v0.3 §3.4, §5 step 2). A queued run starts only when its bot has no
// run occupying that lane. Starting a run is: issue a short-lived token, then `exec` the sidecar
// with the StartRunRequest on stdin, which carries `modelBaseUrl` and `modelAuthToken`. When
// `exec` resolves the sidecar process is gone; if it never sent `run_ended`, the run is `failed`.

import {
  type BotId,
  DeskmatesError,
  type ExecRequest,
  type ExecResult,
  PARKED_RUN_STATUSES,
  RUN_MARKER_ENV,
  type RunEnded,
  type RunId,
  type RunTimelineMark,
  type RuntimeStatus,
  type SandboxHandle,
  type StartRunRequest,
  type Workspace,
  type WorkspaceId,
  isDeskmatesError,
  isExecuting,
  isPastDeadline,
  isTerminal,
} from "@deskmates/contracts";
import { ensureCanonicalSoul, ensureLegacyMemory } from "../api/memory-routes.js";
import { asRunEnded } from "../api/validate.js";
import { isReviewRun } from "../approvals/auto-review.js";
import { ApprovalExpiry } from "../approvals/expiry.js";
import { parkIfExhausted } from "../budget/admission.js";

/** A workspace over its disk quota is measured again at most this often while it waits. */
const DISK_REMEASURE_MS = 60_000;
import { CRON_MISFIRE_GRACE_MINUTES_DEFAULT } from "../config/runs.js";
import type { GatewayContext } from "../context.js";
import { type GatewayStart, GatewayStartStore } from "../ledger/gateway-starts.js";
import type { RunRecord } from "../ledger/runs.js";
import { canonicalMemoryForBot } from "../memory/canonical-memory.js";
import { isConsolidationRun } from "../memory/consolidation.js";
import { queueMemoryMaintenance } from "../memory/maintenance-due.js";
import { MODEL_JOB_RUN_TYPES, modelJobKillMs } from "../model-jobs/model-jobs.js";
import { isRoundTriageRun } from "../model-jobs/round-triage.js";
import type { SandboxOrigin } from "../workspaces/sandboxes.js";
import {
  PLATFORM_CONFIG,
  PLATFORM_LOG_SOURCE,
  RESTART_BREAKER_LIMIT,
  RESTART_BREAKER_WINDOW_MINUTES,
  pendingDrainApproval,
} from "./platform-recovery.js";
import { ruleRevisionsOf } from "./rule-revisions.js";
import type { RunLifecycle } from "./run-lifecycle.js";
import { RunStallMonitor, STALL_SWEEP_INTERVAL_MS } from "./run-stall.js";
import { markAttemptStarted, recordTimelineMark } from "./run-timeline-marks.js";

export const SIDECAR_RUN_CMD: readonly string[] = ["deskmates-sidecar", "run"];

/** Prefix of the stdout line the sidecar prints when its `run_ended` post could not be delivered. */
export const RUN_ENDED_STDOUT_PREFIX = "RUN_ENDED ";

/** The `RunEnded` a sidecar left on stdout, validated like the route's body; undefined when none. */
export function runEndedFromStdout(runId: RunId, stdout: string): RunEnded | undefined {
  const line = stdout
    .trimEnd()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(RUN_ENDED_STDOUT_PREFIX));
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(RUN_ENDED_STDOUT_PREFIX.length));
  } catch {
    return undefined;
  }
  return asRunEnded(runId, parsed);
}

/** How often a scheduling pass may stop to delete dead `run_tokens` rows. */
export const TOKEN_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
export const CONTINUATION_SWEEP_INTERVAL_MS = 60 * 1000;
/**
 * How long a cancelled run's sidecar has to exit after its token is revoked before the provider
 * kills its process tree. Revocation already cuts it off from the model and every internal
 * route, so this only bounds how long a stuck process keeps using the workspace's CPU and memory.
 */
export const RUN_CANCEL_GRACE_MS = 10_000;

/** How often a scheduling pass records that this Gateway is alive (ADR-0029 decision 11). */
export const GATEWAY_ALIVE_INTERVAL_MS = 30_000;

/** The minute of a cron run's trigger reference (`cron:<entry>:<ISO minute>`), or undefined. */
export function cronMinuteOf(run: RunRecord): number | undefined {
  if (run.triggerKind !== "cron") return undefined;
  const minute = Date.parse(run.triggerRef.replace(/^cron:\d+:/, ""));
  return Number.isNaN(minute) ? undefined : minute;
}

/** A sidecar process in flight, and how to stop it. */
interface Attempt {
  workspaceId: WorkspaceId;
  abort: AbortController;
  killTimer?: ReturnType<typeof setTimeout>;
}

export class Scheduler {
  /** Keyed by `<runId>#<attempt>`: a resumed run overlaps its own parked process. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Keyed like `inflight`: a resumed run can have its parked process still exiting. */
  private readonly attempts = new Map<string, Attempt>();
  /** See `RUN_CANCEL_GRACE_MS`; tests shorten it. */
  cancelGraceMs = RUN_CANCEL_GRACE_MS;
  private readonly capacityWaiting = new Set<RunId>();
  private scheduled = false;
  private stopped = false;
  private readonly maintenance = new Set<WorkspaceId>();
  /** Bots whose directories the operator is moving; none of their runs starts meanwhile. */
  private readonly heldBots = new Set<BotId>();
  private lastTokenPruneMs = Number.NEGATIVE_INFINITY;
  /** ADR-0029 decision 1: set while this process drains; a new Gateway starts out of drain. */
  private drainStartedAt: string | undefined;
  private drainId: number | undefined;
  /** Decision 6: this process's start, recorded by `reconcile`, and the one before it. */
  private readonly starts: GatewayStartStore;
  private startId: number | undefined;
  private lastAliveMs = Number.NEGATIVE_INFINITY;
  /** The previous Gateway's start row; the cron runner reads when it was last alive. */
  previousStart: GatewayStart | undefined;
  /** Decision 6: this process started more than the limit of times in the window. */
  breakerTripped = false;
  /** Tests move time; the breaker window, the alive mark and the cron misfire grace read it. */
  clock: () => Date = () => new Date();
  private readonly continuationSweep: ReturnType<typeof setInterval>;
  private readonly stallSweep: ReturnType<typeof setInterval>;
  private readonly unsubscribeStalls: () => void;
  /** Issue #9: marks quiet running runs `stalled` and revives them on progress; never kills. */
  readonly stalls: RunStallMonitor;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly lifecycle: RunLifecycle,
    private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    this.starts = new GatewayStartStore(ctx.db);
    this.continuationSweep = setInterval(() => this.kick(), CONTINUATION_SWEEP_INTERVAL_MS);
    this.continuationSweep.unref();
    this.stalls = new RunStallMonitor(
      {
        runs: ctx.runs,
        appendEvent: (input) => ctx.events.append(input),
        publish: (run) =>
          ctx.bus.publish(
            run.threadId
              ? { type: "run_status", threadId: run.threadId, run }
              : { type: "run_status", run },
          ),
      },
      ctx.config.runStallSeconds,
    );
    // Every stored event reaches the bus once its transaction has committed.
    this.unsubscribeStalls = ctx.bus.subscribe((event) => {
      if (event.type === "run_event") this.stalls.observe(event.event);
    });
    this.stallSweep = setInterval(() => this.sweepStalls(), STALL_SWEEP_INTERVAL_MS);
    this.stallSweep.unref();
  }

  /**
   * Issue #9: mark running runs that went quiet `stalled`. An observation only: the run keeps its
   * process, lane and token, and `RUN_TIMEOUT_SECONDS` stays the only kill.
   */
  sweepStalls(): void {
    if (this.stopped) return;
    try {
      for (const run of this.stalls.sweep())
        this.log("run stalled", { runId: run.id, stallSeconds: this.ctx.config.runStallSeconds });
    } catch (err) {
      this.log("stall sweep failed", { error: String(err) });
    }
  }

  /** Ask for a scheduling pass soon. Safe to call from anywhere, any number of times. */
  kick(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.tick();
      } catch (err) {
        this.log("scheduler tick failed", { error: String(err) });
      }
    });
  }

  /**
   * One synchronous pass: start every queued run whose lane is free, oldest first, then resume
   * every parked run whose approval has been decided. The resume is the transition
   * `waiting_approval → running` inside `lifecycle.start`, and that transition happens before
   * this method returns, so a second pass — or a second kick, or a restart — cannot resume the
   * same run twice (ADR-0002 amendment 2, "resume keeps the ledger whole").
   */
  tick(): void {
    if (this.stopped) return;
    this.pruneTokens();
    for (const run of this.ctx.runs.listExpiredContinuations()) {
      const approvalId = run.resumePayload?.approvalId;
      if (!approvalId) continue;
      try {
        this.ctx.broker.decide(
          approvalId as import("@deskmates/contracts").ApprovalId,
          "deny",
          "system:expiry",
          "24-hour continuation window expired",
        );
      } catch (err) {
        this.log("continuation expiry could not be settled", { runId: run.id, error: String(err) });
      }
    }
    // ADR-0002 amendment 3, A7/A8: expire unattended requests and send their one reminder.
    try {
      new ApprovalExpiry(this.ctx).sweep();
    } catch (err) {
      this.log("approval expiry sweep failed", { error: String(err) });
    }
    for (const run of this.ctx.memory.consolidation.requestEligible()) {
      this.ctx.bus.publish({ type: "run_status", run });
    }
    // ADR-0011 amendment 4: the hourly freshness sweep (A26, flag rows only), then at most one
    // model recheck (A28) and one daily organisation (A30) per workspace.
    for (const run of queueMemoryMaintenance(this.ctx, new Date(), (m) => this.log(m, {})))
      this.ctx.bus.publish({ type: "run_status", run });
    for (const id of this.capacityWaiting) {
      const run = this.ctx.runs.get(id);
      if (!run || isTerminal(run.status)) this.capacityWaiting.delete(id);
    }
    this.cancelPastDeadline();
    // Durable walks can be waiting on a lane that became free, or on a process lost at restart.
    // Create their next run before reading the queue so it can launch in this same pass.
    this.ctx.router.continueWalks();
    this.markAlive();
    // ADR-0029 decision 1: in drain nothing starts and nothing resumes; triggers keep arriving
    // and their runs wait in the queue for the end of the drain or the next Gateway.
    if (this.draining) return;
    this.cancelCronMisfires();
    const claimed = new Set<string>();
    const now = new Date();
    const pastDeadline = (run: RunRecord): boolean =>
      run.threadId !== undefined && isPastDeadline(this.ctx.threads.mustGet(run.threadId), now);
    // ADR-0032 decision 6: work the budget parked waits for an explicit continue, nothing else.
    const budgetParked = this.ctx.budget.parkedRunIds();
    for (const run of this.ctx.runs.listQueued()) {
      if (budgetParked.has(run.id)) continue;
      if (run.threadId && this.ctx.threads.mustGet(run.threadId).status === "paused") continue;
      // A deadline that passed after the cancellation above: never start it (issue #21).
      if (pastDeadline(run)) continue;
      // ADR-0005 amendment 6, decision 45: a round's triage is one short tool-free call that
      // never waits for its bot's lane, so a busy member does not hold up the round.
      if (isRoundTriageRun(run)) {
        this.launch(run);
        continue;
      }
      if (this.ctx.walks.blockedByEarlierWalk(run.id)) continue;
      // A parked run of the same (bot, thread) owns the SDK session this run would open, so it
      // waits until that run has resumed and ended (ADR-0002 amendment 2, "a parked run holds
      // its thread"). It does not claim the lane: the bot's runs in other threads are unaffected.
      if (run.threadId && this.ctx.runs.parkedInThread(run.botId, run.threadId)) continue;
      // One memory consolidation per workspace at a time (ADR-0011 decision 8).
      if (
        isConsolidationRun(run) &&
        this.ctx.memory.consolidation.busy(this.ctx.bots.mustGet(run.botId).workspaceId, run.id)
      )
        continue;
      // ADR-0002 amendment 4, B5: a review never waits on the lane of the bot it reviews, which
      // is held by the very run waiting for the verdict; reviews are bounded per workspace.
      if (isReviewRun(run)) {
        if (this.ctx.broker.reviews?.mayStart(run)) this.launch(run);
        continue;
      }
      const laneKey = `${run.botId}:${run.lane}`;
      if (claimed.has(laneKey)) continue;
      claimed.add(laneKey);
      if (this.ctx.runs.laneBusy(run.botId, run.lane)) continue;
      this.launch(run);
    }
    // Runs a model-call park checkpointed, after their park was continued (decision 7).
    const budgetResumable = this.ctx.budget
      .resumableRunIds()
      .map((id) => this.ctx.runs.mustGet(id));
    for (const run of [...this.ctx.runs.listResumable(), ...budgetResumable]) {
      if (budgetParked.has(run.id)) continue;
      if (pastDeadline(run)) continue;
      const laneKey = `${run.botId}:${run.lane}`;
      if (claimed.has(laneKey)) continue;
      claimed.add(laneKey);
      if (this.ctx.runs.laneBusy(run.botId, run.lane)) continue;
      this.launch(run);
    }
    // ADR-0029 decisions 2 and 4: runs the platform parked continue on their own, unless the
    // restart breaker holds them for an operator (decision 6).
    for (const run of this.ctx.runs.listPlatformParked()) {
      if (run.config[PLATFORM_CONFIG.held] === true) continue;
      if (budgetParked.has(run.id)) continue;
      if (pastDeadline(run)) continue;
      // A drained live approval wait whose approval nobody has decided yet waits on it.
      if (pendingDrainApproval(this.ctx, run)) {
        try {
          this.lifecycle.awaitApprovalAfterDrain(run.id);
        } catch (err) {
          this.log("drained run could not wait on its approval", {
            runId: run.id,
            error: String(err),
          });
        }
        continue;
      }
      const laneKey = `${run.botId}:${run.lane}`;
      if (claimed.has(laneKey)) continue;
      claimed.add(laneKey);
      if (this.ctx.runs.laneBusy(run.botId, run.lane)) continue;
      this.launch(run);
    }
  }

  /** ADR-0029 decision 1: whether this process is draining. */
  get draining(): boolean {
    return this.drainStartedAt !== undefined;
  }

  /** Decision 1: stop starting and resuming; every run reaches a safe point or ends by itself. */
  startDrain(): RuntimeStatus {
    if (this.drainStartedAt === undefined) {
      const now = this.clock();
      this.drainStartedAt = now.toISOString();
      try {
        this.drainId = this.starts.drainStarted(now, this.ctx.config.release);
      } catch (err) {
        this.log("drain could not be recorded", { error: String(err) });
      }
      this.log("drain started", { activeRuns: this.ctx.runs.listActive().length });
    }
    return this.runtimeStatus();
  }

  /** Decision 3: the drain ends unforced; queued runs and the runs it parked start again. */
  endDrain(): RuntimeStatus {
    if (this.drainStartedAt !== undefined) {
      this.log("drain ended", { startedAt: this.drainStartedAt });
      if (this.drainId !== undefined) {
        try {
          this.starts.drainEnded(this.drainId, this.clock());
        } catch (err) {
          this.log("drain end could not be recorded", { error: String(err) });
        }
      }
      this.drainStartedAt = undefined;
      this.drainId = undefined;
      this.kick();
    }
    return this.runtimeStatus();
  }

  /** `GET /api/runtime`: active runs, the drain and the restart breaker. */
  runtimeStatus(): RuntimeStatus {
    const activeRunIds = this.ctx.runs.listActive().map((run) => run.id);
    const parked = this.ctx.runs.listPlatformParked();
    const since = new Date(this.clock().getTime() - RESTART_BREAKER_WINDOW_MINUTES * 60_000);
    return {
      activeRuns: activeRunIds.length,
      activeRunIds,
      draining: this.draining,
      ...(this.drainStartedAt ? { drainStartedAt: this.drainStartedAt } : {}),
      drainParkedRunIds: parked
        .filter((run) => run.resumePayload?.platform === "drain")
        .map((run) => run.id),
      restartBreaker: {
        tripped: this.breakerTripped,
        startsInWindow: this.starts.countSince(since),
        limit: RESTART_BREAKER_LIMIT,
        windowMinutes: RESTART_BREAKER_WINDOW_MINUTES,
        heldRunIds: parked
          .filter((run) => run.config[PLATFORM_CONFIG.held] === true)
          .map((run) => run.id),
      },
    };
  }

  /**
   * Decision 6: an operator lets the runs the restart breaker held continue, all of them or the
   * ones named. Returns the runs it released.
   */
  releaseHeld(operator: string, runIds?: readonly RunId[]): RunId[] {
    const wanted = runIds ? new Set(runIds) : undefined;
    const released: RunId[] = [];
    for (const run of this.ctx.runs.listPlatformParked()) {
      if (run.config[PLATFORM_CONFIG.held] !== true) continue;
      if (wanted && !wanted.has(run.id)) continue;
      this.ctx.runs.setConfig(run.id, { [PLATFORM_CONFIG.held]: false });
      this.ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: PLATFORM_LOG_SOURCE, op: "released", by: operator },
      });
      released.push(run.id);
    }
    if (released.length > 0) this.kick();
    return released;
  }

  /** Decision 11: this Gateway is alive now; the next start reads it as when this one stopped. */
  private markAlive(): void {
    if (this.startId === undefined) return;
    const now = this.clock();
    if (now.getTime() - this.lastAliveMs < GATEWAY_ALIVE_INTERVAL_MS) return;
    this.lastAliveMs = now.getTime();
    try {
      this.starts.touch(this.startId, now);
    } catch (err) {
      this.log("gateway alive mark failed", { error: String(err) });
    }
  }

  /**
   * Decision 11: a cron round queued during a drain whose minute is older than the grace when it
   * could launch is cancelled as a misfire, not fired late.
   */
  private cancelCronMisfires(): void {
    const graceMs =
      (this.ctx.config.cronMisfireGraceMinutes ?? CRON_MISFIRE_GRACE_MINUTES_DEFAULT) * 60_000;
    const now = this.clock().getTime();
    for (const run of this.ctx.runs.listQueued()) {
      if (run.config.queuedInDrain !== true) continue;
      const minute = cronMinuteOf(run);
      if (minute === undefined || now - minute <= graceMs) continue;
      try {
        this.lifecycle.cancelCronMisfire(run.id, now - minute);
      } catch (err) {
        this.log("cron misfire cancellation failed", { runId: run.id, error: String(err) });
      }
    }
  }

  /**
   * Issue #21: every unfinished run of a thread past its deadline is cancelled, reason
   * `deadline`, and the thread's pending routing walks end with it, so nothing is woken next.
   * The periodic sweep runs this pass, so a deadline takes effect within one sweep interval.
   */
  private cancelPastDeadline(): void {
    const threads = new Set<string>();
    for (const run of this.ctx.runs.listUnfinishedPastDeadline()) {
      try {
        if (run.threadId && !threads.has(run.threadId)) {
          threads.add(run.threadId);
          this.ctx.walks.completePendingInThread(run.threadId);
        }
        this.lifecycle.cancelPastDeadline(run.id);
        this.killAfterGrace(run.id);
        this.capacityWaiting.delete(run.id);
      } catch (err) {
        this.log("deadline cancellation failed", { runId: run.id, error: String(err) });
      }
    }
  }

  /**
   * Hold one bot's starts and resumes while the operator moves its directories (a rename,
   * ADR-0043 decision 1). Refused while the bot has a live or parked run: a run's home and working
   * directory are fixed when it starts, and a parked run resumes in the ones it started in.
   */
  async withIdleBot<T>(botId: BotId, operation: () => Promise<T>): Promise<T> {
    const bot = this.ctx.bots.mustGet(botId);
    if (
      this.heldBots.has(botId) ||
      this.ctx.runs.listLiveInWorkspace(bot.workspaceId).some((run) => run.botId === botId)
    )
      throw new DeskmatesError("lane_busy", "Wait for this bot's current run before renaming it");
    if (this.ctx.runs.list({ botId }).some((run) => PARKED_RUN_STATUSES.has(run.status)))
      throw new DeskmatesError(
        "invalid_transition",
        "Finish or cancel this bot's parked run before renaming it",
      );
    this.heldBots.add(botId);
    try {
      return await operation();
    } finally {
      this.heldBots.delete(botId);
      this.kick();
    }
  }

  /** Hold new starts/resumes while the operator edits an idle workspace's files. */
  async withIdleWorkspace<T>(workspaceId: WorkspaceId, operation: () => Promise<T>): Promise<T> {
    if (
      this.maintenance.has(workspaceId) ||
      this.activeAttempts(workspaceId) > 0 ||
      this.ctx.runs.listLiveInWorkspace(workspaceId).length
    )
      throw new DeskmatesError(
        "lane_busy",
        "Wait for workspace runs or edits to finish before editing memory",
      );
    this.maintenance.add(workspaceId);
    try {
      return await operation();
    } finally {
      this.maintenance.delete(workspaceId);
      this.kick();
    }
  }

  /** Last measured disk use of each workspace, when a disk quota is configured. */
  private readonly disk = new Map<string, { mb: number; measuredMs: number }>();
  private readonly measuring = new Set<string>();

  /** The last measured disk use of a workspace in MiB, if one was taken. */
  diskUsage(workspaceId: WorkspaceId): number | undefined {
    return this.disk.get(workspaceId)?.mb;
  }

  /**
   * Measure what a workspace's volumes hold, with `du` inside its sandbox. Only while a disk
   * quota is configured; a sandbox that is not running keeps the last measurement.
   */
  async measureDisk(workspaceId: WorkspaceId): Promise<number | undefined> {
    if (this.measuring.has(workspaceId)) return this.disk.get(workspaceId)?.mb;
    this.measuring.add(workspaceId);
    try {
      const handle = await this.ctx.sandboxes.peek(workspaceId);
      if (!handle) return this.disk.get(workspaceId)?.mb;
      const result = await this.ctx.provider.exec(handle, {
        cmd: ["du", "-smc", "/work", "/home", "/profile"],
        timeoutMs: 60_000,
      });
      const total = /^(\d+)\s+total\s*$/m.exec(result.stdout);
      if (!total) return this.disk.get(workspaceId)?.mb;
      const mb = Number(total[1]);
      this.disk.set(workspaceId, { mb, measuredMs: Date.now() });
      this.kick();
      return mb;
    } catch (err) {
      this.log("disk usage measurement failed", { workspaceId, error: String(err) });
      return this.disk.get(workspaceId)?.mb;
    } finally {
      this.measuring.delete(workspaceId);
    }
  }

  /**
   * Record once why a run is waiting to start (suspended tenant, disk quota); the next pass
   * retries it.
   */
  private waitForCapacity(runId: RunId, payload: Record<string, unknown>): void {
    if (this.capacityWaiting.has(runId)) return;
    this.capacityWaiting.add(runId);
    this.ctx.events.append({ runId, kind: "log", payload: { source: "scheduler", ...payload } });
  }

  tenantActiveAttempts(tenantId: string): number {
    const workspaces = this.ctx.ownership.workspaceIds(tenantId);
    return [...this.attempts.values()].filter((a) => workspaces.has(a.workspaceId)).length;
  }

  activeAttempts(workspaceId: WorkspaceId): number {
    return [...this.attempts.values()].filter((a) => a.workspaceId === workspaceId).length;
  }

  /**
   * Cancel a run (issue #15): the lifecycle records `cancelled`, closes its approvals and revokes
   * its token, which is the stop request a live sidecar sees. The lane is free at once, so the
   * next pass may start the bot's next run; a process of this run still alive after
   * `cancelGraceMs` is killed by the provider. A terminal run throws `invalid_transition`.
   */
  cancel(runId: RunId, cancelledBy: string): RunRecord {
    const run = this.lifecycle.cancel(runId, cancelledBy);
    this.killAfterGrace(runId);
    this.kick();
    return run;
  }

  /** A process of this cancelled run still alive after `cancelGraceMs` is killed. */
  private killAfterGrace(runId: RunId): void {
    for (const [key, attempt] of this.attempts) {
      if (!key.startsWith(`${runId}#`) || attempt.killTimer !== undefined) continue;
      attempt.killTimer = setTimeout(() => {
        this.log("cancelled run's sidecar did not exit; killing it", { runId });
        attempt.abort.abort();
      }, this.cancelGraceMs);
      attempt.killTimer.unref();
    }
  }

  capacity(workspaceId: WorkspaceId): {
    activeAttempts: number;
    waitingRunIds: RunId[];
  } {
    return {
      activeAttempts: this.activeAttempts(workspaceId),
      waitingRunIds: [...this.capacityWaiting].filter((id) => {
        const run = this.ctx.runs.get(id);
        return (
          run &&
          (run.status === "queued" ||
            run.status === "waiting_approval" ||
            run.status === "waiting_continuation") &&
          this.ctx.bots.mustGet(run.botId).workspaceId === workspaceId
        );
      }),
    };
  }

  /** Runs still owned by a sidecar process; tests and shutdown wait on this. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.continuationSweep);
    clearInterval(this.stallSweep);
    this.unsubscribeStalls();
  }

  /**
   * ADR-0029 decision 4, on start: runs the ledger lists as live have no process this Gateway
   * started. First no old process may act for them: every token of theirs is revoked and their
   * sidecar is killed by run marker in its workspace, all before anything resumes. Then each is
   * parked for continuation (`waiting_platform`), requeued when it never reached the SDK, or
   * failed on its fourth interruption. Parked runs are left exactly as they are; the first `tick`
   * resumes the ones that may go. More than `RESTART_BREAKER_LIMIT` starts within the window trip
   * the breaker (decision 6): live runs park as above but none resumes until an operator says so.
   */
  async reconcile(): Promise<void> {
    this.pruneTokens(true);
    const now = this.clock();
    try {
      const { current, previous } = this.starts.record(now, this.ctx.config.release);
      this.startId = current.id;
      this.previousStart = previous;
      this.lastAliveMs = now.getTime();
      const since = new Date(now.getTime() - RESTART_BREAKER_WINDOW_MINUTES * 60_000);
      this.breakerTripped = this.starts.countSince(since) > RESTART_BREAKER_LIMIT;
    } catch (err) {
      this.log("gateway start could not be recorded", { error: String(err) });
    }
    const live = this.ctx.runs.listActive();
    for (const run of live) this.ctx.tokens.revokeForRun(run.id);
    for (const run of live) await this.killOldProcess(run);
    for (const run of live) {
      try {
        this.lifecycle.parkAfterRestart(run.id, { held: this.breakerTripped });
      } catch (err) {
        this.log("live run could not be parked after restart", {
          runId: run.id,
          error: String(err),
        });
        this.lifecycle.fail(run.id, `restart recovery failed: ${String(err)}`);
      }
    }
    if (this.breakerTripped) {
      const held: RunId[] = [];
      for (const run of this.ctx.runs.listPlatformParked()) {
        if (run.config[PLATFORM_CONFIG.held] !== true)
          this.ctx.runs.setConfig(run.id, { [PLATFORM_CONFIG.held]: true });
        held.push(run.id);
      }
      this.log("restart breaker tripped: platform-parked runs wait for an operator", {
        limit: RESTART_BREAKER_LIMIT,
        windowMinutes: RESTART_BREAKER_WINDOW_MINUTES,
        heldRunIds: held,
      });
    }
    this.ctx.router.continueWalks();
  }

  /** The sidecar an earlier Gateway started for this run, if it survived, killed by marker. */
  private async killOldProcess(run: RunRecord): Promise<void> {
    try {
      const workspaceId = this.ctx.bots.mustGetIncludingArchived(run.botId).workspaceId;
      const handle = await this.ctx.sandboxes.peek(workspaceId);
      if (!handle) return;
      await this.ctx.provider.killRun(handle, run.id);
      this.ctx.events.append({
        runId: run.id,
        kind: "log",
        payload: { source: PLATFORM_LOG_SOURCE, op: "killed", attempt: run.attempt },
      });
    } catch (err) {
      // Best effort: the token is revoked, so a survivor can reach neither the Gateway nor the
      // model; the kill only bounds what it does inside its workspace.
      this.log("old sidecar could not be killed", { runId: run.id, error: String(err) });
    }
  }

  /**
   * Housekeeping for `run_tokens`, which gains a row per sidecar process and had nothing that
   * ever removed one. Rate-limited: a busy Gateway kicks the scheduler many times a second.
   */
  private pruneTokens(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastTokenPruneMs < TOKEN_PRUNE_INTERVAL_MS) return;
    this.lastTokenPruneMs = now;
    try {
      const removed = this.ctx.tokens.pruneExpired();
      if (removed > 0) this.log("pruned dead run tokens", { removed });
    } catch (err) {
      // Housekeeping must never stop a scheduling pass.
      this.log("run token prune failed", { error: String(err) });
    }
  }

  private launch(run: RunRecord): void {
    const bot = this.ctx.bots.mustGet(run.botId);
    const workspaceId = bot.workspaceId;
    if (this.draining) return;
    if (this.maintenance.has(workspaceId) || this.heldBots.has(run.botId)) return;
    // ADR-0026 amendment 1: a paused bot's own work waits, a queued run and an answered parked one
    // alike, and starts when the bot is resumed. Gateway jobs hosted on the bot (a presentation
    // summary, a probe, a SOUL draft) carry a `runType` and are not the bot's work.
    if (bot.pausedAt !== undefined && run.config.runType === undefined) {
      this.waitForCapacity(run.id, { waitReason: "bot_paused" });
      return;
    }
    // The tenant is read from the persisted workspace, never from a trigger payload (ADR-0022
    // JOB-01). A run whose workspace has no tenant is an orphan and never starts a sidecar; a
    // suspended tenant's runs stay queued until it is active again.
    const tenantId = this.ctx.ownership.tenantOf("workspace", workspaceId);
    const tenant = tenantId === undefined ? undefined : this.ctx.auth.users.getTenant(tenantId);
    if (!tenantId || !tenant) {
      this.lifecycle.fail(run.id, "workspace has no tenant; refusing to start");
      return;
    }
    if (tenant.status !== "active") {
      this.waitForCapacity(run.id, { waitReason: "tenant_suspended" });
      return;
    }
    // No cap on concurrent sidecars per workspace or per tenant (ADR-0022 amendment 5): the
    // workspace container's CPU and memory limits bound what its runs use together, and a run
    // that waits for another bot's reply must never also wait for that bot's slot.
    // A workspace over its disk quota starts nothing until files are removed (LIMIT-01).
    const quotaMb = this.ctx.config.workspaceDiskQuotaMb ?? 0;
    const usage = this.disk.get(workspaceId);
    if (quotaMb > 0 && usage !== undefined && usage.mb > quotaMb) {
      if (Date.now() - usage.measuredMs >= DISK_REMEASURE_MS) void this.measureDisk(workspaceId);
      this.waitForCapacity(run.id, {
        waitReason: "workspace_disk_quota",
        usedMb: usage.mb,
        quotaMb,
      });
      return;
    }
    this.capacityWaiting.delete(run.id);
    // ADR-0032 decision 5: an exhausted workspace parks the run instead of starting it.
    if (parkIfExhausted(this.ctx, run)) return;
    // Issue #62 M8: a run this pass listed that a process has taken since is left to it; a
    // decision landing while a resumed process runs waits for the next park, it never fails it.
    const current = this.ctx.runs.get(run.id);
    if (current === undefined || current.status !== run.status || current.attempt !== run.attempt)
      return;
    let prepared: ReturnType<RunLifecycle["start"]>;
    try {
      prepared = this.lifecycle.start(run);
    } catch (err) {
      const failed = this.lifecycle.fail(run.id, `could not start run: ${String(err)}`);
      this.log("run could not start", {
        runId: run.id,
        error: String(err),
        status: failed?.status,
      });
      return;
    }
    // Keyed by attempt, not by run: a run parked by its first process and resumed by a second one
    // has two overlapping `exec` calls for the same run id, and the first one finishing must not
    // drop the second from the in-flight set.
    markAttemptStarted(this.ctx, run, prepared.request);
    const key = `${run.id}#${prepared.request.attempt}`;
    const attempt: Attempt = { workspaceId, abort: new AbortController() };
    this.attempts.set(key, attempt);
    const done = this.execute(prepared.run, prepared.request, attempt.abort.signal)
      .catch((err: unknown) => {
        // A throw after the exec (a busy database, a missing row) must not become an unhandled
        // rejection, which would exit the Gateway.
        this.log("run attempt ended with an error", { runId: run.id, error: String(err) });
      })
      .finally(() => {
        if (attempt.killTimer !== undefined) clearTimeout(attempt.killTimer);
        this.attempts.delete(key);
        this.inflight.delete(key);
        if (quotaMb > 0) void this.measureDisk(workspaceId);
        this.kick();
      });
    this.inflight.set(key, done);
  }

  private async execute(
    run: RunRecord,
    initialRequest: StartRunRequest,
    signal: AbortSignal,
  ): Promise<void> {
    let request = initialRequest;
    // ADR-0037: the attempt's sandbox, spawn and close marks. `closed` is recorded exactly once.
    const mark = (name: RunTimelineMark, attributes: Record<string, unknown> = {}): void =>
      recordTimelineMark(this.ctx, run.id, initialRequest.attempt, name, attributes);
    let spawned = false;
    try {
      const workspace = this.ctx.workspaces.mustGet(request.workspaceId);
      const sandbox: { origin?: SandboxOrigin; retried: boolean } = { retried: false };
      const handle = await this.ensureSandbox(workspace, sandbox);
      mark("sandbox_ready", {
        sandbox: sandbox.origin ?? "unknown",
        ...(sandbox.retried ? { sandboxRetried: true } : {}),
      });
      // Import every legacy bot's physical files before any model sees this workspace. The
      // canonical copies are then authoritative; peer snapshots detect later shared-file edits.
      const workspaceBots = this.ctx.bots.list(workspace.id);
      for (const bot of workspaceBots) {
        await ensureCanonicalSoul(this.ctx, bot.id);
        await ensureLegacyMemory(this.ctx, bot.id);
      }
      const canonicalSoul = this.ctx.bots.canonicalSoul(run.botId);
      const canonicalMemory = canonicalMemoryForBot(this.ctx, run.botId);
      // ADR-0043 decision 2: the numbered versions this attempt's files are, next to the hashes;
      // "last run used v N" on the bot page reads them.
      this.ctx.runs.setConfig(run.id, {
        canonicalSoulVersion: canonicalSoul?.version ?? null,
        canonicalMemoryVersion: canonicalMemory.version,
        ...ruleRevisionsOf(this.ctx, run.botId),
      });
      request = {
        ...request,
        canonicalFiles: {
          ...(canonicalSoul ? { soul: canonicalSoul } : {}),
          memory: canonicalMemory,
        },
        peerBotHomeDirs: workspaceBots
          .filter((bot) => bot.id !== run.botId)
          .map((bot) => `/home/${bot.name}`),
      };
      if (handle.botScreenAddresses) {
        const slot = this.ctx.screens.ensure(request.botId, workspace.id);
        request = { ...request, screenSlot: slot };
        this.ctx.runs.setConfig(run.id, { desktopMode: "shared-monitors-v1", screenSlot: slot });
      }
      // Issue #39 item 8: a model job is killed five seconds after its own deadline, which the
      // request carries (`MODEL_JOB_DEADLINE_MS`, 60 s in all by default).
      const timeoutMs = MODEL_JOB_RUN_TYPES.has(run.config.runType)
        ? modelJobKillMs(request.modelJobDeadlineMs, this.ctx.config.runTimeoutSeconds)
        : (run.config.runType === "approval_presentation" ||
          run.config.runType === "activity_summary"
            ? Math.min(60, this.ctx.config.runTimeoutSeconds)
            : this.ctx.config.runTimeoutSeconds) * 1000;
      // The sidecar takes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from this request, not from
      // the workspace env file: that file is one per workspace, so a per-run `injectEnv` would
      // hand a concurrent run in the same workspace the other run's token.
      mark("sidecar_spawned");
      spawned = true;
      const result = await this.execInWorkspace(
        workspace,
        {
          cmd: SIDECAR_RUN_CMD,
          // ADR-0029 decision 4: a later Gateway finds this process by it and kills it.
          env: { [RUN_MARKER_ENV]: run.id },
          stdin: JSON.stringify(request),
          // The provider kills the process tree at the deadline; the run is failed below.
          timeoutMs,
          signal,
        },
        handle,
      );
      // A Gateway that has stopped no longer owns the process it started (ADR-0029 decision 4):
      // the next one reconciles the run from the database, so this one writes nothing more.
      if (this.stopped) return;
      mark("attempt_closed", {
        spawned: true,
        exitCode: result.exitCode,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(signal.aborted ? { error: "cancelled" } : {}),
      });
      let after = this.ctx.runs.mustGet(run.id);
      // The run may already have been resumed by a later process while this one was exiting; the
      // `running` row it sees then belongs to that process, not this one. `attempt` is what tells
      // the two apart (ADR-0002 amendment 2, "resume keeps the ledger whole").
      const mine = (r: RunRecord): boolean => r.attempt === request.attempt;
      if (mine(after) && isExecuting(after.status)) {
        // A sidecar that could not deliver its run_ended post prints it as the last stdout line
        // (exit code 3). Taking it here turns a lost post into a normal end of run.
        const recovered = runEndedFromStdout(run.id, result.stdout);
        if (recovered !== undefined) {
          try {
            this.lifecycle.ended(run.id, recovered);
            this.log("run_ended recovered from sidecar stdout", { runId: run.id });
          } catch (err) {
            this.log("run_ended on stdout was unusable", { runId: run.id, error: String(err) });
          }
          after = this.ctx.runs.mustGet(run.id);
        }
      }
      // ADR-0029 decision 8: the process is gone; an attempt it never reported usage for (a
      // crash, the deadline, a cancellation) is filled in from the requests its token made.
      this.lifecycle.fillProxyUsage(run.id, initialRequest.attempt);
      if (mine(after) && isExecuting(after.status)) {
        // Keep the tail of stderr: without it a sidecar that died before its first event leaves
        // nothing to diagnose from.
        const tail = result.stderr.trim().split("\n").slice(-5).join(" | ").slice(-600);
        const why = result.timedOut
          ? `run exceeded RUN_TIMEOUT_SECONDS (${timeoutMs / 1000} s); sidecar killed`
          : `sidecar exited without run_ended (exit ${result.exitCode})`;
        this.lifecycle.fail(run.id, `${why}${tail === "" ? "" : `: ${tail}`}`);
      }
    } catch (err) {
      if (this.stopped) return;
      // The failure path must not throw itself; `launch` only logs what escapes `execute`.
      try {
        mark("attempt_closed", { spawned, error: "sandbox_error" });
        // Only this attempt's own live row: a late rejection of an older attempt must not fail a
        // run that attempt parked, or the later attempt that resumed it.
        const after = this.ctx.runs.get(run.id);
        if (after && after.attempt === request.attempt && isExecuting(after.status)) {
          this.lifecycle.fail(run.id, `sandbox error: ${String(err)}`);
        }
      } catch (failure) {
        this.log("sandbox error could not be recorded", {
          runId: run.id,
          error: String(err),
          failure: String(failure),
        });
      }
    }
  }

  /**
   * The workspace's sandbox, trying a second time when the first cannot be prepared. Nothing of
   * the run has happened yet (no sidecar, no model call), so a retry is free of side effects; a
   * container that never became healthy or a transient Docker error then costs one retry instead
   * of a failed run the human has to notice and resend (Testbox, 2026-09-29).
   */
  private async ensureSandbox(
    workspace: Workspace,
    observed: { origin?: SandboxOrigin; retried: boolean } = { retried: false },
  ): Promise<SandboxHandle> {
    const observe = (origin: SandboxOrigin): void => {
      observed.origin = origin;
    };
    try {
      return await this.ctx.sandboxes.ensure(workspace, observe);
    } catch (err) {
      if (!isDeskmatesError(err) || err.code !== "sandbox_unavailable") throw err;
      this.log("sandbox could not be prepared; retrying once", {
        workspaceId: workspace.id,
        error: String(err),
      });
      this.ctx.sandboxes.forget(workspace.id);
      observed.retried = true;
      return this.ctx.sandboxes.ensure(workspace, observe);
    }
  }

  /**
   * `exec` in the workspace's sandbox, recreating it once if it has gone. `SandboxRegistry` caches
   * a handle per workspace for the life of the process, so a container removed out of band
   * (`docker rm`, a daemon restart, an operator cleaning up) makes every later run fail with
   * `not_found` until the Gateway is restarted. Dropping the cached handle and asking for it again
   * creates a fresh container, which is what the operator expects.
   */
  private async execInWorkspace(
    workspace: Workspace,
    req: ExecRequest,
    handle: SandboxHandle,
  ): Promise<ExecResult> {
    try {
      return await this.ctx.provider.exec(handle, req);
    } catch (err) {
      if (!isDeskmatesError(err) || err.code !== "not_found") throw err;
      this.log("sandbox is gone; recreating it and retrying once", {
        workspaceId: workspace.id,
        error: String(err),
      });
      this.ctx.sandboxes.forget(workspace.id);
      const fresh = await this.ctx.sandboxes.ensure(workspace);
      return this.ctx.provider.exec(fresh, req);
    }
  }
}
