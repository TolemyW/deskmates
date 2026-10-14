// `model_requests`: one row per request the model proxy forwards (M3 context plan, Phase 1).
// It holds the request's model, whether it streamed, a sha256 of its `system` field and the usage
// the response reported, never any text. `seq` numbers a run's requests in arrival order. Token
// counts are NULL until the response's usage is seen, and stay NULL when it never is: unknown,
// not zero. A request the proxy refused (ADR-0023 decision 1) is a row too, with its `refusal`
// and the id it named; one the proxy rewrote keeps the id it named in `rewrittenFrom`.

import type { RunId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export type ModelRequestKind = "messages" | "count_tokens";

/** Why the proxy refused a request (ADR-0023 decision 1): its body named no frozen model. */
export type ModelRefusal = "model_not_selected";

export interface ModelRequestInput {
  runId: RunId;
  attempt: number;
  ts: string;
  requestKind: ModelRequestKind;
  model?: string;
  systemSha256?: string;
  stream: boolean;
  /** The id the request named when the proxy rewrote it; `model` is then the id forwarded. */
  rewrittenFrom?: string;
  /** Set when the proxy refused the request; it never reached the upstream. */
  refusal?: ModelRefusal;
  /** Image blocks the body carried (ADR-0023 amendment 1); absent when it was unreadable. */
  imageBlocks?: number;
}

export interface ModelRequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** Reported by the upstream in `output_tokens_details`; absent means unknown, never zero. */
  thinkingTokens?: number;
  /**
   * The `model` a successful response named (ADR-0023 decision 3); absent on a failure or when
   * the response named none. Never filled in from the request.
   */
  servedModel?: string;
}

export interface ModelRequestRecord {
  runId: RunId;
  attempt: number;
  seq: number;
  ts: string;
  requestKind: ModelRequestKind;
  model: string | null;
  systemSha256: string | null;
  stream: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
  thinkingTokens: number | null;
  rewrittenFrom: string | null;
  refusal: ModelRefusal | null;
  servedModel: string | null;
  imageBlocks?: number | null;
}

interface ModelRequestRow {
  run_id: string;
  attempt: number;
  seq: number;
  ts: string;
  request_kind: ModelRequestKind;
  model: string | null;
  system_sha256: string | null;
  stream: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_create_tokens: number | null;
  thinking_tokens: number | null;
  rewritten_from: string | null;
  refusal: ModelRefusal | null;
  served_model: string | null;
  image_blocks: number | null;
}

export class ModelRequestStore {
  constructor(private readonly db: GatewayDb) {}

  /** Records a request as it starts; returns the row id `setUsage` takes. */
  insert(input: ModelRequestInput): number {
    // One statement, so the next seq and the insert cannot interleave with another request.
    const result = this.db
      .prepare(
        `INSERT INTO model_requests
           (run_id, attempt, seq, ts, request_kind, model, system_sha256, stream,
            rewritten_from, refusal, image_blocks)
         SELECT ?, ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?
           FROM model_requests WHERE run_id = ?`,
      )
      .run(
        input.runId,
        input.attempt,
        input.ts,
        input.requestKind,
        input.model ?? null,
        input.systemSha256 ?? null,
        input.stream ? 1 : 0,
        input.rewrittenFrom ?? null,
        input.refusal ?? null,
        input.imageBlocks ?? null,
        input.runId,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Fills the counts the response reported and the model it named; a count it did not report, or
   * a model it did not name, stays NULL.
   */
  setUsage(id: number, usage: ModelRequestUsage): void {
    this.db
      .prepare(
        `UPDATE model_requests SET
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_create_tokens = ?,
           thinking_tokens = ?, served_model = ?
         WHERE id = ?`,
      )
      .run(
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.cacheReadTokens ?? null,
        usage.cacheCreateTokens ?? null,
        usage.thinkingTokens ?? null,
        usage.servedModel ?? null,
        id,
      );
  }

  list(runId: RunId): ModelRequestRecord[] {
    return this.listForRuns([runId]);
  }

  /** Every request of the given runs, ordered by run and sequence; one statement per chunk. */
  listForRuns(runIds: readonly RunId[]): ModelRequestRecord[] {
    const out: ModelRequestRecord[] = [];
    for (let i = 0; i < runIds.length; i += 500) {
      const chunk = runIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT run_id, attempt, seq, ts, request_kind, model, system_sha256, stream,
                  input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, thinking_tokens,
                  rewritten_from, refusal, served_model, image_blocks
             FROM model_requests WHERE run_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY run_id, seq`,
        )
        .all(...chunk) as ModelRequestRow[];
      for (const r of rows)
        out.push({
          runId: r.run_id as RunId,
          attempt: r.attempt,
          seq: r.seq,
          ts: r.ts,
          requestKind: r.request_kind,
          model: r.model,
          systemSha256: r.system_sha256,
          stream: r.stream === 1,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreateTokens: r.cache_create_tokens,
          thinkingTokens: r.thinking_tokens,
          rewrittenFrom: r.rewritten_from,
          refusal: r.refusal,
          servedModel: r.served_model,
          imageBlocks: r.image_blocks,
        });
    }
    return out;
  }
}
