// The scripted dry run of the 2026-10-17 protocol (amendment 1 A4, phase P0): an executor runs
// against a scripted model upstream and, for the vector arms, scripted retrieval services, with
// placeholder models priced at zero. It needs no owner ruling, no ceiling and no model: it proves
// seeding, the tool call through the sidecar, observation, grading and the decision, and its pass
// rates measure the harness, never a model. Model-free; imported by the executors and T0 tests.

import type { ModelPrice } from "@deskmates/contracts";

/** `EVAL_DRY_RUN=scripted`; any other non-empty value is refused, so a typo never runs a model. */
export function dryRunRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = (env.EVAL_DRY_RUN ?? "").trim();
  if (value === "") return false;
  if (value === "scripted") return true;
  throw new Error(`EVAL_DRY_RUN must be scripted or unset, got ${value}`);
}

/** Placeholder ids: they name no real model and exist only in a dry run's own stack. */
export const DRY_RUN_MODELS = {
  default: "dry-run-default",
  cheap: "dry-run-cheap",
  incumbent: "dry-run-cheap-incumbent",
  candidate: "dry-run-cheap-candidate",
} as const;

/** The scripted upstream's Bearer token; it guards nothing but a local test server. */
export const DRY_RUN_TOKEN = "dry-run-scripted-upstream-token";

/** A zero price row for every placeholder model: the dry run is known zero by the same gate. */
export function dryRunPrices(): ModelPrice[] {
  return Object.values(DRY_RUN_MODELS).map((model) => ({
    model,
    inputPerM: 0,
    outputPerM: 0,
    cacheReadPerM: 0,
    cacheCreatePerM: 0,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  }));
}

export interface DryRunEndpoints {
  modelBaseUrl: string;
  embeddingUrl?: string;
  rerankUrl?: string;
}

/**
 * The environment a dry run's executor reads instead of the campaign's `.env` values: every model
 * variable points at the scripted upstream, `MODEL_UPSTREAMS` and the ceiling are cleared, and the
 * retrieval services, when given, are the scripted ones. Laid over `process.env`, so nothing the
 * installation configured for real runs is reached.
 */
export function dryRunEnvironment(endpoints: DryRunEndpoints): Record<string, string> {
  return {
    MODEL_BASE_URL: endpoints.modelBaseUrl,
    MODEL_AUTH_TOKEN: DRY_RUN_TOKEN,
    DEFAULT_MODEL: DRY_RUN_MODELS.default,
    CHEAP_MODEL: DRY_RUN_MODELS.cheap,
    FALLBACK_MODEL: "",
    CLI_SMALL_FAST_MODEL: "",
    MODEL_UPSTREAMS: "",
    MODEL_PRICES: JSON.stringify(dryRunPrices()),
    EVAL_CEILING_USD: "",
    EVAL_CHEAP_INCUMBENT: DRY_RUN_MODELS.incumbent,
    EVAL_CHEAP_CANDIDATE: DRY_RUN_MODELS.candidate,
    EMBEDDING_URL: endpoints.embeddingUrl ?? "",
    EMBEDDING_MODEL: endpoints.embeddingUrl ? "dry-run-embedding" : "",
    RERANK_URL: endpoints.rerankUrl ?? "",
    RERANK_MODEL: endpoints.rerankUrl ? "dry-run-rerank" : "",
    RETRIEVAL_CANDIDATES: "",
    RETRIEVAL_RRF_K: "",
    RERANK_TOP_N: "",
    RETRIEVAL_MIN_SIMILARITY: "",
  };
}
