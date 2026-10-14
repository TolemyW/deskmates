// Which model a proxied request may name (ADR-0023 decision 1). A run's models are resolved once
// and frozen on its row at start (`run-lifecycle.ts`, `effectiveModels`); the run token sits in
// the CLI's environment, so a `Bash` call could otherwise buy any model on the upstream. The
// check reads the request body's `model` field and the run row, never the prompt, so a routing
// directive in page content or a message cannot change the answer (test plan SEC-02).

/** The models a run may use, as frozen on its row. */
export interface FrozenModels {
  model: string;
  cheapModel: string;
  /** FALLBACK_MODEL as frozen on the run (ADR-0023 decision 3): the SDK may switch to it. */
  fallbackModel?: string;
}

export type ModelVerdict =
  /** The body names a frozen model: forwarded byte for byte. */
  | { verdict: "forward"; model: string }
  /** The body names the CLI's own small-fast id: forwarded with `model` set to `cheapModel`. */
  | { verdict: "rewrite"; from: string; model: string }
  /** Anything else, including no readable model: 403 `model_not_selected`, never forwarded. */
  | { verdict: "refuse" };

/**
 * The verdict for one request. `smallFastModel` is the configured id of the CLI's background
 * calls (`CLI_SMALL_FAST_MODEL`); research §6.1 observed none, so it is unset by default and
 * nothing is rewritten. Comparison is exact: a look-alike id is another id.
 */
export function modelVerdict(
  requested: string | undefined,
  frozen: FrozenModels | undefined,
  smallFastModel?: string,
): ModelVerdict {
  if (frozen === undefined || requested === undefined || requested === "") {
    return { verdict: "refuse" };
  }
  if (
    requested === frozen.model ||
    requested === frozen.cheapModel ||
    (frozen.fallbackModel !== undefined && requested === frozen.fallbackModel)
  ) {
    return { verdict: "forward", model: requested };
  }
  if (smallFastModel !== undefined && smallFastModel !== "" && requested === smallFastModel) {
    return { verdict: "rewrite", from: requested, model: frozen.cheapModel };
  }
  return { verdict: "refuse" };
}

/** The frozen models on a run's config, or undefined when the run has not been started yet. */
export function frozenModelsOf(
  config: Readonly<Record<string, unknown>>,
): FrozenModels | undefined {
  const { model, cheapModel, fallbackModel } = config;
  if (typeof model !== "string" || model === "") return undefined;
  if (typeof cheapModel !== "string" || cheapModel === "") return undefined;
  return {
    model,
    cheapModel,
    ...(typeof fallbackModel === "string" && fallbackModel !== "" ? { fallbackModel } : {}),
  };
}

/**
 * The request body with its top-level `model` replaced. Only called for a rewrite, on a body
 * already parsed once to read the model, so it cannot fail on a body the verdict accepted.
 */
export function withModel(body: Buffer, model: string): Buffer {
  const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...parsed, model }), "utf8");
}
