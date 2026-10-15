// The installation's model registry (ADR-0039): which upstream serves which model id. Configured
// only in `.env`: `MODEL_BASE_URL` / `MODEL_AUTH_TOKEN` are the `default` upstream, which serves
// every model no other upstream lists, and `MODEL_UPSTREAMS` adds more. URLs and tokens live in
// memory only; the UI sees model ids and upstream ids, nothing else.

import { DeskmatesError, type RegisteredModel } from "@deskmates/contracts";
import { httpUrl } from "./env.js";

/** The id of the upstream `MODEL_BASE_URL` configures; reserved in `MODEL_UPSTREAMS`. */
export const DEFAULT_UPSTREAM_ID = "default";

/**
 * Protocols with an adapter in the model proxy: Anthropic Messages (`/v1/messages`) and, since
 * ADR-0042, OpenAI Chat Completions (`/v1/chat/completions`). A request is forwarded only to an
 * upstream of its own protocol; the proxy never translates.
 */
export const MODEL_UPSTREAM_PROTOCOLS = ["anthropic", "openai"] as const;
export type ModelUpstreamProtocol = (typeof MODEL_UPSTREAM_PROTOCOLS)[number];

export function isUpstreamProtocol(value: unknown): value is ModelUpstreamProtocol {
  return (
    typeof value === "string" && (MODEL_UPSTREAM_PROTOCOLS as readonly string[]).includes(value)
  );
}

/** One upstream of `MODEL_UPSTREAMS`. */
export interface ModelUpstream {
  id: string;
  /** No trailing slash; the proxy appends the request path. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer`; absent means the upstream is called without one. */
  authToken?: string;
  /** Exact model ids this upstream serves. */
  models: readonly string[];
  protocol: ModelUpstreamProtocol;
}

/** Where a model's requests go. `catchAll` is the `default` upstream serving unlisted ids. */
export interface ResolvedUpstream {
  id: string;
  baseUrl: string;
  authToken?: string;
  protocol: ModelUpstreamProtocol;
}

/** What the registry is built from: the model part of the Gateway configuration. */
export interface ModelRegistrySource {
  modelBaseUrl?: string;
  modelAuthToken?: string;
  modelUpstreams?: readonly ModelUpstream[];
  defaultModel: string;
  cheapModel: string;
  fallbackModel?: string;
}

const UPSTREAM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEYS: ReadonlySet<string> = new Set(["id", "baseUrl", "authToken", "models", "protocol"]);

function invalid(key: string, message: string, details: Record<string, unknown> = {}): never {
  throw new DeskmatesError("validation", `${key}: ${message}`, { key, ...details });
}

/** `MODEL_UPSTREAMS` parsed and checked; any fault is a startup `validation` error. */
export function parseModelUpstreams(
  raw: string | undefined,
  key = "MODEL_UPSTREAMS",
): ModelUpstream[] {
  const text = raw?.trim() ?? "";
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    invalid(key, `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) invalid(key, "must be a JSON array of upstreams");
  const ids = new Set<string>();
  const models = new Map<string, string>();
  return parsed.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      invalid(key, `entry ${index} must be an object`, { index });
    }
    const row = entry as Record<string, unknown>;
    const unknownKey = Object.keys(row).find((k) => !KEYS.has(k));
    if (unknownKey !== undefined) invalid(key, `entry ${index} has unknown key "${unknownKey}"`);
    const { id, baseUrl, authToken, protocol } = row;
    if (typeof id !== "string" || !UPSTREAM_ID.test(id)) {
      invalid(key, `entry ${index} id must match ${UPSTREAM_ID.source}`, { index });
    }
    if (id === DEFAULT_UPSTREAM_ID) {
      invalid(key, `"${DEFAULT_UPSTREAM_ID}" is reserved for MODEL_BASE_URL`, { upstream: id });
    }
    if (ids.has(id)) invalid(key, `duplicate upstream id "${id}"`, { upstream: id });
    ids.add(id);
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      invalid(key, `upstream "${id}" needs a baseUrl`, { upstream: id });
    }
    const url = httpUrl(`${key}[${id}].baseUrl`, baseUrl.trim()).replace(/\/+$/, "");
    if (authToken !== undefined && (typeof authToken !== "string" || authToken.trim() === "")) {
      invalid(key, `upstream "${id}" authToken must be a non-empty string or absent`, {
        upstream: id,
      });
    }
    if (!isUpstreamProtocol(protocol)) {
      invalid(
        key,
        `upstream "${id}" protocol must be one of ${MODEL_UPSTREAM_PROTOCOLS.join(", ")}`,
        {
          upstream: id,
        },
      );
    }
    if (!Array.isArray(row.models) || row.models.length === 0) {
      invalid(key, `upstream "${id}" must list at least one model`, { upstream: id });
    }
    const list = row.models.map((model: unknown) => {
      if (typeof model !== "string" || model.trim() === "" || model !== model.trim()) {
        invalid(key, `upstream "${id}" has a model id that is not a non-empty string`, {
          upstream: id,
        });
      }
      const owner = models.get(model);
      if (owner !== undefined) {
        invalid(key, `model "${model}" is listed by both "${owner}" and "${id}"`, { model });
      }
      models.set(model, id);
      return model;
    });
    return {
      id,
      baseUrl: url,
      ...(typeof authToken === "string" ? { authToken: authToken.trim() } : {}),
      models: list,
      protocol,
    };
  });
}

/** Model id → upstream, built from configuration. Pure; holds no state beyond the config. */
export class ModelRegistry {
  private readonly byModel = new Map<string, ModelUpstream>();
  private readonly fallthrough: ResolvedUpstream | undefined;

  constructor(private readonly source: ModelRegistrySource) {
    for (const upstream of source.modelUpstreams ?? []) {
      for (const model of upstream.models) this.byModel.set(model, upstream);
    }
    const base = source.modelBaseUrl?.trim();
    this.fallthrough =
      base === undefined || base === ""
        ? undefined
        : {
            id: DEFAULT_UPSTREAM_ID,
            baseUrl: base.replace(/\/+$/, ""),
            ...(source.modelAuthToken ? { authToken: source.modelAuthToken } : {}),
            protocol: "anthropic",
          };
  }

  /** The upstream serving `model`: the one listing it, else `default`, else none. */
  resolve(model: string): ResolvedUpstream | undefined {
    const listed = this.byModel.get(model);
    if (listed) {
      return {
        id: listed.id,
        baseUrl: listed.baseUrl,
        ...(listed.authToken === undefined ? {} : { authToken: listed.authToken }),
        protocol: listed.protocol,
      };
    }
    return this.fallthrough;
  }

  /** The upstream id serving `model`, or undefined when none does. */
  upstreamOf(model: string): string | undefined {
    return this.resolve(model)?.id;
  }

  /** Every upstream token, so the ledger redacts them like the default one. */
  secrets(): string[] {
    const tokens = new Set<string>();
    if (this.fallthrough?.authToken) tokens.add(this.fallthrough.authToken);
    for (const upstream of this.source.modelUpstreams ?? []) {
      if (upstream.authToken) tokens.add(upstream.authToken);
    }
    return [...tokens];
  }

  /**
   * The models the UI offers (ADR-0039 decision 8): every listed model plus the configured
   * default, cheap and fallback ids, each with its upstream id; sorted, unroutable ones left out.
   */
  registered(): RegisteredModel[] {
    const ids = new Set<string>(this.byModel.keys());
    ids.add(this.source.defaultModel);
    ids.add(this.source.cheapModel);
    if (this.source.fallbackModel) ids.add(this.source.fallbackModel);
    const out: RegisteredModel[] = [];
    for (const model of [...ids].sort()) {
      const upstream = this.upstreamOf(model);
      if (upstream !== undefined) out.push({ model, upstream });
    }
    return out;
  }

  /** Startup check: each configured model id must have an upstream (ADR-0039 decision 4). */
  assertConfiguredModelsRoutable(): void {
    const configured: [string, string | undefined][] = [
      ["DEFAULT_MODEL", this.source.defaultModel],
      ["CHEAP_MODEL", this.source.cheapModel],
      ["FALLBACK_MODEL", this.source.fallbackModel],
    ];
    for (const [key, model] of configured) {
      if (model !== undefined && this.resolve(model) === undefined) {
        throw new DeskmatesError(
          "validation",
          `${key} "${model}" is served by no upstream; list it in MODEL_UPSTREAMS or set MODEL_BASE_URL`,
          { key, model },
        );
      }
    }
  }
}

const registries = new WeakMap<object, ModelRegistry>();

/** The registry for one configuration object, built once per object. */
export function modelRegistryOf(config: ModelRegistrySource): ModelRegistry {
  let registry = registries.get(config);
  if (!registry) {
    registry = new ModelRegistry(config);
    registries.set(config, registry);
  }
  return registry;
}
