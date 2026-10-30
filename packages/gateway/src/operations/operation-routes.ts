// The operation proxy (ADR-0040): `POST /internal/runs/:runId/operations/look`, `/asr` and
// `/image_generation` (amendment B), run token scoped by the internal scope's preHandler. A sidecar
// tool sends a normalized request; the Gateway checks it, builds the one upstream request,
// forwards it once with no retry, records the call and returns the result. It never starts an
// operation on its own.

import { createHash } from "node:crypto";
import {
  ASR_LANGUAGE,
  type AsrOperationResponse,
  DeskmatesError,
  type GeneratedImage,
  IMAGE_MAX_COUNT,
  IMAGE_OUTPUT_MAX_BYTES,
  IMAGE_PROMPT_MAX_CHARS,
  IMAGE_SIDE_MAX,
  IMAGE_SIDE_MIN,
  type ImageGenerationResponse,
  LOOK_IMAGE_MAX_BYTES,
  LOOK_QUESTION_MAX_CHARS,
  type LookMode,
  type LookOperationResponse,
  type OperationMeasured,
  type OperationName,
  type OperationUnit,
  type OperationUsage,
  type RunId,
  type WorkspaceId,
  imageDimensions,
  parseImageSize,
  sniffAudio,
  sniffGeneratedImage,
  sniffLookImage,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type {
  AsrOperationConfig,
  ImageOperationConfig,
  LookOperationConfig,
} from "../config/operations.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import {
  type UpstreamRequest,
  asrRequest,
  imageRequest,
  lookRequest,
  parseAsrResponse,
  parseImageResponse,
  parseLookResponse,
} from "./operation-adapters.js";
import { OperationStore } from "./operation-store.js";

/** One `look` call: a 9B vision model on a page image answers in seconds; this is the ceiling. */
export const LOOK_TIMEOUT_MS = 120_000;
/** One `asr` call: a 30-minute file on a CPU whisper can take minutes. */
export const ASR_TIMEOUT_MS = 300_000;
/** One `image_generation` call: up to four images from a diffusion model (amendment B). */
export const IMAGE_TIMEOUT_MS = 300_000;

interface OperationModule {
  store: OperationStore;
  fetch: typeof globalThis.fetch;
}

const modules = new WeakMap<GatewayContext, OperationModule>();

function operationsOf(ctx: GatewayContext): OperationModule {
  let module = modules.get(ctx);
  if (!module) {
    module = { store: new OperationStore(ctx.db), fetch: globalThis.fetch };
    modules.set(ctx, module);
  }
  return module;
}

/** Tests point the proxy at the testkit fake operation upstream. */
export function setOperationFetch(ctx: GatewayContext, fetch: typeof globalThis.fetch): void {
  operationsOf(ctx).fetch = fetch;
}

/** The context's operation rows, for tests and later readers. */
export function operationStore(ctx: GatewayContext): OperationStore {
  return operationsOf(ctx).store;
}

/** Base64 of `max` bytes plus room for the rest of the JSON body. */
const bodyLimit = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4 + 64 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(data: unknown, maxBytes: number): Buffer {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data))
    throw new DeskmatesError("validation", "data must be non-empty base64");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > maxBytes)
    throw new DeskmatesError("payload_too_large", `the input exceeds ${maxBytes} bytes`, {
      maxBytes,
      bytes: bytes.length,
    });
  return bytes;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

interface Call {
  ctx: GatewayContext;
  run: RunRecord;
  workspaceId: WorkspaceId;
  operation: OperationName;
  mode: LookMode | null;
  service: { model: string; endpointSha256: string; priceUsd?: number };
  unit: OperationUnit;
  bytes: Buffer;
}

function record(
  call: Call,
  outcome: {
    status: "succeeded" | "failed" | "refused";
    errorCode: string | null;
    quantity: number | null;
    measured: OperationMeasured;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number | null;
  },
): { id: string; usage: OperationUsage } {
  const { priceUsd } = call.service;
  const costUsd =
    outcome.status === "refused" || outcome.quantity === null || priceUsd === undefined
      ? null
      : outcome.quantity * priceUsd;
  const usage: OperationUsage = {
    unit: call.unit,
    quantity: outcome.quantity,
    measured: outcome.measured,
    inputTokens: outcome.inputTokens ?? null,
    outputTokens: outcome.outputTokens ?? null,
    costUsd,
  };
  const id = operationsOf(call.ctx).store.record({
    workspaceId: call.workspaceId,
    runId: call.run.id,
    attempt: call.run.attempt,
    operation: call.operation,
    mode: call.mode,
    model: call.service.model,
    endpointSha256: call.service.endpointSha256,
    status: outcome.status,
    errorCode: outcome.errorCode,
    unit: call.unit,
    quantity: outcome.quantity,
    measured: outcome.measured,
    inputBytes: call.bytes.length,
    inputSha256: call.bytes.length > 0 ? sha256(call.bytes) : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: outcome.latencyMs ?? null,
    costUsd,
  });
  call.ctx.events.append({
    runId: call.run.id,
    attempt: call.run.attempt,
    kind: "log",
    payload: {
      source: "operation",
      operation: call.operation,
      operationId: id,
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      unit: call.unit,
      quantity: outcome.quantity,
      model: call.service.model,
    },
  });
  // ADR-0040 amendment A, decision 12: a forwarded call is charged to the budget as soon as it is
  // recorded; a refusal never reached the service and charges nothing.
  if (outcome.status !== "refused") {
    try {
      call.ctx.budget.charge(call.run.id);
    } catch {
      // Accounting only; the operation already happened and its row is the receipt.
    }
  }
  return { id, usage };
}

/** ADR-0032 admission: an exhausted workspace is refused before the service sees anything. */
function admit(call: Call): void {
  const verdict = call.ctx.budget.verdict(call.workspaceId);
  if (!verdict.exhausted) return;
  record(call, {
    status: "refused",
    errorCode: "budget_exhausted",
    quantity: null,
    measured: "unknown",
  });
  throw new DeskmatesError(
    "budget_exhausted",
    `the workspace's ${verdict.exhausted} budget is exhausted`,
    { limitKind: verdict.exhausted, limitUsd: verdict.limitUsd, spendUsd: verdict.spendUsd },
  );
}

/**
 * One upstream call, no retry (ADR-0040 decision 1). A failure is recorded with the units the
 * call would have used marked unknown, since the service may have done the work.
 */
async function forward(
  call: Call,
  request: UpstreamRequest,
  timeoutMs: number,
): Promise<{ body: unknown; latencyMs: number }> {
  const started = Date.now();
  const fail = (reason: string, details: Record<string, unknown> = {}): never => {
    record(call, {
      status: "failed",
      errorCode: reason,
      quantity: null,
      measured: "unknown",
      latencyMs: Date.now() - started,
    });
    throw new DeskmatesError("operation_unavailable", `the ${call.operation} service ${reason}`, {
      reason,
      operation: call.operation,
      ...details,
    });
  };
  let response: Response;
  try {
    response = await operationsOf(call.ctx).fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return fail(timedOut ? "timed_out" : "unreachable");
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) return fail("answered_error", { status: response.status });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("answered_malformed");
  }
  return { body, latencyMs: Date.now() - started };
}

function runOf(ctx: GatewayContext, runId: string): { run: RunRecord; workspaceId: WorkspaceId } {
  const run = ctx.runs.mustGet(runId as RunId);
  return { run, workspaceId: ctx.bots.mustGet(run.botId).workspaceId };
}

function notConfigured(operation: OperationName): never {
  throw new DeskmatesError("not_found", `the ${operation} operation is not configured`, {
    operation,
  });
}

function sourceOf(raw: unknown): void {
  const source = raw as { path?: unknown; page?: unknown } | undefined;
  if (!source || typeof source.path !== "string" || source.path.length > 4096)
    throw new DeskmatesError("validation", "source.path is required");
  if (
    source.page !== undefined &&
    (typeof source.page !== "number" || !Number.isSafeInteger(source.page) || source.page < 1)
  )
    throw new DeskmatesError("validation", "source.page must be a positive integer");
}

async function look(
  ctx: GatewayContext,
  service: LookOperationConfig,
  runId: string,
  raw: unknown,
): Promise<LookOperationResponse> {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (body.mode !== "ocr" && body.mode !== "describe")
    throw new DeskmatesError("validation", "mode must be ocr or describe");
  const mode = body.mode;
  if (body.unit !== "image" && body.unit !== "page")
    throw new DeskmatesError("validation", "unit must be image or page");
  const unit = body.unit;
  if (
    body.question !== undefined &&
    (typeof body.question !== "string" || body.question.length > LOOK_QUESTION_MAX_CHARS)
  )
    throw new DeskmatesError(
      "validation",
      `question must be text of at most ${LOOK_QUESTION_MAX_CHARS} characters`,
    );
  sourceOf(body.source);
  const bytes = decode(body.data, LOOK_IMAGE_MAX_BYTES);
  const sniffed = sniffLookImage(bytes);
  if (!sniffed || sniffed !== body.mediaType)
    throw new DeskmatesError("validation", "the bytes are not the PNG, JPEG, GIF or WebP named", {
      mediaType: body.mediaType,
      sniffed: sniffed ?? null,
    });
  const { run, workspaceId } = runOf(ctx, runId);
  const call: Call = { ctx, run, workspaceId, operation: "look", mode, service, unit, bytes };
  admit(call);
  const question = typeof body.question === "string" ? body.question : undefined;
  const request = lookRequest(service, {
    mode,
    ...(question === undefined ? {} : { question }),
    mediaType: sniffed,
    data: body.data as string,
  });
  const { body: answer, latencyMs } = await forward(call, request, LOOK_TIMEOUT_MS);
  const parsed = parseLookResponse(service.protocol, answer);
  if (!parsed) {
    record(call, {
      status: "failed",
      errorCode: "answered_malformed",
      quantity: null,
      measured: "unknown",
      latencyMs,
    });
    throw new DeskmatesError("operation_unavailable", "the look service answered_malformed", {
      reason: "answered_malformed",
      operation: "look",
    });
  }
  const { id, usage } = record(call, {
    status: "succeeded",
    errorCode: null,
    quantity: 1,
    measured: "computed",
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    latencyMs,
  });
  return { operationId: id, model: service.model, text: parsed.text, usage };
}

const FILE_NAME = /^[^/\\\0]{1,255}$/;

async function asr(
  ctx: GatewayContext,
  service: AsrOperationConfig,
  runId: string,
  raw: unknown,
): Promise<AsrOperationResponse> {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (
    body.language !== undefined &&
    (typeof body.language !== "string" || !ASR_LANGUAGE.test(body.language))
  )
    throw new DeskmatesError("validation", "language must be two or three lower-case letters");
  if (typeof body.fileName !== "string" || !FILE_NAME.test(body.fileName))
    throw new DeskmatesError("validation", "fileName must be a base name");
  if (
    body.durationSeconds !== undefined &&
    (typeof body.durationSeconds !== "number" ||
      !Number.isFinite(body.durationSeconds) ||
      body.durationSeconds < 0)
  )
    throw new DeskmatesError("validation", "durationSeconds must be a non-negative number");
  sourceOf(body.source);
  const bytes = decode(body.data, service.maxBytes);
  const sniffed = sniffAudio(bytes);
  if (!sniffed || sniffed !== body.mediaType)
    throw new DeskmatesError("validation", "the bytes are not the audio type named", {
      mediaType: body.mediaType,
      sniffed: sniffed ?? null,
    });
  const computed = body.durationSeconds as number | undefined;
  if (computed !== undefined && computed > service.maxSeconds)
    throw new DeskmatesError(
      "payload_too_large",
      `the audio is longer than ${service.maxSeconds} seconds`,
      { maxSeconds: service.maxSeconds, durationSeconds: computed },
    );
  const { run, workspaceId } = runOf(ctx, runId);
  const call: Call = {
    ctx,
    run,
    workspaceId,
    operation: "asr",
    mode: null,
    service,
    unit: "audio_second",
    bytes,
  };
  admit(call);
  const language = typeof body.language === "string" ? body.language : undefined;
  const request = asrRequest(service, {
    bytes,
    mediaType: sniffed,
    fileName: body.fileName,
    ...(language === undefined ? {} : { language }),
  });
  const { body: answer, latencyMs } = await forward(call, request, ASR_TIMEOUT_MS);
  const parsed = parseAsrResponse(answer);
  if (!parsed) {
    record(call, {
      status: "failed",
      errorCode: "answered_malformed",
      quantity: null,
      measured: "unknown",
      latencyMs,
    });
    throw new DeskmatesError("operation_unavailable", "the asr service answered_malformed", {
      reason: "answered_malformed",
      operation: "asr",
    });
  }
  // The service's duration is the billed quantity; the sidecar's WAV header count is the fallback.
  const quantity = parsed.durationSeconds ?? computed ?? null;
  const measured: OperationMeasured =
    parsed.durationSeconds !== null ? "provider" : computed !== undefined ? "computed" : "unknown";
  const { id, usage } = record(call, {
    status: "succeeded",
    errorCode: null,
    quantity,
    measured,
    latencyMs,
  });
  return {
    operationId: id,
    model: service.model,
    text: parsed.text,
    language: parsed.language,
    durationSeconds: quantity,
    usage,
  };
}

/** One generated image the service returned, checked (amendment B, decision 19), or undefined. */
function decodeGenerated(data: string): GeneratedImage | undefined {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > IMAGE_OUTPUT_MAX_BYTES) return undefined;
  const mediaType = sniffGeneratedImage(bytes);
  if (!mediaType) return undefined;
  const size = imageDimensions(bytes);
  return {
    mediaType,
    data,
    bytes: bytes.length,
    sha256: sha256(bytes),
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/** ADR-0040 amendment B: one text-to-image call on the installation's image service. */
async function imageGeneration(
  ctx: GatewayContext,
  service: ImageOperationConfig,
  runId: string,
  raw: unknown,
): Promise<ImageGenerationResponse> {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof body.prompt !== "string" ||
    body.prompt.trim() === "" ||
    body.prompt.length > IMAGE_PROMPT_MAX_CHARS
  )
    throw new DeskmatesError(
      "validation",
      `prompt must be text of 1 to ${IMAGE_PROMPT_MAX_CHARS} characters`,
    );
  const size = body.size === undefined ? service.defaultSize : body.size;
  if (typeof size !== "string" || !parseImageSize(size))
    throw new DeskmatesError(
      "validation",
      `size must be <width>x<height>, each side ${IMAGE_SIDE_MIN} to ${IMAGE_SIDE_MAX} and a multiple of 64`,
      { size: typeof size === "string" ? size : null },
    );
  const count = body.count === undefined ? 1 : body.count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > IMAGE_MAX_COUNT
  )
    throw new DeskmatesError("validation", `count must be 1 to ${IMAGE_MAX_COUNT}`);
  const { run, workspaceId } = runOf(ctx, runId);
  const call: Call = {
    ctx,
    run,
    workspaceId,
    operation: "image_generation",
    mode: null,
    service,
    unit: "image",
    // The prompt is the input: its size and hash are recorded, its text is not.
    bytes: Buffer.from(body.prompt, "utf8"),
  };
  admit(call);
  const request = imageRequest(service, { prompt: body.prompt, size, count });
  const { body: answer, latencyMs } = await forward(call, request, IMAGE_TIMEOUT_MS);
  const parsed = parseImageResponse(answer);
  const images =
    parsed && parsed.images.length <= count ? parsed.images.map(decodeGenerated) : undefined;
  if (!parsed || !images || images.some((image) => image === undefined)) {
    record(call, {
      status: "failed",
      errorCode: "answered_malformed",
      quantity: null,
      measured: "unknown",
      latencyMs,
    });
    throw new DeskmatesError(
      "operation_unavailable",
      "the image_generation service answered_malformed",
      { reason: "answered_malformed", operation: "image_generation" },
    );
  }
  const checked = images as GeneratedImage[];
  const { id, usage } = record(call, {
    status: "succeeded",
    errorCode: null,
    quantity: checked.length,
    measured: "computed",
    latencyMs,
  });
  return {
    operationId: id,
    model: service.model,
    images: checked,
    revisedPrompt: parsed.revisedPrompt,
    usage,
  };
}

/** Registered inside the internal scope, whose preHandler checks the run token against the path. */
export function registerOperationInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  type Params = { Params: { runId: string } };
  app.post<Params>(
    "/internal/runs/:runId/operations/look",
    { bodyLimit: bodyLimit(LOOK_IMAGE_MAX_BYTES) },
    async (request) => {
      const service = ctx.config.operations?.look;
      if (!service) return notConfigured("look");
      return look(ctx, service, request.params.runId, request.body);
    },
  );
  app.post<Params>(
    "/internal/runs/:runId/operations/asr",
    { bodyLimit: bodyLimit(ctx.config.operations?.asr?.maxBytes ?? 1024 * 1024) },
    async (request) => {
      const service = ctx.config.operations?.asr;
      if (!service) return notConfigured("asr");
      return asr(ctx, service, request.params.runId, request.body);
    },
  );
  app.post<Params>("/internal/runs/:runId/operations/image_generation", async (request) => {
    const service = ctx.config.operations?.image_generation;
    if (!service) return notConfigured("image_generation");
    return imageGeneration(ctx, service, request.params.runId, request.body);
  });
}
