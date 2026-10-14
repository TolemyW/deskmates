// @deskmates/agent-mcp: an MCP server that lets an external agent use Deskmates as a batch task
// execution and management service over the operator API. The binary is `main.ts`.

export { type AgentMcpConfig, POLL_INTERVAL_MS_DEFAULT, loadConfig } from "./config.js";
export { GatewayClient, GatewayError } from "./gateway-client.js";
export { OPERATIONS, buildOpenApiDocument } from "./openapi.js";
export {
  type AgentMcpServerOptions,
  SERVER_NAME,
  SERVER_VERSION,
  createAgentMcpServer,
} from "./server.js";
export { TEXT_LIMIT_BYTES, TOOLS, type ToolDefinition, WAIT_MAX_SECONDS } from "./tools.js";
