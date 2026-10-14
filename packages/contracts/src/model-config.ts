// The model ids the Gateway is configured with, as the UI sees them.

/**
 * The read-only view of `DEFAULT_MODEL` / `CHEAP_MODEL` that the UI offers as choices, so an
 * operator picks a bot's model from what the deployment actually has rather than typing a name
 * (AGENTS.md: "The model is configuration").
 *
 * Nothing else may be added to this interface: no `modelBaseUrl`, no auth token, nothing
 * token-shaped. The route that serves it is the only path from Gateway configuration to the
 * browser, and the rest of that configuration is either an upstream address or a secret.
 */
export interface ModelConfig {
  defaultModel: string;
  cheapModel: string;
}
