// T0: the fixed upstream requests of the operation proxy (ADR-0040 decision 3).

import { describe, expect, it } from "vitest";
import type { AsrOperationConfig, LookOperationConfig } from "../config/operations.js";
import {
  LOOK_MAX_TOKENS,
  asrRequest,
  lookPrompt,
  lookRequest,
  parseAsrResponse,
  parseLookResponse,
} from "./operation-adapters.js";

const look: LookOperationConfig = {
  url: "http://v.internal/v1/messages",
  model: "qwen3.5-9b-vl",
  protocol: "anthropic-messages",
  endpointSha256: "x",
};

describe("lookRequest", () => {
  it("builds one user turn with the image, the mode template and the question", () => {
    const { url, init } = lookRequest(look, {
      mode: "ocr",
      question: "What is the total?",
      mediaType: "image/png",
      data: "AAAA",
    });
    expect(url).toBe(look.url);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "qwen3.5-9b-vl",
      max_tokens: LOOK_MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: lookPrompt("ocr", "What is the total?") },
          ],
        },
      ],
    });
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("differs per mode and sends a configured Bearer", () => {
    expect(lookPrompt("ocr", undefined)).toMatch(/Transcribe all text/);
    expect(lookPrompt("describe", undefined)).toMatch(/Describe this image/);
    const { init } = lookRequest(
      { ...look, authToken: "tok" },
      { mode: "describe", mediaType: "image/jpeg", data: "AAAA" },
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("uses an image_url data URI on the openai-chat route", () => {
    const { init } = lookRequest(
      { ...look, protocol: "openai-chat" },
      { mode: "ocr", mediaType: "image/webp", data: "AAAA" },
    );
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/webp;base64,AAAA" },
    });
  });
});

describe("parseLookResponse", () => {
  it("reads Messages text blocks and usage", () => {
    expect(
      parseLookResponse("anthropic-messages", {
        content: [
          { type: "text", text: "a" },
          { type: "thinking", thinking: "x" },
          { type: "text", text: "b" },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    ).toEqual({ text: "ab", inputTokens: 5, outputTokens: 2 });
  });
  it("reads a chat completion and treats anything else as malformed", () => {
    expect(
      parseLookResponse("openai-chat", {
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 3 },
      }),
    ).toEqual({ text: "hi", inputTokens: 3, outputTokens: null });
    expect(parseLookResponse("anthropic-messages", { error: "x" })).toBeUndefined();
    expect(parseLookResponse("openai-chat", { choices: [] })).toBeUndefined();
    expect(parseLookResponse("openai-chat", null)).toBeUndefined();
  });
});

describe("asrRequest and parseAsrResponse", () => {
  const asr: AsrOperationConfig = {
    url: "http://a.internal/v1/audio/transcriptions",
    model: "whisper",
    endpointSha256: "x",
    maxBytes: 100,
    maxSeconds: 10,
  };
  it("sends file, model, verbose_json and the language", async () => {
    const { init } = asrRequest(asr, {
      bytes: Buffer.from("RIFF"),
      mediaType: "audio/wav",
      fileName: "note.wav",
      language: "zh",
    });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("zh");
    const file = form.get("file") as File;
    expect(file.name).toBe("note.wav");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("RIFF");
  });
  it("reads text, language and duration; absent ones are null", () => {
    expect(parseAsrResponse({ text: "hi", language: "en", duration: 2 })).toEqual({
      text: "hi",
      language: "en",
      durationSeconds: 2,
    });
    expect(parseAsrResponse({ text: "hi" })).toEqual({
      text: "hi",
      language: null,
      durationSeconds: null,
    });
    expect(parseAsrResponse({ segments: [] })).toBeUndefined();
  });
});
