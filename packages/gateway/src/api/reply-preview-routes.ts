// `POST /internal/runs/:runId/reply-preview` (ADR-0037 decision 7): a live run's cumulative reply
// preview, relayed to its thread's stream as `run_reply_preview`. No ledger row and no message:
// the final reply stays the only record. The first frame of an attempt is marked on the
// startup timeline (`reply_preview_published`). Registered inside the run-token scope.

import {
  DeskmatesError,
  REPLY_PREVIEW_MAX_CHARS,
  type ReplyPreviewFrame,
  type RunId,
  supersedesPreview,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../context.js";
import { recordTimelineMark } from "../scheduler/run-timeline-marks.js";
import { asRecord } from "./validate.js";

type RunParams = { Params: { runId: string } };

/** Live statuses whose process may still be writing its reply. */
const LIVE = new Set(["running", "stalled", "waiting_approval_live"]);

/** Bound on remembered runs; the oldest entries go first. A forgotten run only re-marks. */
const MAX_TRACKED_RUNS = 1000;

export function registerReplyPreviewRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const last = new Map<RunId, Pick<ReplyPreviewFrame, "attempt" | "seq">>();
  app.post<RunParams>("/internal/runs/:runId/reply-preview", async (request) => {
    const runId = request.params.runId as RunId;
    const body = asRecord(request.body);
    const { attempt, seq, text } = body;
    if (
      body.type !== "reply_preview" ||
      body.runId !== runId ||
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      typeof seq !== "number" ||
      !Number.isInteger(seq) ||
      seq < 1 ||
      typeof text !== "string"
    ) {
      throw new DeskmatesError("validation", "malformed reply preview", { runId });
    }
    const run = ctx.runs.mustGet(runId);
    // Only the live process of the run's current attempt may preview; a late frame of an ended
    // or superseded attempt is dropped without an error, so the sidecar has nothing to retry.
    if (!run.threadId || run.attempt !== attempt || !LIVE.has(run.status))
      return { ok: true, accepted: false };
    const frame: ReplyPreviewFrame = {
      runId,
      threadId: run.threadId,
      botId: run.botId,
      attempt,
      seq,
      text: text.slice(0, REPLY_PREVIEW_MAX_CHARS),
    };
    const previous = last.get(runId);
    if (!supersedesPreview(previous, frame)) return { ok: true, accepted: false };
    if (previous?.attempt !== attempt) {
      recordTimelineMark(ctx, runId, attempt, "reply_preview_published", { seq });
    }
    last.delete(runId);
    last.set(runId, { attempt, seq });
    if (last.size > MAX_TRACKED_RUNS) {
      const oldest = last.keys().next().value;
      if (oldest !== undefined) last.delete(oldest);
    }
    ctx.bus.publish({ type: "run_reply_preview", threadId: run.threadId, preview: frame });
    return { ok: true, accepted: true };
  });
}
