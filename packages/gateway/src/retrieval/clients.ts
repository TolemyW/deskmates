// ADR-0041 decisions 2 and 4: the only model calls the Gateway makes. Each client posts to the
// one URL configured in `.env`, sends a fixed request shape and reads only vectors, scores and
// usage counts. No generation endpoint is reachable through here.

import type { RetrievalServiceConfig } from "../config/retrieval.js";
import { normalize } from "./vectors.js";

export type RetrievalFetch = typeof globalThis.fetch;

/** Why a call failed: `timeout` when it ran out of time, `error` for anything else. */
export class RetrievalCallError extends Error {
  constructor(
    readonly outcome: "error" | "timeout",
    message: string,
    /** A 4xx answer: the input itself was refused, so retrying it unchanged will not help. */
    readonly refused = false,
  ) {
    super(message);
  }
}

export interface EmbedResult {
  vectors: Float32Array[];
  /** Tokens the service reports, or null when it reports none (unknown, not zero). */
  inputTokens: number | null;
}

export interface RerankResult {
  /** One relevance score per input document, in input order. */
  scores: number[];
  inputTokens: number | null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

async function postJson(
  fetchImpl: RetrievalFetch,
  url: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new RetrievalCallError(
        "error",
        `retrieval service answered ${response.status}`,
        response.status >= 400 && response.status < 500,
      );
    return await response.json();
  } catch (error) {
    if (error instanceof RetrievalCallError) throw error;
    if (controller.signal.aborted)
      throw new RetrievalCallError("timeout", `retrieval service timed out after ${timeoutMs} ms`);
    throw new RetrievalCallError("error", `retrieval service unreachable: ${String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function numericVector(value: unknown): number[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((x) => typeof x === "number" && Number.isFinite(x))
    ? (value as number[])
    : undefined;
}

/**
 * ollama `POST /api/embed {model, input, truncate}` → `{embeddings, prompt_eval_count}`, or, when
 * the URL path ends in `/v1/embeddings`, the OpenAI shape `{model, input}` →
 * `{data: [{index, embedding}], usage: {prompt_tokens}}`.
 */
export class EmbeddingClient {
  private readonly openAiShape: boolean;
  constructor(
    readonly service: RetrievalServiceConfig,
    private readonly fetchImpl: RetrievalFetch = globalThis.fetch,
  ) {
    this.openAiShape = /\/v1\/embeddings$/.test(new URL(service.url).pathname);
  }

  async embed(
    inputs: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<EmbedResult> {
    if (inputs.length === 0) return { vectors: [], inputTokens: 0 };
    const body = this.openAiShape
      ? { model: this.service.model, input: inputs }
      : { model: this.service.model, input: inputs, truncate: true };
    const answer = (await postJson(
      this.fetchImpl,
      this.service.url,
      body,
      timeoutMs,
      signal,
    )) as Record<string, unknown> | null;
    let raw: unknown[] | undefined;
    let inputTokens: number | null = null;
    if (this.openAiShape) {
      const data = Array.isArray(answer?.data) ? (answer.data as Record<string, unknown>[]) : [];
      raw = [...data]
        .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0))
        .map((item) => item?.embedding);
      inputTokens = count((answer?.usage as Record<string, unknown> | undefined)?.prompt_tokens);
    } else {
      raw = Array.isArray(answer?.embeddings) ? (answer.embeddings as unknown[]) : undefined;
      inputTokens = count(answer?.prompt_eval_count);
    }
    const vectors = (raw ?? []).map(numericVector);
    const dims = vectors[0]?.length;
    if (
      vectors.length !== inputs.length ||
      vectors.some((v) => v === undefined || v.length !== dims)
    )
      throw new RetrievalCallError("error", "embedding service returned a malformed answer");
    return { vectors: vectors.map((v) => normalize(v as number[])), inputTokens };
  }
}

/**
 * vLLM (0.8.5) / Jina / Cohere rerank: `POST {url} {model, query, documents, top_n}` →
 * `{results: [{index, relevance_score}], usage: {total_tokens}}`.
 */
export class RerankClient {
  constructor(
    readonly service: RetrievalServiceConfig,
    private readonly fetchImpl: RetrievalFetch = globalThis.fetch,
  ) {}

  async rerank(
    query: string,
    documents: readonly string[],
    timeoutMs: number,
  ): Promise<RerankResult> {
    const answer = (await postJson(
      this.fetchImpl,
      this.service.url,
      { model: this.service.model, query, documents, top_n: documents.length },
      timeoutMs,
    )) as Record<string, unknown> | null;
    const results = Array.isArray(answer?.results)
      ? (answer.results as Record<string, unknown>[])
      : undefined;
    const scores: number[] = documents.map(() => Number.NEGATIVE_INFINITY);
    let seen = 0;
    for (const result of results ?? []) {
      const index = result?.index;
      const score = result?.relevance_score;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= documents.length ||
        typeof score !== "number" ||
        !Number.isFinite(score)
      )
        throw new RetrievalCallError("error", "rerank service returned a malformed answer");
      scores[index] = score;
      seen += 1;
    }
    if (!results || seen === 0)
      throw new RetrievalCallError("error", "rerank service returned no results");
    return {
      scores,
      inputTokens: count((answer?.usage as Record<string, unknown> | undefined)?.total_tokens),
    };
  }
}
