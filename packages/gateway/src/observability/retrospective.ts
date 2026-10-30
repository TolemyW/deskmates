// The failure retrospective (ADR-0046 decision 9, amendment 2 decisions 23 to 26). It walks the
// ledger's finished runs in `finished_at` order, embeds the Activity summary each one shows
// (ADR-0033) through ADR-0041's embedding client, stores the vectors in the sink's vector store,
// and for every failed run stores its nearest succeeded runs of the same workspace with their
// cosine similarity, computed here as a dot product of normalised vectors.
//
// Rules the walk keeps:
// - a run in a private chat is never embedded, so it is never matched or offered (decision 17);
// - a run marked wrong (ADR-0042) is never offered as a match;
// - every embedding request writes one `retrieval_calls` row (corpus `retrospective`);
// - similarities are stored unfiltered; any threshold is the dashboard's (decision 10);
// - its position lives in the sink beside the vectors, so moving `obs.sqlite` aside starts it
//   again from the beginning, consistently.
//
// Measurement only: no Gateway decision reads what this writes, and the only thing it reads back
// from the sink is the vectors it wrote, to score them.

import {
  type ObservabilityRetrospectiveCursor,
  type ObservabilityRetrospectiveMatch,
  type ObservabilityRetrospectiveStatus,
  type ObservabilityRunVector,
  type ObservabilityVectorStore,
  type RunSummary,
  fitsActivitySummary,
} from "@deskmates/contracts";
import type { RetrievalServiceConfig } from "../config/retrieval.js";
import type { GatewayDb } from "../db/open.js";
import { outcomeTextOf, sourceVersionOf } from "../ledger/activity-summaries.js";
import { classifyFailure } from "../ledger/failure-class.js";
import { EmbeddingClient, type RetrievalFetch } from "../retrieval/clients.js";
import { RetrievalUsage } from "../retrieval/usage.js";
import { dot } from "../retrieval/vectors.js";
import { SETTLE_MS } from "./ledger-reader.js";

/** Matches stored per failed run (decision 25). */
export const RETROSPECTIVE_MATCHES = 5;
/** How long a pending Activity summary holds the walk before its run is skipped (decision 24). */
export const SUMMARY_WAIT_MS = 15 * 60 * 1000;
/** Inputs per embedding request, as the ADR-0041 indexer sends. */
export const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE = 200;

export interface RetrospectiveOptions {
  db: GatewayDb;
  vectors: ObservabilityVectorStore;
  embedding: RetrievalServiceConfig;
  fetch?: RetrievalFetch;
  now?: () => Date;
  pageSize?: number;
  timeoutMs?: number;
}

export interface RetrospectiveStep {
  /** The walk read a full page and was not held: step again soon. */
  backlog: boolean;
}

interface FinishedRun {
  id: string;
  workspace_id: string;
  tenant_id: string;
  status: "succeeded" | "failed";
  attempt: number;
  error: string | null;
  summary_json: string | null;
  finished_at: string;
  private: number;
  summary_status: "pending" | "ready" | "failed" | null;
  summary_text: string | null;
}

interface Item {
  run: FinishedRun;
  text: string;
  sourceVersion: string;
}

function parseSummary(json: string | null): RunSummary | undefined {
  if (json === null) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as RunSummary) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Activity summary the run shows (ADR-0033 decision 5): the verbatim outcome when it fits,
 * else the ready summary of its current source version. `hold` when that summary may still come.
 */
function summaryOf(run: FinishedRun, now: Date): { text: string } | "skip" | "hold" {
  const summary = parseSummary(run.summary_json);
  const outcome = outcomeTextOf({
    status: run.status,
    error: run.error ?? undefined,
    ...(summary ? { summary } : {}),
  } as Parameters<typeof outcomeTextOf>[0]);
  if (outcome === "") return "skip";
  if (fitsActivitySummary(outcome)) return { text: outcome };
  if (run.summary_status === "ready" && run.summary_text?.trim())
    return { text: run.summary_text.trim() };
  if (run.summary_status === "failed" || run.summary_status === "ready") return "skip";
  return now.getTime() - Date.parse(run.finished_at) < SUMMARY_WAIT_MS ? "hold" : "skip";
}

export class Retrospective {
  private readonly client: EmbeddingClient;
  private readonly usage: RetrievalUsage;
  private readonly now: () => Date;
  private position: ObservabilityRetrospectiveCursor | null = null;
  private embedded = 0;
  private matched = 0;
  private lastError: ObservabilityRetrospectiveStatus["lastError"] = null;

  constructor(private readonly opts: RetrospectiveOptions) {
    this.client = new EmbeddingClient(opts.embedding, opts.fetch ?? globalThis.fetch);
    this.now = opts.now ?? (() => new Date());
    this.usage = new RetrievalUsage(opts.db, this.now);
  }

  status(): ObservabilityRetrospectiveStatus {
    return {
      embeddingModel: this.opts.embedding.model,
      position: this.position ? `${this.position.at} ${this.position.id}` : null,
      embedded: this.embedded,
      matched: this.matched,
      lastError: this.lastError,
    };
  }

  /** One pass over at most a page of finished runs. A failure is recorded and rethrown. */
  async step(): Promise<RetrospectiveStep> {
    try {
      const result = await this.walk();
      this.lastError = null;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = { at: this.now().toISOString(), message };
      throw err;
    }
  }

  private async walk(): Promise<RetrospectiveStep> {
    const { vectors } = this.opts;
    const model = this.opts.embedding.model;
    const now = this.now();
    const start = await vectors.cursor();
    this.position = start;
    const page = this.opts.pageSize ?? DEFAULT_PAGE;
    const runs = this.finishedRuns(start, now, page);

    // Decide every run of the page in order; stop at the first one whose summary may still come.
    const decided: Array<{ run: FinishedRun; item?: Item }> = [];
    let held = false;
    for (const run of runs) {
      if (run.private === 1) {
        decided.push({ run });
        continue;
      }
      const summary = summaryOf(run, now);
      if (summary === "hold") {
        held = true;
        break;
      }
      decided.push(
        summary === "skip"
          ? { run }
          : { run, item: { run, text: summary.text, sourceVersion: sourceVersionOf(run) } },
      );
    }
    const stored = await vectors.embeddedVersions(
      model,
      decided.flatMap((d) => (d.item ? [d.run.id] : [])),
    );

    // Consecutive runs of one tenant share a request (`retrieval_calls` is per tenant); the
    // position moves after each chunk is stored, so a failed request is retried from there.
    let chunk: Item[] = [];
    let passed: FinishedRun | undefined;
    const flush = async () => {
      if (chunk.length) await this.embedAndMatch(chunk, model);
      chunk = [];
      if (passed) await this.advance({ at: passed.finished_at, id: passed.id });
    };
    for (const { run, item } of decided) {
      const fresh = item && stored.get(run.id) !== item.sourceVersion;
      if (
        fresh &&
        chunk.length > 0 &&
        (chunk.length >= EMBED_BATCH || chunk[0]?.run.tenant_id !== run.tenant_id)
      )
        await flush();
      if (fresh) chunk.push(item);
      passed = run;
    }
    await flush();
    return { backlog: !held && runs.length === page };
  }

  private async advance(cursor: ObservabilityRetrospectiveCursor): Promise<void> {
    await this.opts.vectors.setCursor(cursor);
    this.position = cursor;
  }

  /** Ordinary runs that ended succeeded or failed past the cursor, with what their card shows. */
  private finishedRuns(
    start: ObservabilityRetrospectiveCursor | null,
    now: Date,
    page: number,
  ): FinishedRun[] {
    const settle = new Date(now.getTime() - SETTLE_MS).toISOString();
    return this.opts.db
      .prepare(
        `SELECT r.id, r.workspace_id, w.tenant_id, r.status, r.attempt, r.error, r.summary_json,
                r.finished_at, th.private_to_user_id IS NOT NULL AS private,
                s.status AS summary_status, s.text AS summary_text
           FROM runs r
           JOIN workspaces w ON w.id = r.workspace_id
           LEFT JOIN threads th ON th.id = r.thread_id
           LEFT JOIN run_activity_summaries s
             ON s.run_id = r.id AND s.source_version = 'a' || r.attempt || '-' || r.status
          WHERE r.status IN ('succeeded', 'failed') AND r.run_type IS NULL
            AND r.finished_at IS NOT NULL AND r.finished_at < @settle
            AND (r.finished_at > @at OR (r.finished_at = @at AND r.id > @id))
          ORDER BY r.finished_at, r.id LIMIT @page`,
      )
      .all({ ...(start ?? { at: "", id: "" }), settle, page }) as FinishedRun[];
  }

  private async embedAndMatch(chunk: readonly Item[], model: string): Promise<void> {
    const tenantId = chunk[0]?.run.tenant_id as string;
    const { vectors: embedded } = await this.usage.timed(
      {
        tenantId,
        corpus: "retrospective",
        purpose: "index",
        service: "embedding",
        model,
        inputs: chunk.length,
      },
      () =>
        this.client.embed(
          chunk.map((item) => item.text),
          this.opts.timeoutMs ?? EMBED_TIMEOUT_MS,
        ),
      (result) => result.inputTokens,
    );
    const at = this.now().toISOString();
    const rows: ObservabilityRunVector[] = chunk.map((item, i) => ({
      runId: item.run.id,
      sourceVersion: item.sourceVersion,
      workspaceId: item.run.workspace_id,
      outcome: item.run.status,
      failureClass: item.run.status === "failed" ? (classifyFailure(item.run.error) ?? null) : null,
      embeddingModel: model,
      vector: embedded[i] as Float32Array,
      finishedAt: item.run.finished_at,
      embeddedAt: at,
    }));
    await this.opts.vectors.putVectors(rows);
    this.embedded += rows.length;
    for (const row of rows) if (row.outcome === "failed") await this.match(row, at);
  }

  /** The failed run's nearest succeeded runs of its workspace, never one marked wrong. */
  private async match(failed: ObservabilityRunVector, at: string): Promise<void> {
    const wrong = new Set(
      (
        this.opts.db
          .prepare("SELECT run_id FROM run_marks WHERE workspace_id = ? AND verdict = 'wrong'")
          .all(failed.workspaceId) as Array<{ run_id: string }>
      ).map((r) => r.run_id),
    );
    const candidates = await this.opts.vectors.succeeded(failed.workspaceId, failed.embeddingModel);
    const scored = candidates
      .filter((c) => c.runId !== failed.runId && !wrong.has(c.runId))
      .map((c) => ({ runId: c.runId, similarity: dot(failed.vector, c.vector) }))
      .filter((c) => Number.isFinite(c.similarity))
      .sort((a, b) => b.similarity - a.similarity || a.runId.localeCompare(b.runId))
      .slice(0, RETROSPECTIVE_MATCHES);
    const matches: ObservabilityRetrospectiveMatch[] = scored.map((c, i) => ({
      matchRunId: c.runId,
      rank: i + 1,
      similarity: c.similarity,
    }));
    await this.opts.vectors.putMatches(
      {
        runId: failed.runId,
        sourceVersion: failed.sourceVersion,
        workspaceId: failed.workspaceId,
        embeddingModel: failed.embeddingModel,
        computedAt: at,
      },
      matches,
    );
    this.matched += 1;
  }
}
