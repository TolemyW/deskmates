// Structural mirrors of the `@anthropic-ai/claude-agent-sdk@0.3.278` shapes the fake emits and
// consumes. testkit must not import the SDK (only the sidecar may), so these are copied by hand
// from `sdk.d.ts` and from `@anthropic-ai/sdk` beta message types. The sidecar's T2 test
// `sdk-shape.container.test.ts` asserts, at compile time, that every exported message type here
// is assignable to the real SDK type, and that the real `Options` is assignable to
// `SdkQueryOptions`. Drift after an SDK upgrade shows up there first.
//
// Direction of the mirrors, so the fake plugs into code typed against the real SDK without casts:
//   - messages the fake EMITS are complete: assignable TO the real `SDKMessage` members;
//   - options the fake ACCEPTS are wide: the real `Options` is assignable TO them.

/** `UUID` from node:crypto. */
export type SdkUuid = `${string}-${string}-${string}-${string}-${string}`;

// ---- Assistant message content (BetaContentBlock subset the fake produces) ----

export interface SdkTextBlock {
  type: "text";
  text: string;
  citations: null;
}

export interface SdkThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface SdkToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type SdkContentBlock = SdkTextBlock | SdkThinkingBlock | SdkToolUseBlock;

/** `BetaUsage` with every field present and non-null (= the SDK's `NonNullableUsage`). */
export interface SdkApiUsage {
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  fallback_credit: { status: { type: "redeemed" } };
  inference_geo: string;
  input_tokens: number;
  iterations: never[];
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number };
  server_tool_use: { web_fetch_requests: number; web_search_requests: number };
  service_tier: "standard";
  speed: "standard";
}

/** `BetaMessage` as carried by `SDKAssistantMessage.message`. */
export interface SdkApiMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: SdkContentBlock[];
  stop_reason: "end_turn" | "tool_use" | null;
  stop_sequence: null;
  stop_details: null;
  container: null;
  context_management: null;
  diagnostics: null;
  usage: SdkApiUsage;
}

// ---- SDK message envelopes ----

export interface SdkSystemInitMessage {
  type: "system";
  subtype: "init";
  apiKeySource: "none";
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: "default";
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  uuid: SdkUuid;
  session_id: string;
}

export interface SdkAssistantMessage {
  type: "assistant";
  message: SdkApiMessage;
  parent_tool_use_id: null;
  uuid: SdkUuid;
  session_id: string;
}

export interface SdkToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Tool results come back to the model as a user message (`SDKUserMessage`). */
export interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: SdkToolResultBlockParam[] };
  parent_tool_use_id: null;
  uuid: SdkUuid;
  session_id: string;
}

export interface SdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  costBasis: "unknown";
}

/** The call the PreToolUse hook deferred; the real SDK reports it on the success result. */
export interface SdkDeferredToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SdkResultSuccessMessage {
  type: "result";
  subtype: "success";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: SdkApiUsage;
  modelUsage: Record<string, SdkModelUsage>;
  permission_denials: {
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }[];
  deferred_tool_use?: SdkDeferredToolUse;
  uuid: SdkUuid;
  session_id: string;
}

export interface SdkResultErrorMessage {
  type: "result";
  subtype: "error_during_execution" | "error_max_turns";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: SdkApiUsage;
  modelUsage: Record<string, SdkModelUsage>;
  permission_denials: {
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }[];
  errors: string[];
  uuid: SdkUuid;
  session_id: string;
}

export type SdkResultMessage = SdkResultSuccessMessage | SdkResultErrorMessage;

/** `SDKCompactBoundaryMessage`: the CLI compacted the conversation. */
export interface SdkCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens?: number;
  };
  uuid: SdkUuid;
  session_id: string;
}

/**
 * The subset of `SDKAssistantMessageError` the fake reports on an `api_retry`: the error classes
 * of the retryable failures it models (429, 529, 5xx and a connection error).
 */
export type SdkApiRetryError = "rate_limit" | "overloaded" | "server_error" | "unknown";

/**
 * `SDKAPIRetryMessage`: a request failed with a retryable error and the SDK will retry it after
 * `retry_delay_ms`. `error_status` is null for a connection error that had no HTTP response.
 */
export interface SdkApiRetryMessage {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: SdkApiRetryError;
  uuid: SdkUuid;
  session_id: string;
}

/**
 * The `system` / `model_fallback` message SDK 0.3.278 emits when an overloaded primary makes it
 * switch to `fallbackModel` (observed by `acceptance/m4-model-selection.container.test.ts`). The
 * SDK's `SDKMessage` union does not declare it, so it is not in `SdkMessage` either: the fake
 * delivers it through the typed stream exactly as the real SDK does.
 */
export interface SdkModelFallbackMessage {
  type: "system";
  subtype: "model_fallback";
  trigger: string;
  original_model: string;
  fallback_model: string;
  content: string;
  uuid: SdkUuid;
  session_id: string;
}

/**
 * `SDKPartialAssistantMessage` carrying one `content_block_delta` text delta (the Messages API
 * `BetaRawContentBlockDeltaEvent`). The real SDK emits these only with `includePartialMessages`,
 * before the complete assistant message that follows (ADR-0037).
 */
export interface SdkTextDeltaStreamMessage {
  type: "stream_event";
  event: {
    type: "content_block_delta";
    index: number;
    delta: { type: "text_delta"; text: string };
  };
  parent_tool_use_id: null;
  uuid: SdkUuid;
  session_id: string;
}

export type SdkMessage =
  | SdkSystemInitMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | SdkCompactBoundaryMessage
  | SdkApiRetryMessage
  | SdkTextDeltaStreamMessage;

// ---- Hook and permission callback shapes (what the fake CALLS) ----

/** `PreToolUseHookInput`: `BaseHookInput & { hook_event_name: "PreToolUse", ... }`. */
export interface SdkPreToolUseHookInput {
  hook_event_name: "PreToolUse";
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  /** Present only when the hook fires from within a subagent. */
  agent_id?: string;
  /** The subagent's type (`general-purpose`, `Explore`, ...); present alongside `agent_id`. */
  agent_type?: string;
}

export type SdkHookPermissionDecision = "allow" | "deny" | "ask" | "defer";

/**
 * Wide mirror of `HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput`. Only the
 * PreToolUse-specific fields the fake acts on are named; everything else is accepted.
 */
export interface SdkHookOutput {
  async?: boolean;
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: SdkHookPermissionDecision;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export type SdkHookCallback = (
  input: SdkPreToolUseHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SdkHookOutput>;

export interface SdkHookMatcher {
  matcher?: string;
  hooks: SdkHookCallback[];
  /** Seconds. The CLI cancels a hook that runs past it; the call then has no decision from it. */
  timeout?: number;
}

/** `PreCompactHookInput`: `BaseHookInput & { hook_event_name: "PreCompact", ... }`. */
export interface SdkPreCompactHookInput {
  hook_event_name: "PreCompact";
  session_id: string;
  transcript_path: string;
  cwd: string;
  trigger: "manual" | "auto";
  custom_instructions: string | null;
}

export type SdkPreCompactHookCallback = (
  input: SdkPreCompactHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SdkHookOutput>;

export interface SdkPreCompactHookMatcher {
  matcher?: string;
  hooks: SdkPreCompactHookCallback[];
  timeout?: number;
}

/** What asked for a model switch (`PostModelSwitchHookInput.source`). */
export type SdkModelSwitchSource = "command" | "picker" | "sdk" | "auto" | "resume";

/** `PostModelSwitchHookInput`: `BaseHookInput & { hook_event_name: "PostModelSwitch", ... }`. */
export interface SdkPostModelSwitchHookInput {
  hook_event_name: "PostModelSwitch";
  session_id: string;
  transcript_path: string;
  cwd: string;
  from_model: string;
  to_model: string;
  requested_model: string | null;
  source: SdkModelSwitchSource;
  context_tokens: number;
  prompt_cache_warm: boolean;
  cache_ttl: "5m" | "1h";
  estimated_cache_write_usd: number;
  pricing: "configured" | "catalog" | "default";
}

export type SdkPostModelSwitchHookCallback = (
  input: SdkPostModelSwitchHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SdkHookOutput>;

export interface SdkPostModelSwitchHookMatcher {
  matcher?: string;
  hooks: SdkPostModelSwitchHookCallback[];
  timeout?: number;
}

/** The hook events the fake runs; the real `Options.hooks` (every event) is assignable to it. */
export interface SdkHooks {
  PreToolUse?: SdkHookMatcher[];
  PreCompact?: SdkPreCompactHookMatcher[];
  PostModelSwitch?: SdkPostModelSwitchHookMatcher[];
}

export interface SdkCanUseToolOptions {
  signal: AbortSignal;
  toolUseID: string;
  requestId: string;
}

export type SdkPermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: SdkCanUseToolOptions,
) => Promise<SdkPermissionResult | null>;

// ---- In-process MCP tools (`tool()` / `createSdkMcpServer()`) ----

/** Same mapping as the SDK's `InferShape`; works on anything zod-like that exposes `_output`. */
export type SdkInferShape<T> = {
  [K in keyof T]: T[K] extends { _output: infer O } ? O : never;
};

/** The text-only subset of MCP's `CallToolResult` that the fake reads back. */
export interface SdkCallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * `SdkMcpToolDefinition`. The handler's result type is a parameter so that a definition built by
 * the fake's `tool()` from a real-SDK-typed handler (returning MCP's full `CallToolResult`) keeps
 * that type and stays assignable to the real definition.
 */
export interface SdkToolDefinition<Schema, Result = SdkCallToolResult> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: SdkInferShape<Schema>, extra: unknown) => Promise<Result>;
}

/** What `createSdkMcpServer` accepts; wide enough for the real `SdkMcpToolDefinition<any>`. */
export interface SdkToolDefinitionLoose {
  name: string;
  description: string;
  handler: (args: never, extra: unknown) => Promise<unknown>;
}

export interface SdkMcpServerOptions {
  name: string;
  version?: string;
  instructions?: string;
  tools?: SdkToolDefinitionLoose[];
}

/**
 * Return shape of `createSdkMcpServer`. The real `instance` is an `McpServer` from
 * `@modelcontextprotocol/sdk`, which testkit must not depend on; the fake stores its own registry
 * object there and looks it up by identity. It is typed `never` so the config is assignable
 * wherever the real SDK expects `McpSdkServerConfigWithInstance`; callers never touch it.
 */
export interface SdkMcpServerConfigWithInstance {
  type: "sdk";
  name: string;
  instance: never;
}

/** Wide mirror of `McpServerConfig` (stdio | sse | http | sdk). */
export interface SdkMcpServerConfig {
  type?: string;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  instance?: unknown;
}

// ---- query() options (wide: the real `Options` is assignable to this) ----

export interface SdkQueryOptions {
  abortController?: AbortController;
  /** Auto-allowed without prompting; does not restrict tool availability. */
  allowedTools?: string[];
  /** Built-in tool availability; MCP tools are configured separately. */
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  canUseTool?: SdkCanUseTool;
  cwd?: string;
  /** Removed from the model's tool list; a call to one never reaches the hook. */
  disallowedTools?: string[];
  /** SDK `EffortLevel`; absent means the SDK's own default (sdk.d.ts, `Options.effort`). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  env?: { [envVar: string]: string | undefined };
  /**
   * SDK `Options.fallbackModel`: model(s), comma-separated, the SDK switches to when the primary
   * is overloaded or unavailable. A `model_switch` step with no `to` switches to the first.
   */
  fallbackModel?: string;
  hooks?: SdkHooks;
  /** Stream events precede each assistant message of a `streamed_text` step only when set. */
  includePartialMessages?: boolean;
  maxTurns?: number;
  mcpServers?: Record<string, SdkMcpServerConfig>;
  model?: string;
  /** SDK `SdkPluginConfig[]`; only local plugins exist in 0.3.278 (ADR-0015 decision 1). */
  plugins?: { type: "local"; path: string; skipMcpDiscovery?: boolean }[];
  resume?: string;
  settingSources?: string[];
  /** Skills enabled for the session: exactly these names, or every discovered one. */
  skills?: string[] | "all";
  systemPrompt?: unknown;
  /** SDK `ThinkingConfig` (sdk.d.ts, `Options.thinking`); absent means the SDK's own default. */
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
    | { type: "disabled" };
}

export interface SdkQueryParams {
  prompt: string | AsyncIterable<unknown>;
  options?: SdkQueryOptions;
}
