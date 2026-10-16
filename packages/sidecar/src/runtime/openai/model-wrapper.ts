// A `Model` in front of the provider's model (ADR-0042): the one place the runtime can see and
// change what the Agents SDK is about to send. Two things happen here, both before the request
// leaves the process:
//
// - Images a tool returned reach the model. Chat Completions tool messages are text only, so the
//   image of a tool call is carried as a user message right after that call's result, as an
//   `input_image` data URL. The images live in this process only; the session file keeps the
//   text, as a screenshot is evidence of the moment, not of the thread.
// - Compaction (`compaction.ts`): when the last response's prompt was over the knob, the older
//   items are summarised by the same model and replaced before the turn is sent. The caller is
//   told, so it can archive the history, rewrite the session and report the boundary.

import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import { renderHistory, splitForCompaction, summaryItem } from "./compaction.js";
import type { ToolImage } from "./types.js";

export interface ModelWrapperHooks {
  /** Images by tool call id, consumed when a request carries that call's result. */
  images: Map<string, ToolImage>;
  /** Prompt tokens the last response reported (cached part included); undefined before any. */
  lastPromptTokens: () => number | undefined;
  /** The compaction threshold; undefined means compaction is off. */
  maxContextTokens: number | undefined;
  /** Called with the replacement history after a compaction, before the turn is sent. */
  onCompacted: (event: {
    preTokens: number;
    head: AgentInputItem[];
    tail: AgentInputItem[];
    summary: string;
    items: AgentInputItem[];
  }) => Promise<void>;
}

function imageMessages(
  items: readonly AgentInputItem[],
  images: Map<string, ToolImage>,
): AgentInputItem[] {
  const out: AgentInputItem[] = [];
  for (const item of items) {
    out.push(item);
    const raw = item as { type?: unknown; callId?: unknown };
    if (raw.type !== "function_call_result" || typeof raw.callId !== "string") continue;
    const image = images.get(raw.callId);
    if (image === undefined) continue;
    out.push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `Image returned by tool call ${raw.callId}:` },
        { type: "input_image", image: `data:${image.mediaType};base64,${image.base64}` },
      ],
    });
  }
  return out;
}

/** The compaction summary, one call to the same model with no tools. */
async function summarise(
  inner: Model,
  request: ModelRequest,
  head: AgentInputItem[],
): Promise<string> {
  const { systemInstructions: _system, previousResponseId: _previous, ...rest } = request;
  const response = await inner.getResponse({
    ...rest,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${renderHistory(head)}\n\n---\n\nInstructions: ${request.systemInstructions ? "(the standing instructions are unchanged and not repeated here) " : ""}summarise the conversation above for yourself.`,
          },
        ],
      },
    ],
    tools: [],
    handoffs: [],
    outputType: "text",
    modelSettings: { ...request.modelSettings, toolChoice: "none" },
  });
  return response.output
    .flatMap((item) => {
      const raw = item as { type?: unknown; content?: unknown };
      if (raw.type !== "message" || !Array.isArray(raw.content)) return [];
      return (raw.content as { type?: unknown; text?: unknown }[])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string);
    })
    .join("")
    .trim();
}

export function wrapModel(inner: Model, hooks: ModelWrapperHooks): Model {
  async function prepare(request: ModelRequest): Promise<ModelRequest> {
    let input = request.input;
    const last = hooks.lastPromptTokens();
    if (
      Array.isArray(input) &&
      hooks.maxContextTokens !== undefined &&
      last !== undefined &&
      last > hooks.maxContextTokens
    ) {
      const { head, tail } = splitForCompaction(input);
      if (head.length > 0) {
        const summary = await summarise(inner, request, head);
        const items = [summaryItem(summary), ...tail];
        await hooks.onCompacted({ preTokens: last, head, tail, summary, items });
        input = items;
      }
    }
    if (Array.isArray(input) && hooks.images.size > 0) input = imageMessages(input, hooks.images);
    return { ...request, input };
  }
  return {
    ...(inner.supportsPromptModelSelection === undefined
      ? {}
      : { supportsPromptModelSelection: inner.supportsPromptModelSelection }),
    getResponse: async (request: ModelRequest): Promise<ModelResponse> =>
      inner.getResponse(await prepare(request)),
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      const prepared = await prepare(request);
      yield* inner.getStreamedResponse(prepared);
    },
    ...(inner.getRetryAdvice ? { getRetryAdvice: inner.getRetryAdvice.bind(inner) } : {}),
  };
}

/** The model wrapper for tests: `prepare` without a model, image injection only. */
export const _internal = { imageMessages };
