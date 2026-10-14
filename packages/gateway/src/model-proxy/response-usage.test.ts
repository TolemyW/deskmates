// T0: usage read off a model response as it passes through the proxy, without holding a stream.

import { describe, expect, it } from "vitest";
import { ResponseUsageObserver } from "./response-usage.js";

const SSE = [
  "event: message_start\n",
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_1",
      usage: {
        input_tokens: 1200,
        output_tokens: 1,
        cache_read_input_tokens: 30000,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n\n`,
  "event: content_block_delta\n",
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}\n\n`,
  "event: message_delta\n",
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 57 } })}\n\n`,
  "event: message_stop\n",
  `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

function feed(observer: ResponseUsageObserver, text: string, chunk: number): void {
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i += chunk) observer.push(bytes.subarray(i, i + chunk));
}

describe("ResponseUsageObserver", () => {
  it.each([1, 7, 64, 100_000])(
    "reads message_start and message_delta usage from an SSE stream in %i-byte chunks",
    (chunk) => {
      const o = new ResponseUsageObserver("text/event-stream; charset=utf-8");
      feed(o, SSE, chunk);
      expect(o.finish()).toEqual({
        inputTokens: 1200,
        outputTokens: 57,
        cacheReadTokens: 30000,
        cacheCreateTokens: 0,
      });
    },
  );

  it("handles CRLF line endings", () => {
    const o = new ResponseUsageObserver("text/event-stream");
    feed(o, SSE.replace(/\n/g, "\r\n"), 5);
    expect(o.finish()?.outputTokens).toBe(57);
  });

  it("keeps what it saw of a stream cut short, and nothing it did not", () => {
    const o = new ResponseUsageObserver("text/event-stream");
    feed(o, SSE.slice(0, SSE.indexOf("event: message_delta")), 13);
    expect(o.finish()).toEqual({
      inputTokens: 1200,
      outputTokens: 1,
      cacheReadTokens: 30000,
      cacheCreateTokens: 0,
    });
  });

  it("reads usage from a non-streaming JSON response", () => {
    const o = new ResponseUsageObserver("application/json");
    feed(
      o,
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "é unicode across chunks ✓" }],
        usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: null },
      }),
      3,
    );
    expect(o.finish()).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it("reports nothing for a body without usage, a broken body or another content type", () => {
    const noUsage = new ResponseUsageObserver("application/json");
    feed(noUsage, JSON.stringify({ input_tokens: 42 }), 4);
    expect(noUsage.finish()).toBeUndefined();

    const broken = new ResponseUsageObserver("application/json");
    feed(broken, '{"usage": {"input_tok', 4);
    expect(broken.finish()).toBeUndefined();

    const binary = new ResponseUsageObserver("application/octet-stream");
    binary.push(Buffer.from([0, 1, 2]));
    expect(binary.finish()).toBeUndefined();
  });

  it("stops copying a JSON body past its cap instead of holding it", () => {
    const o = new ResponseUsageObserver("application/json", { jsonMaxBytes: 16 });
    feed(o, JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), 4);
    expect(o.finish()).toBeUndefined();
  });
});

describe("ResponseUsageObserver: thinking tokens (reasoning knob)", () => {
  it("reads output_tokens_details.thinking_tokens and leaves it unknown when absent", () => {
    const withThinking = new ResponseUsageObserver("application/json");
    withThinking.push(
      Buffer.from(
        JSON.stringify({
          usage: {
            input_tokens: 10,
            output_tokens: 30,
            output_tokens_details: { thinking_tokens: 25 },
          },
        }),
      ),
    );
    expect(withThinking.finish()).toEqual({
      inputTokens: 10,
      outputTokens: 30,
      thinkingTokens: 25,
    });

    // An Anthropic-protocol gateway in front of another model may spell it reasoning_tokens.
    const reasoning = new ResponseUsageObserver("application/json");
    reasoning.push(
      Buffer.from(
        JSON.stringify({
          usage: { output_tokens: 3, output_tokens_details: { reasoning_tokens: 2 } },
        }),
      ),
    );
    expect(reasoning.finish()).toEqual({ outputTokens: 3, thinkingTokens: 2 });

    const without = new ResponseUsageObserver("application/json");
    without.push(Buffer.from(JSON.stringify({ usage: { output_tokens: 3 } })));
    expect(without.finish()).toEqual({ outputTokens: 3 });
  });
});
