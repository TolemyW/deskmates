// Which agent loop a bot's runs use (ADR-0042). A knob like the model: set per bot, defaulted by
// the installation (`DEFAULT_RUNTIME`), frozen on every run row so a paired comparison can pair
// runs by it. The sidecar hosts both; nothing else in the product depends on which one ran.

/** The agent runtimes the sidecar can host, in the order the UI lists them. */
export const AGENT_RUNTIMES = ["claude-agent-sdk", "openai-agents"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

/** Today's loop: the Claude Agent SDK as the sidecar's host process (ADR-0002 decision 1). */
export const DEFAULT_AGENT_RUNTIME: AgentRuntime = "claude-agent-sdk";

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === "string" && (AGENT_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The model-endpoint protocol a runtime speaks to the Gateway's model proxy: the Claude Agent SDK
 * sends Anthropic Messages requests, the OpenAI Agents SDK sends Chat Completions requests. A bot's
 * effective model must be served by an upstream of that protocol (ADR-0042 decision 7).
 */
export function runtimeProtocol(runtime: AgentRuntime): "anthropic" | "openai" {
  return runtime === "openai-agents" ? "openai" : "anthropic";
}
