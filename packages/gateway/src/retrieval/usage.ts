// ADR-0041 decision 8: one `retrieval_calls` row per embedding or rerank request, ok or not.
// The local services are priced as known zero (owner decisions 2026-10-14, item 9), so no cost
// is computed here; tokens are what the service reported, NULL when it reported none.

import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import { RetrievalCallError } from "./clients.js";

export type RetrievalCorpus = "knowledge" | "memory";

export interface RetrievalCallRecord {
  tenantId: string;
  runId?: string;
  corpus: RetrievalCorpus;
  purpose: "index" | "query";
  service: "embedding" | "rerank";
  model: string;
  inputs: number;
  inputTokens: number | null;
  durationMs: number;
  outcome: "ok" | "error" | "timeout";
}

export interface RetrievalUsageSummary {
  service: "embedding" | "rerank";
  purpose: "index" | "query";
  outcome: "ok" | "error" | "timeout";
  calls: number;
  inputs: number;
  /** Sum over calls that reported tokens. */
  inputTokens: number;
  /** Calls whose tokens are unknown. */
  unknownTokenCalls: number;
}

export class RetrievalUsage {
  constructor(
    private readonly db: GatewayDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(call: RetrievalCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO retrieval_calls (id, tenant_id, run_id, corpus, purpose, service, model,
           inputs, input_tokens, duration_ms, outcome, created_at)
         VALUES (?, ?, (SELECT id FROM runs WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("rcall"),
        call.tenantId,
        call.runId ?? null,
        call.corpus,
        call.purpose,
        call.service,
        call.model,
        call.inputs,
        call.inputTokens,
        Math.max(0, Math.round(call.durationMs)),
        call.outcome,
        this.clock().toISOString(),
      );
  }

  /**
   * Time `call`, record it, and return its result; a failure is recorded with its outcome and
   * rethrown. `tokens` reads the reported tokens from a result.
   */
  async timed<T>(
    base: Omit<RetrievalCallRecord, "inputTokens" | "durationMs" | "outcome">,
    call: () => Promise<T>,
    tokens: (result: T) => number | null,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await call();
      this.record({
        ...base,
        inputTokens: tokens(result),
        durationMs: performance.now() - started,
        outcome: "ok",
      });
      return result;
    } catch (error) {
      this.record({
        ...base,
        inputTokens: null,
        durationMs: performance.now() - started,
        outcome: error instanceof RetrievalCallError ? error.outcome : "error",
      });
      throw error;
    }
  }

  /** A tenant's calls since an instant, grouped by service, purpose and outcome. */
  summary(tenantId: string, since: Date): RetrievalUsageSummary[] {
    return this.db
      .prepare(
        `SELECT service, purpose, outcome, count(*) AS calls, sum(inputs) AS inputs,
                coalesce(sum(input_tokens), 0) AS inputTokens,
                sum(input_tokens IS NULL) AS unknownTokenCalls
           FROM retrieval_calls WHERE tenant_id = ? AND created_at >= ?
          GROUP BY service, purpose, outcome ORDER BY service, purpose, outcome`,
      )
      .all(tenantId, since.toISOString()) as RetrievalUsageSummary[];
  }

  /** The calls one run's tools caused, oldest first. */
  forRun(runId: string): (RetrievalCallRecord & { createdAt: string })[] {
    return (
      this.db
        .prepare(
          `SELECT tenant_id, run_id, corpus, purpose, service, model, inputs, input_tokens,
                  duration_ms, outcome, created_at
             FROM retrieval_calls WHERE run_id = ? ORDER BY created_at, rowid`,
        )
        .all(runId) as {
        tenant_id: string;
        run_id: string;
        corpus: RetrievalCorpus;
        purpose: "index" | "query";
        service: "embedding" | "rerank";
        model: string;
        inputs: number;
        input_tokens: number | null;
        duration_ms: number;
        outcome: "ok" | "error" | "timeout";
        created_at: string;
      }[]
    ).map((row) => ({
      tenantId: row.tenant_id,
      runId: row.run_id,
      corpus: row.corpus,
      purpose: row.purpose,
      service: row.service,
      model: row.model,
      inputs: row.inputs,
      inputTokens: row.input_tokens,
      durationMs: row.duration_ms,
      outcome: row.outcome,
      createdAt: row.created_at,
    }));
  }
}
