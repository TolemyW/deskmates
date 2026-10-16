// T0: the model wrapper (ADR-0044): images a tool returned reach the model as a user message
// after the tool's result, and a history over the compaction knob is summarised by the same
// model and replaced before the turn is sent.

import type { AgentInputItem, Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Usage } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { COMPACTION_KEEP_TAIL, renderHistory, splitForCompaction } from "./compaction.js";
import { wrapModel } from "./model-wrapper.js";

function user(text: string): AgentInputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function call(callId: string, name = "Read"): AgentInputItem {
  return { type: "function_call", callId, name, arguments: "{}", status: "completed" };
}

function result(callId: string, output = "ok"): AgentInputItem {
  return { type: "function_call_result", callId, name: "Read", output, status: "completed" };
}

function assistant(text: string): AgentInputItem {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

/** A model that records what it was asked and answers a fixed text. */
function fakeModel(answer = "SUMMARY") {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request): Promise<ModelResponse> {
      requests.push(request);
      return {
        usage: new Usage({ requests: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
        output: [assistant(answer) as never],
        responseId: "r1",
      };
    },
    async *getStreamedResponse(request) {
      requests.push(request);
      yield { type: "response_started" };
    },
  };
  return { model, requests };
}

const baseRequest = (input: AgentInputItem[]): ModelRequest => ({
  systemInstructions: "be brief",
  input,
  modelSettings: {},
  tools: [],
  outputType: "text",
  handoffs: [],
  tracing: false,
});

describe("model wrapper: images", () => {
  it("adds a user message with the image after the tool result that produced it", async () => {
    const { model, requests } = fakeModel();
    const images = new Map([["c1", { mediaType: "image/png", base64: "AAAA" }]]);
    const wrapped = wrapModel(model, {
      images,
      lastPromptTokens: () => undefined,
      maxContextTokens: undefined,
      onCompacted: async () => {},
    });
    await wrapped.getResponse(
      baseRequest([
        user("look"),
        call("c1"),
        result("c1", "[image 1 attached]"),
        call("c2"),
        result("c2"),
      ]),
    );
    const sent = requests[0]?.input as Record<string, unknown>[];
    expect(sent.map((i) => i.type ?? i.role)).toEqual([
      "message",
      "function_call",
      "function_call_result",
      "message",
      "function_call",
      "function_call_result",
    ]);
    const injected = sent[3] as { role: string; content: { type: string; image?: string }[] };
    expect(injected.role).toBe("user");
    expect(injected.content[1]).toEqual({
      type: "input_image",
      image: "data:image/png;base64,AAAA",
    });
  });
});

describe("model wrapper: compaction", () => {
  const history = [
    user("task"),
    assistant("plan"),
    call("c1"),
    result("c1"),
    assistant("step 2"),
    call("c2"),
    result("c2"),
    assistant("step 3"),
    user("more"),
    assistant("ok"),
  ];

  it("does nothing under the knob or when the knob is off", async () => {
    const { model, requests } = fakeModel();
    const wrapped = wrapModel(model, {
      images: new Map(),
      lastPromptTokens: () => 500,
      maxContextTokens: undefined,
      onCompacted: async () => {
        throw new Error("must not compact");
      },
    });
    await wrapped.getResponse(baseRequest(history));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toHaveLength(history.length);
  });

  it("summarises the head with the same model, keeps the tail and reports the boundary", async () => {
    const { model, requests } = fakeModel("THE SUMMARY");
    const compacted: unknown[] = [];
    const wrapped = wrapModel(model, {
      images: new Map(),
      lastPromptTokens: () => 900,
      maxContextTokens: 800,
      onCompacted: async (event) => {
        compacted.push(event);
      },
    });
    await wrapped.getResponse(baseRequest(history));
    // One summary call (no tools), then the real turn with the summary in front of the tail.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.systemInstructions).toBeUndefined();
    const summaryPrompt = (requests[0]?.input as { content: { text: string }[] }[])[0]?.content[0]
      ?.text;
    expect(summaryPrompt).toContain("tool call Read (c1)");
    const sent = requests[1]?.input as Record<string, unknown>[];
    expect(sent).toHaveLength(1 + COMPACTION_KEEP_TAIL);
    expect(JSON.stringify(sent[0])).toContain("THE SUMMARY");
    expect(compacted[0]).toMatchObject({ preTokens: 900, summary: "THE SUMMARY" });
  });

  it("never cuts a tool call from its result", () => {
    const { head, tail } = splitForCompaction(history, 3);
    expect(
      tail.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role: string }).role),
    ).toEqual(["message", "message", "message"]);
    expect(head).toHaveLength(7);
    const cutInsideCall = splitForCompaction(
      [user("a"), call("c1"), result("c1"), assistant("b")],
      2,
    );
    expect(cutInsideCall.head).toHaveLength(1);
    expect(renderHistory(cutInsideCall.head)).toBe("user: a");
  });
});
