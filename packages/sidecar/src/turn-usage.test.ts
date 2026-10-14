// T0: one `turn_usage` per model response, however many assistant messages the SDK splits it into
// (sdk.d.ts 0.3.278, SDKAssistantMessage: one message per completed content block, sharing
// `message.id`; final streamed usage arrives after the content-block envelopes).

import type { TurnUsagePayload } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { type AssistantUsageMessage, TurnUsageTracker } from "./turn-usage.js";

function msg(
  id: string,
  input: number,
  output: number,
  cacheRead: number | null = 0,
  cacheCreate: number | null = 0,
): AssistantUsageMessage {
  return {
    message: {
      id,
      model: "model-under-test",
      stop_reason: "end_turn",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  };
}

describe("TurnUsageTracker", () => {
  it("emits one event per response id, numbered from 1, with the last usage seen for it", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observe(msg("a", 100, 1, 900, 0));
    t.observe(msg("a", 100, 40, 900, 0));
    expect(out).toEqual([]);
    t.observe(msg("b", 20, 7, 1000, 5));
    t.flush();
    t.flush();
    expect(out).toEqual([
      {
        model: "model-under-test",
        turn: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 900,
        cacheCreateTokens: 0,
      },
      {
        model: "model-under-test",
        turn: 2,
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 1000,
        cacheCreateTokens: 5,
      },
    ]);
  });

  it("does not count a late block of a response already ledgered as a new turn", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observe(msg("a", 10, 1));
    t.observe(msg("b", 10, 1));
    t.observe(msg("a", 10, 1));
    t.flush();
    expect(out.map((p) => p.turn)).toEqual([1, 2]);
  });

  it("preserves null cache counts as unknown", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observe(msg("a", 10, 1, null, null));
    t.flush();
    expect(out[0]).toMatchObject({ cacheReadTokens: null, cacheCreateTokens: null });
  });

  it("records a response without usage without inventing zero tokens", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observe({ message: { id: "missing", model: "model-under-test" } });
    t.flush();
    expect(out).toEqual([
      {
        model: "model-under-test",
        turn: 1,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
      },
    ]);
  });

  it("uses final streamed output rather than provisional assistant blocks, exactly once", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    const m = msg("a", 351, 1);
    m.message.stop_reason = null;
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_start", message: m.message },
    });
    t.observe(m);
    t.observe(m);
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: 132 } },
    });
    t.observeStream({ parent_tool_use_id: null, event: { type: "message_stop" } });
    t.observe(m);
    t.flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ turn: 1, inputTokens: 351, outputTokens: 132 });
  });

  it("merges final input/cache measurements without overwriting fields absent from the delta", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_start", message: msg("a", 10, 1, 30, 5).message },
    });
    t.observeStream({
      parent_tool_use_id: null,
      event: {
        type: "message_delta",
        usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: null },
      },
    });
    t.observeStream({ parent_tool_use_id: null, event: { type: "message_stop" } });
    expect(out[0]).toMatchObject({
      inputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheCreateTokens: 5,
    });
  });

  it("keeps interleaved main and nested streams correlated with their own response", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_start", message: msg("main", 10, 1).message },
    });
    t.observeStream({
      parent_tool_use_id: "task-1",
      event: { type: "message_start", message: msg("nested", 20, 1).message },
    });
    t.observeStream({
      parent_tool_use_id: "task-1",
      event: { type: "message_delta", usage: { output_tokens: 40 } },
    });
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: 30 } },
    });
    t.observeStream({ parent_tool_use_id: "task-1", event: { type: "message_stop" } });
    t.observeStream({ parent_tool_use_id: null, event: { type: "message_stop" } });
    t.flush();
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.turn === 1)).toMatchObject({ inputTokens: 10, outputTokens: 30 });
    expect(out.find((p) => p.turn === 2)).toMatchObject({ inputTokens: 20, outputTokens: 40 });
  });

  it("preserves interrupted streamed output as unknown when the stream never ends", () => {
    for (const sawDelta of [false, true]) {
      const out: TurnUsagePayload[] = [];
      const t = new TurnUsageTracker((p) => out.push(p));
      t.observeStream({
        parent_tool_use_id: null,
        event: { type: "message_start", message: msg("a", 10, 1).message },
      });
      if (sawDelta)
        t.observeStream({
          parent_tool_use_id: null,
          event: { type: "message_delta", usage: { output_tokens: 50 } },
        });
      t.flush();
      t.flush();
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ inputTokens: 10, outputTokens: null });
    }
  });

  it("does not invent a response from an orphan delta or stop", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    t.observeStream({
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: 50 } },
    });
    t.observeStream({ parent_tool_use_id: null, event: { type: "message_stop" } });
    t.flush();
    expect(out).toEqual([]);
  });

  it("does not label an unfinalized assistant envelope's output as final without a stream", () => {
    const out: TurnUsagePayload[] = [];
    const t = new TurnUsageTracker((p) => out.push(p));
    const m = msg("a", 351, 1);
    m.message.stop_reason = null;
    t.observe(m);
    t.flush();
    expect(out[0]).toMatchObject({ inputTokens: 351, outputTokens: null });
  });
});
