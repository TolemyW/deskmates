// The arms of the retrieval comparison (ADR-0041 decision 10): one build, three configurations
// that differ only in which retrieval services are configured. `fts5` is today's default (none of
// the four variables set), `vectors` adds the embedding service, `vectors-rerank` adds the
// reranker on top. Two comparisons, one knob each: R1 vectors against fts5, R2 rerank against
// vectors. Configuration only: nothing here has been run, and no result exists.

export type RetrievalArm = "fts5" | "vectors" | "vectors-rerank";

export interface RetrievalArmConfig {
  arm: RetrievalArm;
  /** The ADR-0041 decision 1 variables this arm sets; every other one of the four stays unset. */
  sets: readonly ("EMBEDDING_URL" | "EMBEDDING_MODEL" | "RERANK_URL" | "RERANK_MODEL")[];
}

export const RETRIEVAL_SERVICE_KEYS = [
  "EMBEDDING_URL",
  "EMBEDDING_MODEL",
  "RERANK_URL",
  "RERANK_MODEL",
] as const;

/** The decision-6 tuning variables. A campaign measures their defaults, so they must be unset. */
export const RETRIEVAL_TUNING_KEYS = [
  "RETRIEVAL_CANDIDATES",
  "RETRIEVAL_RRF_K",
  "RERANK_TOP_N",
  "RETRIEVAL_MIN_SIMILARITY",
] as const;

export const RETRIEVAL_ARMS: readonly RetrievalArmConfig[] = [
  { arm: "fts5", sets: [] },
  { arm: "vectors", sets: ["EMBEDDING_URL", "EMBEDDING_MODEL"] },
  {
    arm: "vectors-rerank",
    sets: ["EMBEDDING_URL", "EMBEDDING_MODEL", "RERANK_URL", "RERANK_MODEL"],
  },
];

export interface RetrievalComparison {
  id: "R1" | "R2";
  knob: "vectors" | "rerank";
  baseline: RetrievalArm;
  candidate: RetrievalArm;
}

/** Decision 10: vectors, then rerank, each against the arm without it. */
export const RETRIEVAL_COMPARISONS: readonly RetrievalComparison[] = [
  { id: "R1", knob: "vectors", baseline: "fts5", candidate: "vectors" },
  { id: "R2", knob: "rerank", baseline: "vectors", candidate: "vectors-rerank" },
];

export function retrievalArm(name: string | undefined): RetrievalArmConfig {
  const found = RETRIEVAL_ARMS.find((a) => a.arm === name?.trim());
  if (!found)
    throw new Error(
      `EVAL_ARM must be ${RETRIEVAL_ARMS.map((a) => a.arm).join(", ")}, got ${name ?? "nothing"}`,
    );
  return found;
}

/**
 * The retrieval environment of one arm's Gateway, taken from the campaign environment: the
 * variables the arm sets copied over, the others empty. Refuses a tuning variable (the defaults are
 * what is measured) and a missing service variable, so a half-configured arm never runs.
 */
export function retrievalArmEnvironment(
  arm: RetrievalArm,
  env: Readonly<Record<string, string | undefined>>,
): Record<(typeof RETRIEVAL_SERVICE_KEYS)[number], string> {
  const config = retrievalArm(arm);
  for (const key of RETRIEVAL_TUNING_KEYS)
    if ((env[key] ?? "").trim() !== "")
      throw new Error(`${key} is set; the campaign measures ADR-0041 decision 6's defaults`);
  const out = {} as Record<(typeof RETRIEVAL_SERVICE_KEYS)[number], string>;
  for (const key of RETRIEVAL_SERVICE_KEYS) {
    const value = (env[key] ?? "").trim();
    if (config.sets.includes(key) && value === "")
      throw new Error(`arm ${arm} needs ${key} in the campaign environment`);
    out[key] = config.sets.includes(key) ? value : "";
  }
  return out;
}

/**
 * The order of the arms in each repetition block: a rotation, so no arm always runs first on a
 * warm or a cold host. Every block starts a fresh stack per arm, so no arm inherits another's
 * database, vectors or container.
 */
export function retrievalArmOrder(repetitions: number): RetrievalArm[][] {
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("repetitions must be a positive integer");
  const arms = RETRIEVAL_ARMS.map((a) => a.arm);
  return Array.from({ length: repetitions }, (_, rep) =>
    arms.map((_, i) => arms[(i + rep) % arms.length] as RetrievalArm),
  );
}
