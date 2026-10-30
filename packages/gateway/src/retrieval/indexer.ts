// ADR-0041 decision 4: the background indexer. It finds searchable sources without a vector for
// the configured model, embeds their chunks in batches of at most 16 inputs, one tenant or
// workspace per batch, and writes a source only if its text did not change meanwhile. A write
// never waits for it: an unindexed source is still found by bm25.

import { chunkText, knowledgeChunkInput } from "./chunk.js";
import { type EmbeddingClient, RetrievalCallError } from "./clients.js";
import type { RetrievalCorpus, RetrievalUsage } from "./usage.js";
import type { PendingKnowledge, PendingMemory, VectorStore } from "./vector-store.js";

export const INDEXER_DEFAULTS = {
  batchInputs: 16,
  intervalMs: 30_000,
  timeoutMs: 30_000,
  /** Sources fetched per query; a pass repeats until none are left or one fails. */
  pageSources: 64,
  /** A pass stops after this many sources so one pass cannot run for ever. */
  maxSourcesPerPass: 5_000,
} as const;

export interface IndexerOptions {
  batchInputs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export interface IndexPassResult {
  knowledge: number;
  memory: number;
  /** The pass ended on a failed call; the next pass retries. */
  failed: boolean;
}

interface Source<T> {
  source: T;
  inputs: string[];
}

export class RetrievalIndexer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private kickTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<IndexPassResult> | undefined;
  private again = false;
  private stopped = false;
  /** Aborts an in-flight call on stop, so shutdown never waits for a service timeout. */
  private abort = new AbortController();
  /** Sources the service refused (4xx); not retried until the Gateway restarts. */
  private readonly refused = new Set<string>();
  private readonly batchInputs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: VectorStore,
    private readonly client: EmbeddingClient,
    private readonly usage: RetrievalUsage,
    private readonly options: IndexerOptions = {},
  ) {
    this.batchInputs = options.batchInputs ?? INDEXER_DEFAULTS.batchInputs;
    this.timeoutMs = options.timeoutMs ?? INDEXER_DEFAULTS.timeoutMs;
  }

  /** The backfill at start, then a pass every interval. */
  start(): void {
    this.stopped = false;
    this.abort = new AbortController();
    this.kick(0);
    this.timer = setInterval(
      () => this.kick(0),
      this.options.intervalMs ?? INDEXER_DEFAULTS.intervalMs,
    );
    this.timer.unref?.();
  }

  stop(): Promise<unknown> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = undefined;
    this.kickTimer = undefined;
    return this.running ?? Promise.resolve();
  }

  /** Ask for a pass soon (a document was published or edited); never blocks the caller. */
  kick(delayMs = 250): void {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.runOnce();
    }, delayMs);
    this.kickTimer.unref?.();
  }

  /** One pass; a pass already running is followed by another rather than run twice at once. */
  runOnce(): Promise<IndexPassResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((error: unknown) => {
        this.options.log?.("retrieval indexing failed", { error: String(error) });
        return { knowledge: 0, memory: 0, failed: true };
      })
      .finally(() => {
        this.running = undefined;
        if (this.again && !this.stopped) {
          this.again = false;
          void this.runOnce();
        }
      });
    return this.running;
  }

  private async pass(): Promise<IndexPassResult> {
    const model = this.client.service.model;
    this.store.dropOtherModels(model);
    const result: IndexPassResult = { knowledge: 0, memory: 0, failed: false };
    let attempts = 0;
    while (!this.stopped && attempts < INDEXER_DEFAULTS.maxSourcesPerPass) {
      const page = this.store.pendingKnowledge(model, INDEXER_DEFAULTS.pageSources, this.refused);
      if (page.length === 0) break;
      attempts += page.length;
      const done = await this.embedScopes(
        "knowledge",
        page,
        (doc) => doc.tenantId,
        (doc) => doc.tenantId,
        (doc) => chunkText(doc.body).map((chunk) => knowledgeChunkInput(doc.title, chunk)),
        (doc, vectors) => this.store.writeKnowledge(doc, model, vectors),
      );
      result.knowledge += done.count;
      if (done.failed) return { ...result, failed: true };
    }
    attempts = 0;
    while (!this.stopped && attempts < INDEXER_DEFAULTS.maxSourcesPerPass) {
      const page = this.store.pendingMemory(model, INDEXER_DEFAULTS.pageSources, this.refused);
      if (page.length === 0) break;
      attempts += page.length;
      const done = await this.embedScopes(
        "memory",
        page,
        (entry) => entry.workspaceId,
        (entry) => entry.tenantId,
        (entry) => chunkText(entry.body),
        (entry, vectors) => this.store.writeMemory(entry, model, vectors),
      );
      result.memory += done.count;
      if (done.failed) return { ...result, failed: true };
    }
    return result;
  }

  /** Embed a page of sources, scope by scope, in batches; write each source when complete. */
  private async embedScopes<T extends PendingKnowledge | PendingMemory>(
    corpus: RetrievalCorpus,
    page: readonly T[],
    scopeOf: (source: T) => string,
    tenantOf: (source: T) => string,
    inputsOf: (source: T) => string[],
    write: (source: T, vectors: Float32Array[]) => boolean,
  ): Promise<{ count: number; failed: boolean }> {
    const scopes = new Map<string, Source<T>[]>();
    for (const source of page) {
      const inputs = inputsOf(source);
      if (inputs.length === 0) {
        // Nothing to embed (blank after chunking): never pick it again in this process.
        this.refused.add(source.id);
        continue;
      }
      const list = scopes.get(scopeOf(source)) ?? [];
      list.push({ source, inputs });
      scopes.set(scopeOf(source), list);
    }
    let count = 0;
    let refusedAny = false;
    for (const sources of scopes.values()) {
      const flat = sources.flatMap((item, at) => item.inputs.map((text) => ({ at, text })));
      const indexed = flat.map((item, index) => ({ ...item, index }));
      const vectors: (Float32Array | undefined)[] = [];
      /** Sources of this scope the service refused; the rest of the scope is still written. */
      const dropped = new Set<number>();
      const tenantId = tenantOf((sources[0] as Source<T>).source);
      const refuse = (at: number) => {
        const id = (sources[at] as Source<T>).source.id;
        dropped.add(at);
        this.refused.add(id);
        refusedAny = true;
        this.options.log?.("retrieval indexing refused a source; not retried until restart", {
          corpus,
          sourceId: id,
        });
      };
      for (let start = 0; start < flat.length; start += this.batchInputs) {
        if (this.stopped) return { count, failed: false };
        const batch = indexed.slice(start, start + this.batchInputs);
        const outcome = await this.embedInto(corpus, tenantId, batch, vectors);
        if (outcome === "stopped") return { count, failed: false };
        if (outcome === "failed") return { count, failed: true };
        if (outcome === "ok") continue;
        // A refusal names no input: retry one source at a time so only the refused one is
        // marked, not every source that shared its batch.
        const owners = [...new Set(batch.map((item) => item.at))];
        if (owners.length === 1) {
          refuse(owners[0] as number);
          continue;
        }
        for (const at of owners) {
          const own = batch.filter((item) => item.at === at);
          const retried = await this.embedInto(corpus, tenantId, own, vectors);
          if (retried === "stopped") return { count, failed: false };
          if (retried === "failed") return { count, failed: true };
          if (retried === "refused") refuse(at);
        }
      }
      if (this.stopped) return { count, failed: false };
      let offset = 0;
      for (const [at, item] of sources.entries()) {
        const own = vectors.slice(offset, offset + item.inputs.length);
        offset += item.inputs.length;
        if (dropped.has(at)) continue;
        if (write(item.source, own as Float32Array[])) count += 1;
      }
    }
    return { count, failed: refusedAny };
  }

  /** One embedding call; its vectors land at each input's index in `vectors`. */
  private async embedInto(
    corpus: RetrievalCorpus,
    tenantId: string,
    batch: readonly { text: string; index: number }[],
    vectors: (Float32Array | undefined)[],
  ): Promise<"ok" | "refused" | "failed" | "stopped"> {
    try {
      const embedded = await this.usage.timed(
        {
          tenantId,
          corpus,
          purpose: "index",
          service: "embedding",
          model: this.client.service.model,
          inputs: batch.length,
        },
        () =>
          this.client.embed(
            batch.map((item) => item.text),
            this.timeoutMs,
            this.abort.signal,
          ),
        (answer) => answer.inputTokens,
      );
      for (const [i, item] of batch.entries()) vectors[item.index] = embedded.vectors[i];
      return "ok";
    } catch (error) {
      if (this.stopped) return "stopped";
      this.options.log?.("retrieval indexing call failed", { corpus, error: String(error) });
      return error instanceof RetrievalCallError && error.refused ? "refused" : "failed";
    }
  }
}
