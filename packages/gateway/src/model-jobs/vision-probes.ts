// Vision capability probes (ADR-0023 amendment 1, decisions 5 to 9; issue #87). The Gateway
// queues a probe as a run (row first), the sidecar relays the model's answer, and the Gateway
// grades it here against the code it chose and the image evidence the model proxy recorded. The
// Gateway never calls a model. One row per probe is kept as its receipt.

import { createHash, randomInt } from "node:crypto";
import {
  type BotDefinition,
  type CapabilityStatus,
  DeskmatesError,
  type ModelCapabilityView,
  type RunEnded,
  type RunId,
  type RunModelCapabilities,
  VISION_PROBE_ADAPTER_REVISION,
  VISION_PROBE_ATTEMPTS_PER_DAY,
  type VisionProbeReason,
  type VisionProbeTrigger,
  type VisionProbeView,
  type WorkspaceId,
  isTerminal,
  visionPolicyFor,
} from "@deskmates/contracts";
import { modelRegistryOf } from "../config/model-upstreams.js";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { RunRecord } from "../ledger/runs.js";

export const VISION_PROBE = "vision_probe";

interface ProbeRow {
  id: string;
  workspace_id: string;
  model: string;
  status: CapabilityStatus;
  reason: VisionProbeReason | null;
  trigger: VisionProbeTrigger;
  run_id: string | null;
  code: string;
  answer: string | null;
  image_blocks: number | null;
  input_tokens: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** The part of the cache key that comes from configuration, not from the workspace or model. */
export function endpointSha256(modelBaseUrl: string): string {
  return createHash("sha256").update(modelBaseUrl.trim().replace(/\/+$/, ""), "utf8").digest("hex");
}

function view(row: ProbeRow): VisionProbeView {
  return {
    id: row.id,
    model: row.model,
    status: row.status,
    reason: row.reason,
    trigger: row.trigger,
    runId: row.run_id,
    answer: row.answer,
    imageBlocks: row.image_blocks,
    inputTokens: row.input_tokens,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function notProbed(model: string): VisionProbeView {
  return { id: null, model, status: "unknown", reason: "not_probed" };
}

/** What an answer says about the code; grading needs transport evidence on top (decision 7). */
export function gradeVisionAnswer(answer: string, code: string): "match" | "refusal" | "wrong" {
  const digits = answer.replace(/\D/g, "");
  if (digits === code) return "match";
  if (
    digits === "" &&
    /\bno image\b|\b(cannot|can't|can not|unable to|could not|couldn't) (see|view|read|access)\b/i.test(
      answer,
    )
  )
    return "refusal";
  return "wrong";
}

export class VisionProbes {
  constructor(private readonly ctx: GatewayContext) {}

  /**
   * The configuration part of one model's cache key: its own upstream's URL (ADR-0039 decision
   * 6), so a model on `default` keeps its pre-registry key. An unroutable model keys on the empty
   * URL; its probe cannot reach a model anyway.
   */
  private keyFor(model: string) {
    return {
      endpoint: endpointSha256(modelRegistryOf(this.ctx.config).resolve(model)?.baseUrl ?? ""),
      revision: VISION_PROBE_ADAPTER_REVISION,
    };
  }

  private rows(workspaceId: WorkspaceId, model: string, limit: number): ProbeRow[] {
    const { endpoint, revision } = this.keyFor(model);
    return this.ctx.db
      .prepare(
        `SELECT * FROM model_capability_probes
          WHERE workspace_id = ? AND capability = 'vision' AND model = ?
            AND endpoint_sha256 = ? AND adapter_revision = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(workspaceId, model, endpoint, revision, limit) as ProbeRow[];
  }

  /** The current result for this workspace, model and configuration; never queues a probe. */
  current(workspaceId: WorkspaceId, model: string): VisionProbeView {
    const [latest] = this.rows(workspaceId, model, 1);
    return latest ? view(latest) : notProbed(model);
  }

  /** The models a workspace uses: every active bot's effective model and the deployment default. */
  modelsInUse(workspaceId: WorkspaceId): string[] {
    const models = new Set<string>([this.ctx.config.defaultModel]);
    for (const bot of this.ctx.bots.list(workspaceId)) models.add(this.effectiveModel(bot));
    return [...models].sort();
  }

  /** Each model in use with its vision policy and its bots (ADR-0023 amendment 2, decision 14). */
  list(workspaceId: WorkspaceId): ModelCapabilityView[] {
    const bots = this.ctx.bots.list(workspaceId).filter((bot) => !bot.archivedAt);
    return this.modelsInUse(workspaceId).map((model) => {
      const vision = this.current(workspaceId, model);
      return {
        model,
        vision,
        visionPolicy: visionPolicyFor(vision),
        botIds: bots.filter((bot) => this.effectiveModel(bot) === model).map((bot) => bot.id),
      };
    });
  }

  effectiveModel(bot: Pick<BotDefinition, "model">): string {
    return bot.model ?? this.ctx.config.defaultModel;
  }

  /** What a run records at start for its frozen model (decision 9). */
  snapshot(workspaceId: WorkspaceId, model: string): RunModelCapabilities {
    const current = this.current(workspaceId, model);
    return {
      vision: {
        status: current.status,
        reason: current.status === "pending" ? null : current.reason,
        probeId: current.id,
      },
    };
  }

  /** A pending probe whose run ended without a graded result is settled `unknown` (decision 8). */
  private settleStale(workspaceId: WorkspaceId, model: string): void {
    for (const row of this.rows(workspaceId, model, 5)) {
      if (row.status !== "pending") continue;
      const run = row.run_id ? this.ctx.runs.get(row.run_id as RunId) : undefined;
      if (run && !isTerminal(run.status)) continue;
      this.finish(row.id, "unknown", "job_failed", {
        error: run ? `probe run ended ${run.status} without a result` : "probe run is gone",
      });
    }
  }

  private hostBot(workspaceId: WorkspaceId, model: string, preferred?: BotDefinition) {
    if (preferred && !preferred.archivedAt) return preferred;
    const bots = this.ctx.bots.list(workspaceId);
    return bots.find((bot) => this.effectiveModel(bot) === model) ?? bots[0];
  }

  /**
   * Queue one probe unless this key already has a pending probe or, for anything but a retry, a
   * result. Returns the probe that answers the request. Never calls a model.
   */
  queue(input: {
    workspaceId: WorkspaceId;
    model: string;
    trigger: VisionProbeTrigger;
    requestedBy: string;
    host?: BotDefinition;
  }): { probe: VisionProbeView; run?: RunRecord } {
    const { workspaceId, model, trigger } = input;
    // `VISION_PROBE=off` stops automatic probes only; an operator's Retry is explicit.
    if (trigger !== "retry" && this.ctx.config.visionProbe !== "auto")
      return { probe: this.current(workspaceId, model) };
    return this.ctx.db.transaction(() => {
      this.settleStale(workspaceId, model);
      const recent = this.rows(workspaceId, model, 50);
      const pending = recent.find((row) => row.status === "pending");
      if (pending) return { probe: view(pending) };
      if (trigger !== "retry" && recent.length > 0) return { probe: view(recent[0] as ProbeRow) };
      if (trigger === "retry") {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        // Only explicit retries count; the automatic probes are bounded by their own triggers.
        const attempts = recent.filter(
          (row) => row.trigger === "retry" && row.created_at >= since && row.reason !== "blocked",
        );
        if (attempts.length >= VISION_PROBE_ATTEMPTS_PER_DAY)
          throw new DeskmatesError(
            "rate_limited",
            `at most ${VISION_PROBE_ATTEMPTS_PER_DAY} vision probes per model in 24 hours`,
            { model },
          );
      }
      const { endpoint, revision } = this.keyFor(model);
      const id = newId("probe");
      const code = String(randomInt(1000, 10000));
      const now = new Date().toISOString();
      const host = this.hostBot(workspaceId, model, input.host);
      const insert = (
        status: CapabilityStatus,
        runId: string | null,
        reason: string | null,
        error: string | null,
      ) =>
        this.ctx.db
          .prepare(
            `INSERT INTO model_capability_probes
               (id, workspace_id, capability, model, endpoint_sha256, adapter_revision, status,
                reason, trigger, run_id, code, error, requested_by, created_at, finished_at)
             VALUES (?, ?, 'vision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            workspaceId,
            model,
            endpoint,
            revision,
            status,
            reason,
            trigger,
            runId,
            code,
            error,
            input.requestedBy,
            now,
            status === "pending" ? null : now,
          );
      if (!host) {
        // Decision 5: no implicit bot. The result says why there is none.
        insert("unknown", null, "blocked", "no active bot in this workspace can host the probe");
        return { probe: this.get(id) as VisionProbeView };
      }
      // Run row first: the probe is a background run of the host bot on the probed model only.
      const run = this.ctx.runs.create({
        botId: host.id,
        lane: "background",
        triggerKind: "cron",
        triggerRef: `${VISION_PROBE}:${id}`,
        triggerPayload: { prompt: "" },
        config: {
          ...this.ctx.runConfig(),
          runType: VISION_PROBE,
          probeId: id,
          model,
          cheapModel: model,
          // A fallback would answer for a different model than the one probed.
          fallbackModel: null,
          maxTurns: 1,
          visionProbeRevision: VISION_PROBE_ADAPTER_REVISION,
        },
      });
      insert("pending", run.id, null, null);
      return { probe: this.get(id) as VisionProbeView, run };
    })();
  }

  get(id: string): VisionProbeView | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM model_capability_probes WHERE id = ?").get(id) as
      | ProbeRow
      | undefined;
    return row ? view(row) : undefined;
  }

  /** Writes only this probe's own row, and only while it is pending (decision 8). */
  private finish(
    id: string,
    status: Exclude<CapabilityStatus, "pending">,
    reason: VisionProbeReason,
    extra: {
      answer?: string;
      imageBlocks?: number | null;
      inputTokens?: number | null;
      error?: string;
    },
  ): void {
    this.ctx.db
      .prepare(
        `UPDATE model_capability_probes
            SET status = ?, reason = ?, answer = ?, image_blocks = ?, input_tokens = ?, error = ?,
                finished_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        reason,
        extra.answer ?? null,
        extra.imageBlocks ?? null,
        extra.inputTokens ?? null,
        extra.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  /** Grade a probe run's end (decision 7). Returns the run's final status. */
  complete(run: RunRecord, ended: RunEnded): "succeeded" | "failed" {
    const id = typeof run.config.probeId === "string" ? run.config.probeId : "";
    const row = this.ctx.db
      .prepare("SELECT * FROM model_capability_probes WHERE id = ? AND run_id = ?")
      .get(id, run.id) as ProbeRow | undefined;
    const requests = this.ctx.modelRequests.list(run.id);
    const forwarded = requests.filter((r) => r.refusal === null && r.servedModel !== null);
    const imageBlocks = forwarded.length
      ? Math.max(...forwarded.map((r) => r.imageBlocks ?? 0))
      : null;
    const tokens = requests.map((r) => r.inputTokens).filter((n): n is number => n !== null);
    const inputTokens = tokens.length ? tokens.reduce((a, b) => a + b, 0) : null;
    const answer = ended.outcome === "completed" ? (ended.summary?.reply ?? "").trim() : "";
    if (!row) return answer ? "succeeded" : "failed";
    const receipt = { answer: answer.slice(0, 200), imageBlocks, inputTokens };
    if (!answer) {
      this.finish(row.id, "unknown", "job_failed", {
        ...receipt,
        error: (ended.error ?? `probe run ended ${ended.outcome}`).slice(0, 500),
      });
      return "failed";
    }
    const grade = gradeVisionAnswer(answer, row.code);
    const evidence = imageBlocks !== null && imageBlocks > 0;
    if (!evidence) this.finish(row.id, "unknown", "no_transport_evidence", receipt);
    else if (grade === "match") this.finish(row.id, "supported", "verified_answer", receipt);
    else if (grade === "refusal") this.finish(row.id, "unsupported", "explicit_refusal", receipt);
    else this.finish(row.id, "unknown", "wrong_answer", receipt);
    return "succeeded";
  }

  /** Decision 6: once at Gateway start, every model in use without a result for the current key. */
  sweep(): RunRecord[] {
    const runs: RunRecord[] = [];
    for (const workspace of this.ctx.db
      .prepare("SELECT id FROM workspaces WHERE archived_at IS NULL")
      .all() as { id: WorkspaceId }[]) {
      if (this.ctx.bots.list(workspace.id).length === 0) continue;
      for (const model of this.modelsInUse(workspace.id)) {
        if (this.rows(workspace.id, model, 1).length > 0) continue;
        try {
          const queued = this.queue({
            workspaceId: workspace.id,
            model,
            trigger: "startup",
            requestedBy: "system:startup",
          });
          if (queued.run) runs.push(queued.run);
        } catch {
          // A probe that cannot be queued leaves the model at `unknown`; startup goes on.
        }
      }
    }
    return runs;
  }
}
