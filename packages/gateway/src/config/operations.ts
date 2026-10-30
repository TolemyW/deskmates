// Look/OCR, speech-to-text and text-to-image services (ADR-0040 decision 2, amendment B):
// installation configuration only. Each operation is on when its URL and model are both set, off
// when neither is; anything else stops startup. Credentials stay in Gateway memory and never reach
// a sandbox.

import { createHash } from "node:crypto";
import {
  ASR_DEFAULT_MAX_BYTES,
  ASR_DEFAULT_MAX_SECONDS,
  DeskmatesError,
  IMAGE_DEFAULT_SIZE,
  IMAGE_SIDE_MAX,
  IMAGE_SIDE_MIN,
  type OperationName,
  type OperationStamp,
  parseImageSize,
} from "@deskmates/contracts";
import { type Env, httpUrl, optionalInt } from "./env.js";

export type VisionOperationProtocol = "anthropic-messages" | "openai-chat";

interface OperationServiceConfig {
  /** The full request URL the proxy posts to. */
  url: string;
  model: string;
  /** Bearer for the service; absent for an unauthenticated local service. */
  authToken?: string;
  /** USD per unit (image or page; audio second; generated image). Absent: unpriced. 0 is a known zero. */
  priceUsd?: number;
  /** sha256 of the request URL, recorded instead of the URL. */
  endpointSha256: string;
}

export interface LookOperationConfig extends OperationServiceConfig {
  protocol: VisionOperationProtocol;
}

export interface AsrOperationConfig extends OperationServiceConfig {
  maxBytes: number;
  maxSeconds: number;
}

/** Text-to-image (ADR-0040 amendment B, decision 17): OpenAI-compatible image generations. */
export interface ImageOperationConfig extends OperationServiceConfig {
  /** `<width>x<height>` used when a call names no size. */
  defaultSize: string;
}

export interface OperationsConfig {
  operations?: {
    look?: LookOperationConfig;
    asr?: AsrOperationConfig;
    image_generation?: ImageOperationConfig;
  };
}

type OperationPrefix = "VISION" | "ASR" | "IMAGE";

const PATHS = {
  "anthropic-messages": "/v1/messages",
  "openai-chat": "/v1/chat/completions",
  asr: "/v1/audio/transcriptions",
  image: "/v1/images/generations",
} as const;

/** A base URL gets the route's path; a URL that already ends in it is kept. */
function endpoint(key: string, raw: string, path: string): string {
  const base = httpUrl(key, raw);
  return base.endsWith(path) ? base : `${base}${path}`;
}

function price(env: Env, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new DeskmatesError("validation", `${key} must be 0 or a positive number of USD`, {
      key,
      raw,
    });
  return n;
}

function pair(env: Env, prefix: OperationPrefix): { url: string; model: string } | undefined {
  const urlKey = `${prefix}_OPERATION_URL`;
  const modelKey = `${prefix}_OPERATION_MODEL`;
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
  return { url, model };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function service(
  env: Env,
  prefix: OperationPrefix,
  url: string,
  model: string,
): OperationServiceConfig {
  const authToken = env[`${prefix}_OPERATION_AUTH_TOKEN`]?.trim();
  const priceUsd = price(env, `${prefix}_OPERATION_PRICE_USD`);
  return {
    url,
    model,
    endpointSha256: sha256(url),
    ...(authToken ? { authToken } : {}),
    ...(priceUsd === undefined ? {} : { priceUsd }),
  };
}

export function readOperationsConfig(env: Env): OperationsConfig {
  const vision = pair(env, "VISION");
  const asr = pair(env, "ASR");
  const image = pair(env, "IMAGE");
  if (!vision && !asr && !image) return {};
  const operations: NonNullable<OperationsConfig["operations"]> = {};
  if (vision) {
    const protocolRaw = env.VISION_OPERATION_PROTOCOL?.trim() || "anthropic-messages";
    if (protocolRaw !== "anthropic-messages" && protocolRaw !== "openai-chat")
      throw new DeskmatesError(
        "validation",
        "VISION_OPERATION_PROTOCOL must be anthropic-messages or openai-chat",
        { key: "VISION_OPERATION_PROTOCOL", raw: protocolRaw },
      );
    const url = endpoint("VISION_OPERATION_URL", vision.url, PATHS[protocolRaw]);
    operations.look = { ...service(env, "VISION", url, vision.model), protocol: protocolRaw };
  }
  if (asr) {
    const url = endpoint("ASR_OPERATION_URL", asr.url, PATHS.asr);
    // The sidecar reads at most the default; the setting may only lower it.
    const maxBytes = optionalInt(env, "ASR_OPERATION_MAX_BYTES", ASR_DEFAULT_MAX_BYTES);
    if (maxBytes > ASR_DEFAULT_MAX_BYTES)
      throw new DeskmatesError(
        "validation",
        `ASR_OPERATION_MAX_BYTES may lower the ${ASR_DEFAULT_MAX_BYTES}-byte bound, not raise it`,
        { key: "ASR_OPERATION_MAX_BYTES" },
      );
    operations.asr = {
      ...service(env, "ASR", url, asr.model),
      maxBytes,
      maxSeconds: optionalInt(env, "ASR_OPERATION_MAX_SECONDS", ASR_DEFAULT_MAX_SECONDS),
    };
  }
  if (image) {
    const url = endpoint("IMAGE_OPERATION_URL", image.url, PATHS.image);
    const defaultSize = env.IMAGE_OPERATION_DEFAULT_SIZE?.trim() || IMAGE_DEFAULT_SIZE;
    if (!parseImageSize(defaultSize))
      throw new DeskmatesError(
        "validation",
        `IMAGE_OPERATION_DEFAULT_SIZE must be <width>x<height>, each side ${IMAGE_SIDE_MIN} to ${IMAGE_SIDE_MAX} and a multiple of 64`,
        { key: "IMAGE_OPERATION_DEFAULT_SIZE", raw: defaultSize },
      );
    operations.image_generation = { ...service(env, "IMAGE", url, image.model), defaultSize };
  }
  return { operations };
}

/**
 * The run-config entry: `{ operations: { look?, asr?, image_generation? } }` with model and endpoint hash per
 * configured operation, or nothing at all, so a run of an installation without them is unchanged.
 */
export function operationStamps(config: OperationsConfig): {
  operations?: Partial<Record<OperationName, OperationStamp>>;
} {
  const ops = config.operations;
  if (!ops || (!ops.look && !ops.asr && !ops.image_generation)) return {};
  const stamp = (s: OperationServiceConfig): OperationStamp => ({
    model: s.model,
    endpointSha256: s.endpointSha256,
  });
  return {
    operations: {
      ...(ops.look ? { look: stamp(ops.look) } : {}),
      ...(ops.asr ? { asr: stamp(ops.asr) } : {}),
      ...(ops.image_generation ? { image_generation: stamp(ops.image_generation) } : {}),
    },
  };
}
