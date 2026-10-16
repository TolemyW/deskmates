// One tool-free model turn over the OpenAI Chat Completions API (ADR-0042 decision 7, as
// amended): what a model job or a presentation summary needs when the bot's runtime is
// `openai-agents`. The request goes to the Gateway's model proxy with the run's token, like the
// agent loop's; the proxy swaps the credential and records the usage.

import OpenAI from "openai";
import type { OpenAiCompletionFn } from "./types.js";

export function createOpenAiCompletion(): OpenAiCompletionFn {
  return async (params) => {
    const client = new OpenAI({
      baseURL: `${params.modelBaseUrl.replace(/\/+$/, "")}/v1`,
      apiKey: params.modelAuthToken,
      maxRetries: params.maxRetries ?? 2,
    });
    const content = params.content.map((part) =>
      part.type === "text"
        ? ({ type: "text", text: part.text } as const)
        : ({
            type: "image_url",
            image_url: { url: `data:${part.mediaType};base64,${part.base64}` },
          } as const),
    );
    const response = await client.chat.completions.create(
      {
        model: params.model,
        max_tokens: params.maxOutputTokens,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content },
        ],
      },
      { signal: params.signal },
    );
    const usage = response.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: response.choices[0]?.message.content ?? "",
      model: response.model || params.model,
      usage: {
        inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadInputTokens: cached,
      },
    };
  };
}
