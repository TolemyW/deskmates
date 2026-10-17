// The fixed upstream requests of the operation proxy (ADR-0040 decision 3). A run token buys one
// bounded operation: the Gateway builds the body from a template, so neither the request, nor a
// file name, nor page content can choose the model, the prompt template or the output size.

import type { LookMode } from "@deskmates/contracts";
import type { AsrOperationConfig, LookOperationConfig } from "../config/operations.js";

/** Output bound of one `look` call. */
export const LOOK_MAX_TOKENS = 2048;

const INSTRUCTIONS: Record<LookMode, string> = {
  ocr: [
    "Transcribe all text visible in this image exactly as written, in reading order.",
    "Keep line breaks, keep the original language, and render tables as rows separated by ' | '.",
    "Do not translate, summarize or explain. Mark unreadable parts as [illegible].",
    "If the image contains no text, answer exactly: [no text]",
  ].join(" "),
  describe: [
    "Describe this image accurately and concretely: what it shows, its layout, any visible text,",
    "numbers, charts or interface elements. Say when something is unclear rather than guessing.",
  ].join(" "),
};

/** The instruction text of one `look` call: the mode's template, then the question if any. */
export function lookPrompt(mode: LookMode, question: string | undefined): string {
  const q = question?.trim();
  return q ? `${INSTRUCTIONS[mode]}\n\nQuestion about the image: ${q}` : INSTRUCTIONS[mode];
}

export interface UpstreamRequest {
  url: string;
  init: RequestInit;
}

function authHeaders(service: { authToken?: string }): Record<string, string> {
  return service.authToken ? { authorization: `Bearer ${service.authToken}` } : {};
}

export function lookRequest(
  service: LookOperationConfig,
  input: { mode: LookMode; question?: string; mediaType: string; data: string },
): UpstreamRequest {
  const prompt = lookPrompt(input.mode, input.question);
  const body =
    service.protocol === "openai-chat"
      ? {
          model: service.model,
          max_tokens: LOOK_MAX_TOKENS,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${input.mediaType};base64,${input.data}` },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
        }
      : {
          model: service.model,
          max_tokens: LOOK_MAX_TOKENS,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: input.mediaType, data: input.data },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
        };
  return {
    url: service.url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(service.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
        ...authHeaders(service),
      },
      body: JSON.stringify(body),
    },
  };
}

export interface LookResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** The text and token counts of a `look` answer, or undefined when the body is not one. */
export function parseLookResponse(
  protocol: LookOperationConfig["protocol"],
  body: unknown,
): LookResult | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  if (protocol === "openai-chat") {
    const choices = record.choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content !== "string") return undefined;
    return {
      text: message.content,
      inputTokens: count(usage.prompt_tokens),
      outputTokens: count(usage.completion_tokens),
    };
  }
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .flatMap((block: unknown) => {
      const b = block as { type?: unknown; text?: unknown };
      return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
    })
    .join("");
  return {
    text,
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

export function asrRequest(
  service: AsrOperationConfig,
  input: { bytes: Buffer; mediaType: string; fileName: string; language?: string },
): UpstreamRequest {
  const form = new FormData();
  form.append("file", new Blob([input.bytes], { type: input.mediaType }), input.fileName);
  form.append("model", service.model);
  form.append("response_format", "verbose_json");
  if (input.language) form.append("language", input.language);
  return {
    url: service.url,
    // fetch sets the multipart content type with its boundary.
    init: { method: "POST", headers: authHeaders(service), body: form },
  };
}

export interface AsrResult {
  text: string;
  language: string | null;
  durationSeconds: number | null;
}

/** The transcript of an OpenAI-compatible transcription answer (`json` or `verbose_json`). */
export function parseAsrResponse(body: unknown): AsrResult | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") return undefined;
  const duration = record.duration;
  return {
    text: record.text,
    language:
      typeof record.language === "string" && record.language !== "" ? record.language : null,
    durationSeconds:
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
  };
}
