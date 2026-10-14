// The upstream model endpoint, the model ids, run token lifetime and the price table. The model
// is configuration: DEFAULT_MODEL and CHEAP_MODEL are required and never defaulted here.

import { DeskmatesError, type ModelPrice } from "@deskmates/contracts";
import { parseModelPrices } from "../ledger/model-price.js";
import { type Env, optionalInt, optionalValue, required } from "./env.js";

/** ADR-0002 definitions: short-lived token TTL default 4 h. */
export const MODEL_TOKEN_TTL_SECONDS_DEFAULT = 14400;

export interface ModelConfig {
  /** Upstream model endpoint and its Bearer token. Held in memory only; never written to the DB. */
  modelBaseUrl: string;
  modelAuthToken: string;
  defaultModel: string;
  cheapModel: string;
  /**
   * `CLI_SMALL_FAST_MODEL`: the model id the CLI names on its own background calls. The model
   * proxy rewrites it to the run's cheap model (ADR-0023 decision 1). Unset, nothing is rewritten
   * and such a call is refused like any id outside the run's frozen models.
   */
  cliSmallFastModel?: string;
  /**
   * `FALLBACK_MODEL`: one model id the SDK falls back to when the primary is overloaded or
   * unavailable (ADR-0023 decision 3). Frozen on each run at start, passed verbatim to the SDK's
   * `fallbackModel` and allowed by the model proxy for that run. Must be priced; unset means none.
   */
  fallbackModel?: string;
  modelTokenTtlSeconds: number;
  /**
   * `VISION_PROBE` (ADR-0023 amendment 1): `auto` queues a vision probe on bot create, model
   * change and start; `off` queues none (an operator's explicit Retry still runs one). The env
   * loader always sets it (an empty `VISION_PROBE` is `auto`); a hand-built config that omits it,
   * like the T2 stacks', gets no automatic probes.
   */
  visionProbe?: "auto" | "off";
  /**
   * The price table loaded into the `prices` store at startup. Empty is legal: a model with no
   * row is left unpriced with a `pricing_missing` event, never billed at zero.
   */
  modelPrices: ModelPrice[];
}

export function readModelConfig(env: Env): ModelConfig {
  return {
    modelBaseUrl: required(env, "MODEL_BASE_URL").replace(/\/+$/, ""),
    modelAuthToken: required(env, "MODEL_AUTH_TOKEN"),
    defaultModel: required(env, "DEFAULT_MODEL"),
    cheapModel: required(env, "CHEAP_MODEL"),
    ...optionalValue(env, "CLI_SMALL_FAST_MODEL", "cliSmallFastModel"),
    ...fallbackModel(env),
    modelTokenTtlSeconds: optionalInt(
      env,
      "MODEL_TOKEN_TTL_SECONDS",
      MODEL_TOKEN_TTL_SECONDS_DEFAULT,
    ),
    modelPrices: modelPrices(env),
    visionProbe: visionProbe(env),
  };
}

function visionProbe(env: Env): "auto" | "off" {
  const raw = env.VISION_PROBE?.trim() ?? "";
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "off") return "off";
  throw new DeskmatesError("validation", "VISION_PROBE must be auto or off", {
    key: "VISION_PROBE",
  });
}

/**
 * One id, not the SDK's comma-separated list: the proxy's frozen set and the startup price check
 * work on exact ids, and the sidecar passes the value through unchanged.
 */
function fallbackModel(env: Env): { fallbackModel?: string } {
  const value = optionalValue(env, "FALLBACK_MODEL", "fallbackModel");
  if (value.fallbackModel !== undefined && /[,\s]/.test(value.fallbackModel)) {
    throw new DeskmatesError("validation", "FALLBACK_MODEL must be a single model id", {
      key: "FALLBACK_MODEL",
    });
  }
  return value;
}

/**
 * `MODEL_PRICES`, a JSON array of price rows. Read here rather than at the first run so a typo is
 * a startup failure an operator sees, not a month of runs with no cost on them.
 */
function modelPrices(env: Env): ModelPrice[] {
  const raw = env.MODEL_PRICES?.trim();
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DeskmatesError(
      "validation",
      `MODEL_PRICES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseModelPrices(parsed, "MODEL_PRICES");
}
