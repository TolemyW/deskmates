// Short model jobs (ADR-0023 amendment 1): the vision probe, the SOUL proposal, round triage and
// the rest below. All are runs (row first) that the scheduler starts like any background run (a
// triage job without waiting for its lane, ADR-0005 amendment 6); this module is the one place the
// run lifecycle asks what such a run sends to the sidecar and what its end means.

import {
  type BotDefinition,
  DeskmatesError,
  type ModelJobRequest,
  type RunEnded,
  type ThinkingConfig,
  type ThreadMessage,
} from "@deskmates/contracts";
import { APPROVAL_REVIEW } from "../approvals/auto-review.js";
import type { GatewayConfig } from "../config.js";
import { MODEL_JOB_DEADLINE_MS_DEFAULT, MODEL_JOB_KILL_GRACE_MS } from "../config/runs.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { MEMORY_ORGANIZE, MemoryOrganizer } from "../memory/organize.js";
import { MEMORY_RECHECK, MemoryRecheck } from "../memory/recheck.js";
import { ROUND_TRIAGE, RoundTriage } from "./round-triage.js";
import { SOUL_PROPOSAL, SoulProposals } from "./soul-proposals.js";
import { STATUS_INQUIRY, StatusInquiries } from "./status-inquiries.js";
import { VISION_PROBE, VisionProbes } from "./vision-probes.js";

/** Job kinds (`runs.config_json.runType`) that are model jobs: tool-free, one turn, 60 s. */
export const MODEL_JOB_RUN_TYPES: ReadonlySet<unknown> = new Set([
  APPROVAL_REVIEW,
  MEMORY_ORGANIZE,
  MEMORY_RECHECK,
  ROUND_TRIAGE,
  SOUL_PROPOSAL,
  STATUS_INQUIRY,
  VISION_PROBE,
]);

export class ModelJobs {
  /** Stateless views over the database; `context` is read when used, after the context exists. */
  constructor(private readonly context: () => GatewayContext) {}

  get vision(): VisionProbes {
    return new VisionProbes(this.context());
  }

  get souls(): SoulProposals {
    return new SoulProposals(this.context());
  }

  /** Guest status inquiries (ADR-0022 amendment 7). */
  get inquiries(): StatusInquiries {
    return new StatusInquiries(this.context());
  }

  /** Memory organisation jobs (ADR-0011 amendment 4, A30). */
  get organize(): MemoryOrganizer {
    return new MemoryOrganizer(this.context());
  }

  /** Automatic model rechecks of flagged notes (ADR-0011 amendment 4, A28). */
  get recheck(): MemoryRecheck {
    return new MemoryRecheck(this.context());
  }

  /** Round triage jobs (ADR-0005 amendment 6, decision 45). */
  get triage(): RoundTriage {
    return new RoundTriage(this.context());
  }

  /** The `modelJob` of a model job's `StartRunRequest`; undefined for every other run. */
  request(run: RunRecord, bot: BotDefinition): ModelJobRequest | undefined {
    if (run.config.runType === APPROVAL_REVIEW) return this.context().broker.reviews?.job(run);
    if (run.config.runType === MEMORY_ORGANIZE) return this.organize.jobRequest(run);
    if (run.config.runType === MEMORY_RECHECK) return this.recheck.jobRequest(run);
    if (run.config.runType === ROUND_TRIAGE) return this.triage.job(run, bot);
    if (run.config.runType === SOUL_PROPOSAL) return this.souls.job(run, bot);
    if (run.config.runType === STATUS_INQUIRY) return this.inquiries.job(run, bot);
    if (run.config.runType !== VISION_PROBE) return undefined;
    const probe = this.vision.get(String(run.config.probeId ?? ""));
    const code = probe?.id
      ? (this.context()
          .db.prepare("SELECT code FROM model_capability_probes WHERE id = ?")
          .get(probe.id) as { code: string } | undefined)
      : undefined;
    return code ? { kind: "vision_probe", code: code.code } : undefined;
  }

  /**
   * The final status of a model job's run, its result stored; undefined for any other run. A job
   * whose result is a thread message hands it to `publish` for after the commit.
   */
  complete(
    run: RunRecord,
    ended: RunEnded,
    publish: (message: ThreadMessage) => void = () => {},
  ): "succeeded" | "failed" | undefined {
    if (run.config.runType === APPROVAL_REVIEW)
      return this.context().broker.completeReview(run, ended);
    if (run.config.runType === MEMORY_ORGANIZE) return this.organize.complete(run, ended);
    if (run.config.runType === MEMORY_RECHECK) return this.recheck.complete(run, ended);
    if (run.config.runType === ROUND_TRIAGE) return this.triage.complete(run, ended);
    if (run.config.runType === SOUL_PROPOSAL) return this.souls.complete(run, ended);
    if (run.config.runType === STATUS_INQUIRY) return this.inquiries.complete(run, ended, publish);
    if (run.config.runType === VISION_PROBE) return this.vision.complete(run, ended);
    return undefined;
  }
}

/**
 * The `StartRunRequest` part of a model job: the job and its deadline (issue #39 item 8), which
 * is frozen on the run row at first start. A model-job run whose job cannot be built fails to
 * start rather than falling through to a full agent run with an empty prompt.
 */
export function modelJobSettings(
  ctx: GatewayContext,
  run: RunRecord,
  bot: BotDefinition,
): { modelJob?: ModelJobRequest; modelJobDeadlineMs?: number } {
  if (!MODEL_JOB_RUN_TYPES.has(run.config.runType)) return {};
  const modelJob = ctx.modelJobs.request(run, bot);
  if (!modelJob)
    throw new DeskmatesError("invalid_transition", "model job has no request", { runId: run.id });
  const frozen = run.config.modelJobDeadlineMs;
  const modelJobDeadlineMs =
    typeof frozen === "number" && Number.isSafeInteger(frozen) && frozen > 0
      ? frozen
      : (ctx.config.modelJobDeadlineMs ?? MODEL_JOB_DEADLINE_MS_DEFAULT);
  if (frozen !== modelJobDeadlineMs) ctx.runs.setConfig(run.id, { modelJobDeadlineMs });
  return { modelJob, modelJobDeadlineMs };
}

/**
 * The thinking a model job starts with when its run sets none (issue #39 item 8): disabled
 * unless `MODEL_JOB_THINKING=sdk-default`, which leaves the SDK's own default.
 *
 * A vision probe always keeps the SDK's default. It judges whether runs can be given images, and
 * those runs send the SDK's default request; SDK 0.3.278 sends a disabled thinking key as no key
 * at all, and one upstream never answered an image request without the key (every probe of it
 * timed out from 2026-10-22, while the same image with `adaptive` answered in 5 s).
 */
export function modelJobThinking(
  config: Pick<GatewayConfig, "modelJobThinking">,
  runType?: unknown,
): ThinkingConfig | undefined {
  if (runType === VISION_PROBE) return undefined;
  return config.modelJobThinking === "sdk-default" ? undefined : { type: "disabled" };
}

/**
 * When the Gateway kills a model job's process: `MODEL_JOB_KILL_GRACE_MS` after the job's own
 * deadline (60 s by default, ADR-0023 amendment 1 decision 5), never after `RUN_TIMEOUT_SECONDS`.
 */
export function modelJobKillMs(deadlineMs: number | undefined, runTimeoutSeconds: number): number {
  const deadline = deadlineMs ?? MODEL_JOB_DEADLINE_MS_DEFAULT;
  return Math.min(deadline + MODEL_JOB_KILL_GRACE_MS, runTimeoutSeconds * 1000);
}
