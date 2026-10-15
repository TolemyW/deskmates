// Messages shaped like the Claude SDK's, built from what the OpenAI Agents SDK reports (ADR-0042). The run
// loop (`run-once.ts`) reads `assistant`, `user`, `result` and `system/init` messages; these
// builders fill exactly the fields it and its observers read, with the SDK's own types as the
// target so a field the loop starts reading tomorrow is a type error here, not a silent gap.

import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Per-model totals in the Claude SDK's `modelUsage` shape; cumulative over the session. */
export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * The SDK's message types are large unions of Anthropic API objects; the loop reads a few fields
 * of each. One cast, here, with the shape written out beside the consumer it serves.
 */
function asSdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

const RUNTIME_VERSION_LABEL = "openai-agents";

export function initMessage(opts: {
  sessionId: string;
  model: string;
  cwd: string;
  tools: readonly string[];
  mcpServers: readonly string[];
  sdkVersion: string;
}): SDKMessage {
  return asSdk({
    type: "system",
    subtype: "init",
    uuid: randomUUID(),
    session_id: opts.sessionId,
    apiKeySource: "none",
    // Read by the loop as the CLI build (issue #68); here it names the runtime instead.
    claude_code_version: `${RUNTIME_VERSION_LABEL}@${opts.sdkVersion}`,
    cwd: opts.cwd,
    tools: [...opts.tools],
    mcp_servers: opts.mcpServers.map((name) => ({ name, status: "connected" })),
    model: opts.model,
    permissionMode: "default",
    slash_commands: [],
    agents: [],
  });
}

function assistantEnvelope(
  sessionId: string,
  messageId: string,
  model: string,
  content: Record<string, unknown>[],
): SDKMessage {
  return asSdk({
    type: "assistant",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content,
      // Unknown per-response usage: the turn-usage tracker records null counts for a response
      // whose stop reason it never saw, which is honest (ADR-0042 consequences).
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

export function assistantText(
  sessionId: string,
  messageId: string,
  model: string,
  text: string,
): SDKMessage {
  return assistantEnvelope(sessionId, messageId, model, [{ type: "text", text }]);
}

export function assistantThinking(
  sessionId: string,
  messageId: string,
  model: string,
  thinking: string,
): SDKMessage {
  return assistantEnvelope(sessionId, messageId, model, [
    { type: "thinking", thinking, signature: "" },
  ]);
}

export function assistantToolUse(
  sessionId: string,
  messageId: string,
  model: string,
  call: { id: string; name: string; input: Record<string, unknown> },
): SDKMessage {
  return assistantEnvelope(sessionId, messageId, model, [
    { type: "tool_use", id: call.id, name: call.name, input: call.input },
  ]);
}

export function toolResultMessage(
  sessionId: string,
  result: { toolUseId: string; text: string; isError: boolean },
): SDKMessage {
  return asSdk({
    type: "user",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: result.toolUseId,
          content: result.text,
          is_error: result.isError,
        },
      ],
    },
  });
}

function usageBlock(totals: Readonly<Record<string, ModelUsageTotals>>): Record<string, number> {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const t of Object.values(totals)) {
    input += t.inputTokens;
    output += t.outputTokens;
    cached += t.cacheReadInputTokens;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function modelUsage(totals: Readonly<Record<string, ModelUsageTotals>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [model, t] of Object.entries(totals)) {
    out[model] = {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadInputTokens: t.cacheReadInputTokens,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      // The Gateway prices tokens itself and ignores this (AGENTS.md).
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    };
  }
  return out;
}

export function resultMessage(opts: {
  sessionId: string;
  durationMs: number;
  numTurns: number;
  totals: Readonly<Record<string, ModelUsageTotals>>;
  outcome:
    | { kind: "success"; text: string }
    | { kind: "error_max_turns" | "error_during_execution"; errors: string[] };
}): SDKMessage {
  const base = {
    type: "result",
    uuid: randomUUID(),
    session_id: opts.sessionId,
    duration_ms: opts.durationMs,
    duration_api_ms: 0,
    num_turns: opts.numTurns,
    stop_reason: opts.outcome.kind === "success" ? "end_turn" : null,
    total_cost_usd: 0,
    usage: usageBlock(opts.totals),
    modelUsage: modelUsage(opts.totals),
    permission_denials: [],
  };
  if (opts.outcome.kind === "success") {
    return asSdk({ ...base, subtype: "success", is_error: false, result: opts.outcome.text });
  }
  return asSdk({
    ...base,
    subtype: opts.outcome.kind,
    is_error: true,
    errors: opts.outcome.errors,
  });
}
