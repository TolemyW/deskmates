// Two-lane scheduler (design v0.3 §3.4, §5 step 2). A queued run starts only when its bot has no
// run occupying that lane. Starting a run is: issue a short-lived token, then `exec` the sidecar
// with the StartRunRequest on stdin, which carries `modelBaseUrl` and `modelAuthToken`. When
// `exec` resolves the sidecar process is gone; if it never sent `run_ended`, the run is `failed`.

import {
  DeskmatesError,
  type ExecRequest,
  type ExecResult,
  type RunEnded,
  type RunId,
  type SandboxHandle,
  type StartRunRequest,
  type Workspace,
  type WorkspaceId,
  isDeskmatesError,
  isPastDeadline,
  isTerminal,
} from "@deskmates/contracts";
import { ensureCanonicalSoul, ensureLegacyMemory } from "../api/memory-routes.js";
import { asRunEnded } from "../api/validate.js";
import { isReviewRun } from "../approvals/auto-review.js";
import { parkIfExhausted } from "../budget/admission.js";

/** A workspace over its disk quota is measured again at most this often while it waits. */
const DISK_REMEASURE_MS = 60_000;
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { canonicalMemoryForBot } from "../memory/canonical-memory.js";
import { isConsolidationRun } from "../memory/consolidation.js";
import { MODEL_JOB_RUN_TYPES } from "../model-jobs/model-jobs.js";
import type { RunLifecycle } from "./run-lifecycle.js";

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
  private lastTokenPruneMs = Number.NEGATIVE_INFINITY;
  private readonly continuationSweep: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly lifecycle: RunLifecycle,
    private readonly log: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    this.continuationSweep = setInterval(() => this.kick(), CONTINUATION_SWEEP_INTERVAL_MS);
    this.continuationSweep.unref();
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
    for (const run of this.ctx.memory.consolidation.requestEligible()) {
      this.ctx.bus.publish({ type: "run_status", run });
    }
    for (const id of this.capacityWaiting) {
      const run = this.ctx.runs.get(id);
      if (!run || isTerminal(run.status)) this.capacityWaiting.delete(id);
    }
    this.cancelPastDeadline();
    // Durable walks can be waiting on a lane that became free, or on a process lost at restart.
    // Create their next run before reading the queue so it can launch in this same pass.
    this.ctx.router.continueWalks();
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
        this.capacityWaiting.delete(run.id);
      } catch (err) {
        this.log("deadline cancellation failed", { runId: run.id, error: String(err) });
      }
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
    for (const [key, attempt] of this.attempts) {
      if (!key.startsWith(`${runId}#`) || attempt.killTimer !== undefined) continue;
      attempt.killTimer = setTimeout(() => {
        this.log("cancelled run's sidecar did not exit; killing it", { runId });
        attempt.abort.abort();
      }, this.cancelGraceMs);
      attempt.killTimer.unref();
    }
    this.kick();
    return run;
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
  }

  /**
   * After a restart: runs marked live in the ledger have no process; fail them. Parked runs
   * (`waiting_approval`, `waiting_browser`) are not live and are left exactly as they are — the
   * first `tick` after this resumes the ones whose approval was decided.
   */
  reconcile(): void {
    this.pruneTokens(true);
    for (const run of this.ctx.runs.listActive()) {
      this.lifecycle.fail(run.id, "gateway restarted while the run was live");
    }
    this.ctx.router.continueWalks();
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
    const workspaceId = this.ctx.bots.mustGet(run.botId).workspaceId;
    if (this.maintenance.has(workspaceId)) return;
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
    const key = `${run.id}#${prepared.request.attempt}`;
    const attempt: Attempt = { workspaceId, abort: new AbortController() };
    this.attempts.set(key, attempt);
    const done = this.execute(prepared.run, prepared.request, attempt.abort.signal).finally(() => {
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
    try {
      const workspace = this.ctx.workspaces.mustGet(request.workspaceId);
      const handle = await this.ensureSandbox(workspace);
      // Import every legacy bot's physical files before any model sees this workspace. The
      // canonical copies are then authoritative; peer snapshots detect later shared-file edits.
      const workspaceBots = this.ctx.bots.list(workspace.id);
      for (const bot of workspaceBots) {
        await ensureCanonicalSoul(this.ctx, bot.id);
        await ensureLegacyMemory(this.ctx, bot.id);
      }
      const canonicalSoul = this.ctx.bots.canonicalSoul(run.botId);
      const canonicalMemory = canonicalMemoryForBot(this.ctx, run.botId);
      this.ctx.runs.setConfig(run.id, {
        canonicalSoulVersion: canonicalSoul?.version ?? null,
        canonicalMemoryVersion: canonicalMemory.version,
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
      const timeoutSeconds =
        run.config.runType === "approval_presentation" ||
        run.config.runType === "activity_summary" ||
        MODEL_JOB_RUN_TYPES.has(run.config.runType)
          ? Math.min(60, this.ctx.config.runTimeoutSeconds)
          : this.ctx.config.runTimeoutSeconds;
      // The sidecar takes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from this request, not from
      // the workspace env file: that file is one per workspace, so a per-run `injectEnv` would
      // hand a concurrent run in the same workspace the other run's token.
      const result = await this.execInWorkspace(
        workspace,
        {
          cmd: SIDECAR_RUN_CMD,
          stdin: JSON.stringify(request),
          // The provider kills the process tree at the deadline; the run is failed below.
          timeoutMs: timeoutSeconds * 1000,
          signal,
        },
        handle,
      );
      let after = this.ctx.runs.mustGet(run.id);
      // The run may already have been resumed by a later process while this one was exiting; the
      // `running` row it sees then belongs to that process, not this one. `attempt` is what tells
      // the two apart (ADR-0002 amendment 2, "resume keeps the ledger whole").
      const mine = (r: RunRecord): boolean => r.attempt === request.attempt;
      if (mine(after) && (after.status === "running" || after.status === "waiting_approval_live")) {
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
      if (mine(after) && (after.status === "running" || after.status === "waiting_approval_live")) {
        // Keep the tail of stderr: without it a sidecar that died before its first event leaves
        // nothing to diagnose from.
        const tail = result.stderr.trim().split("\n").slice(-5).join(" | ").slice(-600);
        const why = result.timedOut
          ? `run exceeded RUN_TIMEOUT_SECONDS (${timeoutSeconds} s); sidecar killed`
          : `sidecar exited without run_ended (exit ${result.exitCode})`;
        this.lifecycle.fail(run.id, `${why}${tail === "" ? "" : `: ${tail}`}`);
      }
    } catch (err) {
      const after = this.ctx.runs.get(run.id);
      if (after && !isTerminal(after.status)) {
        this.lifecycle.fail(run.id, `sandbox error: ${String(err)}`);
      }
    }
  }

  /**
   * The workspace's sandbox, trying a second time when the first cannot be prepared. Nothing of
   * the run has happened yet (no sidecar, no model call), so a retry is free of side effects; a
   * container that never became healthy or a transient Docker error then costs one retry instead
   * of a failed run the human has to notice and resend (Testbox, 2026-09-29).
   */
  private async ensureSandbox(workspace: Workspace): Promise<SandboxHandle> {
    try {
      return await this.ctx.sandboxes.ensure(workspace);
    } catch (err) {
      if (!isDeskmatesError(err) || err.code !== "sandbox_unavailable") throw err;
      this.log("sandbox could not be prepared; retrying once", {
        workspaceId: workspace.id,
        error: String(err),
      });
      this.ctx.sandboxes.forget(workspace.id);
      return this.ctx.sandboxes.ensure(workspace);
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
