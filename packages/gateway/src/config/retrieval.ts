// Hybrid retrieval (ADR-0041 decisions 1 and 6): vectors when EMBEDDING_URL and EMBEDDING_MODEL
// are set, reranking when RERANK_URL and RERANK_MODEL are set. With none of the four the key is
// absent and search is today's FTS5. Model ids come from `.env` only; nothing here names one.

import { DeskmatesError } from "@deskmates/contracts";
import { type Env, httpUrl, optionalInt } from "./env.js";

export interface RetrievalServiceConfig {
  url: string;
  model: string;
}

export interface RetrievalSettings {
  embedding?: RetrievalServiceConfig;
  rerank?: RetrievalServiceConfig;
  /** Candidates taken from each of the bm25 and vector lists. */
  candidates: number;
  /** The reciprocal rank fusion constant. */
  rrfK: number;
  /** How many fused candidates the reranker reorders. */
  rerankTopN: number;
  /** A vector candidate below this cosine similarity is dropped. */
  minSimilarity: number;
}

export interface RetrievalConfig {
  retrieval?: RetrievalSettings;
}

export const RETRIEVAL_DEFAULTS = {
  candidates: 50,
  rrfK: 60,
  rerankTopN: 20,
  minSimilarity: 0.45,
} as const;

function pair(env: Env, urlKey: string, modelKey: string): RetrievalServiceConfig | undefined {
  const url = env[urlKey]?.trim() ?? "";
  const model = env[modelKey]?.trim() ?? "";
  if (url === "" && model === "") return undefined;
  if (url === "" || model === "")
    throw new DeskmatesError(
      "validation",
      `${urlKey} and ${modelKey} are set together or not at all`,
      {
        key: url === "" ? urlKey : modelKey,
      },
    );
  return { url: httpUrl(urlKey, url), model };
}

function similarity(env: Env): number {
  const raw = env.RETRIEVAL_MIN_SIMILARITY?.trim();
  if (raw === undefined || raw === "") return RETRIEVAL_DEFAULTS.minSimilarity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -1 || n > 1)
    throw new DeskmatesError("validation", "RETRIEVAL_MIN_SIMILARITY must be between -1 and 1", {
      key: "RETRIEVAL_MIN_SIMILARITY",
      raw,
    });
  return n;
}

export function readRetrievalConfig(env: Env): RetrievalConfig {
  const embedding = pair(env, "EMBEDDING_URL", "EMBEDDING_MODEL");
  const rerank = pair(env, "RERANK_URL", "RERANK_MODEL");
  if (!embedding && !rerank) return {};
  return {
    retrieval: {
      ...(embedding ? { embedding } : {}),
      ...(rerank ? { rerank } : {}),
      candidates: Math.min(
        200,
        optionalInt(env, "RETRIEVAL_CANDIDATES", RETRIEVAL_DEFAULTS.candidates),
      ),
      rrfK: optionalInt(env, "RETRIEVAL_RRF_K", RETRIEVAL_DEFAULTS.rrfK),
      rerankTopN: Math.min(100, optionalInt(env, "RERANK_TOP_N", RETRIEVAL_DEFAULTS.rerankTopN)),
      minSimilarity: similarity(env),
    },
  };
}
