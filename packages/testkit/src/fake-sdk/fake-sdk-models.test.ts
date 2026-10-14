// T0: the fake SDK's model-switch, retry and failure steps (ADR-0023 decision 3; test plan gap
// G9). They are what the sidecar's `model_switch` / `model_retry` tests drive, so they mirror the
// real SDK: `PostModelSwitch` hooks before the new model serves, `system` / `api_retry` messages,
// per-model `modelUsage` on the result, and an `error_during_execution` result for a failure.

import { describe, expect, it } from "vitest";
import { createFakeSdk } from "./fake-sdk.js";
import type { ScriptStep } from "./script.js";
import type {
  SdkMessage,
  SdkPostModelSwitchHookInput,
  SdkQueryOptions,
  SdkResultMessage,
} from "./sdk-shapes.js";

async function play(script: readonly ScriptStep[], options: SdkQueryOptions) {
  const sdk = createFakeSdk(script);
  const messages: SdkMessage[] = [];
  for await (const m of sdk.query({ prompt: "go", options })) messages.push(m);
  const result = messages.find((m): m is SdkResultMessage => m.type === "result");
  if (!result) throw new Error("no result");
  return { sdk, messages, result };
}

describe("fake SDK: model switches", () => {
  it("runs PostModelSwitch hooks and reports usage per model", async () => {
    const seen: SdkPostModelSwitchHookInput[] = [];
    const { messages, result } = await play(
      [
        { type: "text", text: "first", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "model_switch", source: "auto" },
        { type: "text", text: "second", usage: { inputTokens: 7, outputTokens: 3 } },
        { type: "end", summary: "done" },
      ],
      {
        model: "primary",
        fallbackModel: "fallback-a,fallback-b",
        hooks: {
          PostModelSwitch: [
            {
              hooks: [
                async (input) => {
                  seen.push(input);
                  return {};
                },
              ],
            },
          ],
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      hook_event_name: "PostModelSwitch",
      from_model: "primary",
      to_model: "fallback-a",
      source: "auto",
    });
    const models = messages.flatMap((m) => (m.type === "assistant" ? [m.message.model] : []));
    expect(models).toEqual(["primary", "fallback-a"]);
    expect(Object.keys(result.modelUsage).sort()).toEqual(["fallback-a", "primary"]);
    expect(result.modelUsage.primary?.inputTokens).toBe(100);
    expect(result.modelUsage["fallback-a"]?.inputTokens).toBe(7);
    expect(result.usage.input_tokens).toBe(107);
  });

  it("switches to an explicit target with the given source and ignores a throwing hook", async () => {
    const { result } = await play(
      [
        { type: "model_switch", to: "other", source: "resume", requested: "other" },
        { type: "text", text: "hi" },
        { type: "end", summary: "done" },
      ],
      {
        model: "primary",
        hooks: {
          PostModelSwitch: [
            {
              hooks: [
                async () => {
                  throw new Error("hook broke");
                },
              ],
            },
          ],
        },
      },
    );
    // Nothing was served on the primary, so only the model that answered is reported.
    expect(Object.keys(result.modelUsage)).toEqual(["other"]);
  });

  it("reports an overload fallback as system/model_fallback without the hook, as SDK 0.3.278 does", async () => {
    const seen: SdkPostModelSwitchHookInput[] = [];
    const { messages, result } = await play(
      [
        { type: "text", text: "first", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "model_fallback" },
        { type: "text", text: "second", usage: { inputTokens: 7, outputTokens: 1 } },
        { type: "end", summary: "done" },
      ],
      {
        model: "primary",
        fallbackModel: "fallback-a",
        hooks: {
          PostModelSwitch: [
            {
              hooks: [
                async (input) => {
                  seen.push(input);
                  return {};
                },
              ],
            },
          ],
        },
      },
    );
    expect(seen).toHaveLength(0);
    const fallback = messages.find(
      (m) => m.type === "system" && (m as { subtype: string }).subtype === "model_fallback",
    );
    expect(fallback).toMatchObject({
      type: "system",
      subtype: "model_fallback",
      trigger: "overloaded",
      original_model: "primary",
      fallback_model: "fallback-a",
    });
    const models = messages.flatMap((m) => (m.type === "assistant" ? [m.message.model] : []));
    expect(models).toEqual(["primary", "fallback-a"]);
    expect(Object.keys(result.modelUsage).sort()).toEqual(["fallback-a", "primary"]);
  });

  it("can also run the hook before or after the fallback message", async () => {
    for (const hook of ["before", "after"] as const) {
      const order: string[] = [];
      const sdk = createFakeSdk([
        { type: "model_fallback", hook },
        { type: "end", summary: "done" },
      ]);
      for await (const m of sdk.query({
        prompt: "go",
        options: {
          model: "primary",
          fallbackModel: "fallback-a",
          hooks: {
            PostModelSwitch: [
              {
                hooks: [
                  async (input) => {
                    order.push(`hook ${input.from_model}->${input.to_model}`);
                    return {};
                  },
                ],
              },
            ],
          },
        },
      })) {
        if (m.type === "system" && (m as { subtype: string }).subtype === "model_fallback")
          order.push("message");
      }
      expect(order).toEqual(
        hook === "before"
          ? ["hook primary->fallback-a", "message"]
          : ["message", "hook primary->fallback-a"],
      );
    }
  });

  it("refuses a switch with no target and no fallback configured", async () => {
    await expect(
      play([{ type: "model_switch" }, { type: "end", summary: "x" }], { model: "primary" }),
    ).rejects.toThrow(/fallbackModel/);
  });

  it("keeps a single-model session's result exactly as before", async () => {
    const { result } = await play(
      [
        { type: "text", text: "a" },
        { type: "end", summary: "done", usage: { outputTokens: 99 } },
      ],
      { model: "primary" },
    );
    expect(Object.keys(result.modelUsage)).toEqual(["primary"]);
    expect(result.modelUsage.primary?.outputTokens).toBe(99);
    expect(result.usage.output_tokens).toBe(99);
  });
});

describe("fake SDK: retries and failures", () => {
  it("emits api_retry messages with the retry counters", async () => {
    const { messages } = await play(
      [
        { type: "api_retry", attempt: 1, errorStatus: 429, error: "rate_limit", retryDelayMs: 500 },
        { type: "api_retry", attempt: 2, errorStatus: null },
        { type: "text", text: "ok" },
        { type: "end", summary: "ok" },
      ],
      { model: "primary" },
    );
    const retries = messages.filter((m) => m.type === "system" && m.subtype === "api_retry");
    expect(retries).toEqual([
      expect.objectContaining({
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 429,
        error: "rate_limit",
      }),
      expect.objectContaining({ attempt: 2, error_status: null, error: "unknown" }),
    ]);
  });

  it("ends a failed session with one error_during_execution result", async () => {
    const { messages, result } = await play(
      [
        { type: "api_retry", attempt: 1, errorStatus: 503, error: "server_error" },
        { type: "fail", errors: ["API Error: 503 upstream unavailable"] },
        { type: "text", text: "never" },
      ],
      { model: "primary" },
    );
    expect(result).toMatchObject({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["API Error: 503 upstream unavailable"],
    });
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
    expect(messages.some((m) => m.type === "assistant")).toBe(false);
  });
});
