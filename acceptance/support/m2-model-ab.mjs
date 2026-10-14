// Pure rules of the paired two-workspace model A/B campaign: which models and how many rounds,
// how a run's tokens are counted, and what the per-arm summary and its sample-size caveat say.
// Plain ESM so the `node`-run launcher (spikes/m2-model-ab/run.mjs) prints the same summary the
// T3 test writes (typed for the TypeScript side by m2-model-ab.d.mts).

export const AB_ARMS = /** @type {const} */ (["A", "B"]);
export const DEFAULT_AB_ROUNDS = 5;
/** 40 interleaved pairs at ~90 s each is about an hour of wall clock; beyond that, split it. */
export const MAX_AB_ROUNDS = 40;
export const TOKEN_KEYS = /** @type {const} */ ([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreateTokens",
]);
export const UNKNOWN = "unknown";

/**
 * Read `M2_AB_MODEL_A`, `M2_AB_MODEL_B` and `M2_AB_ROUNDS`. Never falls back to DEFAULT_MODEL:
 * that would compare a model against itself and look like a valid result.
 * @param {Record<string, string | undefined>} env
 */
export function readAbConfig(env) {
  const modelA = (env.M2_AB_MODEL_A ?? "").trim();
  const modelB = (env.M2_AB_MODEL_B ?? "").trim();
  const unset = [modelA ? "" : "M2_AB_MODEL_A", modelB ? "" : "M2_AB_MODEL_B"].filter(Boolean);
  if (unset.length > 0) {
    throw new Error(
      [
        `M2_AB_MODEL_A and M2_AB_MODEL_B must both name a model id (unset: ${unset.join(", ")}).`,
        "The A/B harness never falls back to DEFAULT_MODEL: that would compare a model against",
        "itself and look like a valid result.",
      ].join(" "),
    );
  }
  const raw = (env.M2_AB_ROUNDS ?? "").trim();
  const rounds = raw === "" ? DEFAULT_AB_ROUNDS : Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_AB_ROUNDS) {
    throw new Error(`M2_AB_ROUNDS must be an integer from 1 to ${MAX_AB_ROUNDS}, got ${raw}`);
  }
  return { modelA, modelB, rounds };
}

/**
 * One run's token counts summed over its usage rows (one row per model). A run with no usage
 * row has unknown usage, never zero: the ledger did not see its tokens, it did not see none.
 * @param {readonly Record<string, unknown>[]} usageRows
 */
export function runTokens(usageRows) {
  if (usageRows.length === 0) return unknownTokens();
  return Object.fromEntries(
    TOKEN_KEYS.map((key) => {
      let total = 0;
      for (const row of usageRows) {
        const value = row[key];
        if (typeof value !== "number" || !Number.isFinite(value)) return [key, UNKNOWN];
        total += value;
      }
      return [key, total];
    }),
  );
}

/** Sum token counts; one unknown makes that key's total unknown. @param {readonly Record<string, number | "unknown">[]} list */
export function sumTokens(list) {
  return Object.fromEntries(
    TOKEN_KEYS.map((key) => {
      let total = 0;
      for (const tokens of list) {
        const value = tokens[key];
        if (typeof value !== "number") return [key, UNKNOWN];
        total += value;
      }
      return [key, total];
    }),
  );
}

function unknownTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, UNKNOWN]));
}

/** @param {readonly number[]} values */
function spread(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (/** @type {number} */ index) => sorted[index] ?? Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
  return { median, min: at(0), max: at(sorted.length - 1) };
}

/**
 * What a campaign of `rounds` rounds per arm can and cannot resolve. Printed with every summary
 * so a bare pass count is not read as a ranking (measurement §4.4).
 * @param {number} rounds
 */
export function abSampleSizeCaveat(rounds) {
  return [
    `Sample size: ${rounds} rounds per arm, one scenario (chief delegation).`,
    "This comparison only resolves large differences. To distinguish a 10% failure rate from",
    "a 30% one at conventional confidence needs roughly 20+ rounds per arm. A 5-round campaign",
    'can detect "one model cannot do this at all"; it cannot rank two models that both mostly',
    "work. Wall time and tokens were measured under the same interleaved host conditions, but",
    "they too are a handful of samples. Not a deskbench verdict (measurement doc section 4.4).",
  ].join("\n");
}

/**
 * Per arm: pass count over its rows, median and range of wallMs, total tokens (unknown kept).
 * @param {readonly { arm: string; passed: boolean; wallMs: number; tokens: Record<string, number | "unknown">; runs: readonly { tokens: Record<string, number | "unknown"> }[] }[]} rows
 * @param {Record<string, string>} models arm label -> model id
 * @param {number} rounds
 */
export function summarizeAbRows(rows, models, rounds) {
  return {
    rounds,
    arms: AB_ARMS.map((arm) => {
      const own = rows.filter((row) => row.arm === arm);
      return {
        arm,
        model: models[arm] ?? UNKNOWN,
        rows: own.length,
        passed: own.filter((row) => row.passed).length,
        wallMs: spread(own.map((row) => row.wallMs)),
        tokens: sumTokens(own.map((row) => row.tokens)),
        runsMissingUsage: own
          .flatMap((row) => row.runs)
          .filter((run) => TOKEN_KEYS.some((key) => run.tokens[key] === UNKNOWN)).length,
      };
    }),
    caveat: abSampleSizeCaveat(rounds),
  };
}

/** @param {number | "unknown"} value */
function tokenText(value) {
  return typeof value === "number" ? String(value) : UNKNOWN;
}

/** @param {ReturnType<typeof summarizeAbRows>} summary */
export function formatAbSummary(summary) {
  const lines = summary.arms.map((arm) => {
    const wall = arm.wallMs
      ? `wall median ${(arm.wallMs.median / 1000).toFixed(1)} s, ` +
        `range ${(arm.wallMs.min / 1000).toFixed(1)}-${(arm.wallMs.max / 1000).toFixed(1)} s`
      : "no wall time";
    const tokens = TOKEN_KEYS.map((key) => `${key} ${tokenText(arm.tokens[key])}`).join(", ");
    const missing = arm.runsMissingUsage ? `, ${arm.runsMissingUsage} run(s) without usage` : "";
    return `${arm.arm} ${arm.model}: ${arm.passed}/${arm.rows} passed; ${wall}; ${tokens}${missing}`;
  });
  return [...lines, "", summary.caveat].join("\n");
}
