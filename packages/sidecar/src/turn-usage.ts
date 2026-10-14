// One `turn_usage` per model response (M3 context plan, Phase 1). SDK 0.3.278 emits
// content-block assistant envelopes before final message_delta usage. Partial events
// identify the response at message_start; delta/stop complete its measurements.
// Nested streams have their own parent_tool_use_id and may interleave with the main
// stream. Only finalized output is known; an interrupted stream remains null.

import type { TurnUsagePayload } from "@deskmates/contracts";

interface UsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The SDK assistant fields read here; a null stop_reason means a provisional envelope. */
export interface AssistantUsageMessage {
  parent_tool_use_id?: string | null;
  message: {
    id: string;
    model: string;
    usage?: UsageCounts;
    stop_reason?: string | null;
  };
}

/** Subset of the actual SDK partial-message events consumed by runOnce. */
export interface StreamUsageMessage {
  parent_tool_use_id: string | null;
  event:
    | { type: "message_start"; message: AssistantUsageMessage["message"] }
    | { type: "message_delta"; usage: UsageCounts }
    | { type: "message_stop" };
}

interface ResponseUsage {
  parent: string | null;
  streaming: boolean;
  payload: TurnUsagePayload;
}

export class TurnUsageTracker {
  private turn = 0;
  private readonly pending = new Map<string, ResponseUsage>();
  private readonly active = new Map<string | null, string>();
  /** A late content block or duplicate frame never reopens an emitted response. */
  private readonly seen = new Set<string>();

  constructor(private readonly emit: (payload: TurnUsagePayload) => void) {}

  observe(msg: AssistantUsageMessage): void {
    const id = msg.message.id;
    const pending = this.pending.get(id);
    if (pending) {
      // A block's provisional usage must not replace measurements from the stream.
      if (!pending.streaming) pending.payload = payloadOf(msg.message, pending.payload.turn);
      return;
    }
    if (this.seen.has(id)) return;
    this.begin(msg.message, msg.parent_tool_use_id ?? null, false);
  }

  observeStream(msg: StreamUsageMessage): void {
    const parent = msg.parent_tool_use_id;
    const event = msg.event;
    if (event.type === "message_start") {
      if (this.seen.has(event.message.id)) return;
      this.begin(event.message, parent, true);
      return;
    }
    const id = this.active.get(parent);
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (id === undefined || !pending?.streaming) return;
    if (event.type === "message_delta") {
      const usage = event.usage;
      // A missing delta field leaves the earlier measurement intact; explicit null
      // is unknown. Counts are cumulative for this response, never added together.
      if ("input_tokens" in usage) pending.payload.inputTokens = count(usage.input_tokens);
      if ("output_tokens" in usage) pending.payload.outputTokens = count(usage.output_tokens);
      if ("cache_read_input_tokens" in usage)
        pending.payload.cacheReadTokens = count(usage.cache_read_input_tokens);
      if ("cache_creation_input_tokens" in usage)
        pending.payload.cacheCreateTokens = count(usage.cache_creation_input_tokens);
    } else {
      this.finish(id, true);
    }
  }

  /** Flush once at result, compaction or interruption; unfinished output stays unknown. */
  flush(): void {
    for (const id of this.pending.keys()) this.finish(id, false);
  }

  private begin(
    message: AssistantUsageMessage["message"],
    parent: string | null,
    streaming: boolean,
  ): void {
    const previous = this.active.get(parent);
    if (previous !== undefined) this.finish(previous, false);
    const payload = payloadOf(message, ++this.turn);
    if (streaming) payload.outputTokens = null;
    this.seen.add(message.id);
    this.active.set(parent, message.id);
    this.pending.set(message.id, { parent, streaming, payload });
  }

  private finish(id: string, streamEnded: boolean): void {
    const response = this.pending.get(id);
    if (!response) return;
    this.pending.delete(id);
    if (this.active.get(response.parent) === id) this.active.delete(response.parent);
    if (response.streaming && !streamEnded) response.payload.outputTokens = null;
    this.emit(response.payload);
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function payloadOf(message: AssistantUsageMessage["message"], turn: number): TurnUsagePayload {
  const u = message.usage;
  return {
    model: message.model,
    turn,
    inputTokens: count(u?.input_tokens),
    outputTokens: message.stop_reason == null ? null : count(u?.output_tokens),
    cacheReadTokens: count(u?.cache_read_input_tokens),
    cacheCreateTokens: count(u?.cache_creation_input_tokens),
  };
}
