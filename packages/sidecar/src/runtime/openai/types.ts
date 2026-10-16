// The OpenAI Agents SDK runtime as `runOnce` calls it (ADR-0042): the same prompt and `Options`
// the Claude path builds (system prompt, model, turn cap, MCP servers, the PreToolUse hook, the
// session to resume) plus what the Claude SDK would have read from its process environment. It
// yields messages shaped like the Claude SDK's, so the run loop's ledger, approvals, taint and
// handoff handling do not know which runtime ran.

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface OpenAiQueryParams {
  prompt: string;
  options: Options;
  /** The Gateway's model proxy; the runtime posts Chat Completions to `<modelBaseUrl>/v1`. */
  modelBaseUrl: string;
  /** The run's short-lived token, sent as the API key; the proxy swaps it for the upstream's. */
  modelAuthToken: string;
  /** Where the file session and a parked run's state live (`~/.deskmates/openai-sessions`). */
  botHomeDir: string;
  botName: string;
  runId: string;
  /** The directory file and shell tools resolve relative paths against. */
  cwd: string;
  /**
   * The run's skill set (ADR-0015), materialised under `dir` as `skills/<name>/SKILL.md`; the
   * `Skill` tool reads one through `readFile`, which is the sidecar's own filesystem.
   */
  skills?: { dir: string; names: readonly string[]; readFile: (path: string) => Promise<string> };
  /** Compaction threshold in prompt tokens (`DESKMATES_OPENAI_MAX_CONTEXT_TOKENS`); absent: off. */
  maxContextTokens?: number;
}

export type OpenAiQueryFn = (params: OpenAiQueryParams) => AsyncIterable<SDKMessage>;

/** An image a tool returned, carried to the model as a user message (model-wrapper.ts). */
export interface ToolImage {
  mediaType: string;
  base64: string;
}

/** What a tool call does to the model's view of it, after the gate has judged it. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
  images?: ToolImage[];
}

/** A tool the runtime offers: name and schema as the model sees them, and how it runs. */
export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON schema of type `object`. */
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
}

/** One tool-free Chat Completions turn (model jobs, presentation summaries). */
export interface OpenAiCompletionParams {
  modelBaseUrl: string;
  modelAuthToken: string;
  model: string;
  systemPrompt: string;
  content: (
    | { type: "text"; text: string }
    | { type: "image"; mediaType: string; base64: string }
  )[];
  maxOutputTokens: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface OpenAiCompletionResult {
  text: string;
  /** The model the response named, for the ledger. */
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
}

export type OpenAiCompletionFn = (
  params: OpenAiCompletionParams,
) => Promise<OpenAiCompletionResult>;
