// Streamed reply preview (ADR-0037 decision 7). While the model writes its summary block, the
// sidecar decodes the `reply` string as it grows and posts cumulative snapshots; the Gateway
// relays them over SSE without a ledger row. The final reply message stays authoritative: a
// preview is replaced by it and dropped when the run ends, parks or is cancelled.

import type { BotId, RunId, ThreadId } from "./ids.js";

/** A snapshot longer than this is cut; the final reply is never cut. */
export const REPLY_PREVIEW_MAX_CHARS = 16_000;

/** Sidecar → Gateway: `POST /internal/runs/:runId/reply-preview` with the run token. */
export interface ReplyPreviewRequest {
  type: "reply_preview";
  runId: RunId;
  /** `StartRunRequest.attempt`; a frame of another attempt is refused. */
  attempt: number;
  /** Increases with every frame of one attempt; a frame not above the last seen is ignored. */
  seq: number;
  /** The whole reply decoded so far, redacted; never a delta. */
  text: string;
}

/** Gateway → operator UI: SSE `run_reply_preview`, scoped to the run like `run_status`. */
export interface ReplyPreviewFrame {
  runId: RunId;
  threadId: ThreadId;
  botId: BotId;
  attempt: number;
  seq: number;
  text: string;
}

/**
 * Whether `next` replaces `current` for the same run: a later attempt, or a higher seq of the same
 * attempt. Duplicates and reordered frames are ignored, so a reconnect needs no replay.
 */
export function supersedesPreview(
  current: Pick<ReplyPreviewFrame, "attempt" | "seq"> | undefined,
  next: Pick<ReplyPreviewFrame, "attempt" | "seq">,
): boolean {
  if (!current) return true;
  if (next.attempt !== current.attempt) return next.attempt > current.attempt;
  return next.seq > current.seq;
}
