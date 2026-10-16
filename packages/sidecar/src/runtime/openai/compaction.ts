// Context compaction for the OpenAI runtime (ADR-0044, `summary-v1`). The Chat Completions API
// has no server-side compaction, so when the last response reported a prompt above the knob
// (`DESKMATES_OPENAI_MAX_CONTEXT_TOKENS`), the items older than a short tail are rendered as text,
// summarised by the run's own model in one extra call, and replaced by one user message holding
// the summary. The tail keeps the exchange the model is in the middle of. Off unless the knob is
// set, so a run without it is byte-identical to before; a run with it records the value.

import type { AgentInputItem } from "@openai/agents";

/** Items kept verbatim after the summary: the latest exchanges, tool results included. */
export const COMPACTION_KEEP_TAIL = 6;
/** Longest rendering of the compacted history handed to the summariser, in characters. */
export const COMPACTION_RENDER_MAX_CHARS = 60_000;
const ITEM_MAX_CHARS = 2_000;

export const COMPACTION_INSTRUCTION =
  "You are compacting your own conversation so far to continue it with less context. Write a dense summary for yourself: the task and who asked, what has been done and with which tools, file paths and identifiers that matter, decisions taken, what is still open, and anything the human told you to do or not do. Keep facts, drop pleasantries. Plain text, no preamble.";

function clip(text: string, max = ITEM_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((c) =>
      typeof c.text === "string"
        ? c.text
        : c.type === "input_image"
          ? "[image]"
          : typeof c.refusal === "string"
            ? c.refusal
            : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** One item as a line of transcript; unknown items are named, never dropped silently. */
export function renderItem(item: AgentInputItem): string {
  const raw = item as Record<string, unknown>;
  const type = raw.type ?? (typeof raw.role === "string" ? "message" : "item");
  if (type === "message") {
    const role = typeof raw.role === "string" ? raw.role : "message";
    return `${role}: ${clip(contentText(raw.content))}`;
  }
  if (type === "function_call")
    return `tool call ${String(raw.name)} (${String(raw.callId)}): ${clip(String(raw.arguments ?? ""))}`;
  if (type === "function_call_result")
    return `tool result (${String(raw.callId)}): ${clip(contentText(raw.output))}`;
  if (type === "reasoning") return "reasoning: [omitted]";
  return `${String(type)}: [omitted]`;
}

/** The transcript text the summariser reads, oldest first, bounded. */
export function renderHistory(items: readonly AgentInputItem[]): string {
  const lines = items.map(renderItem);
  const text = lines.join("\n\n");
  return text.length <= COMPACTION_RENDER_MAX_CHARS
    ? text
    : `${text.slice(text.length - COMPACTION_RENDER_MAX_CHARS)}`;
}

/** The user message that stands in for the compacted history. */
export function summaryItem(summary: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[Compacted conversation. Everything before this point was summarised as follows.]\n\n${summary}`,
      },
    ],
  };
}

/**
 * Split the history into what is summarised and what stays. The tail never splits a tool call
 * from its result: it grows backwards until it starts on a message, so the model never sees a
 * result whose call it cannot find.
 */
export function splitForCompaction(
  items: readonly AgentInputItem[],
  keepTail = COMPACTION_KEEP_TAIL,
): { head: AgentInputItem[]; tail: AgentInputItem[] } {
  if (items.length <= keepTail) return { head: [], tail: [...items] };
  let cut = items.length - keepTail;
  while (cut > 0) {
    const item = items[cut] as Record<string, unknown>;
    // A result without its call must not start the tail; the call itself may.
    if (item.type === "function_call_result") cut -= 1;
    else break;
  }
  return { head: items.slice(0, cut), tail: items.slice(cut) };
}
