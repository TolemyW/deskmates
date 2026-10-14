// The MCP server: lists the tools and runs a call against the Gateway. Uses the SDK's low-level
// `Server` because the tool input schemas are plain JSON Schema shared with the OpenAPI document,
// not zod. A Gateway refusal becomes a tool error (`isError`) carrying the DeskmatesError code and
// message; nothing that leaves here contains the credential.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentMcpConfig } from "./config.js";
import { GatewayClient, GatewayError } from "./gateway-client.js";
import { TOOLS, type ToolContext, ToolInputError } from "./tools.js";

export const SERVER_NAME = "deskmates-agent-mcp";
export const SERVER_VERSION = "0.1.0";

export type Log = (line: string) => void;

export interface AgentMcpServerOptions {
  config: AgentMcpConfig;
  /** Diagnostics; stdout is the protocol, so main.ts writes these to stderr. */
  log?: Log;
  fetch?: typeof fetch;
}

interface ToolErrorBody {
  code: string;
  /** HTTP status from the Gateway; absent for an argument error caught before any request. */
  status?: number;
  message: string;
  hint?: string;
}

const HINTS: Readonly<Record<string, string>> = {
  budget_exceeded:
    "Budget exceeded: this service principal's budget (concurrent runs or today's known cost) is spent. Wait for runs to finish, or retry later.",
  rate_limited: "Rate limited: the tenant's request budget is spent for now; retry later.",
  queue_full: "Queue full: the tenant has too many queued runs; retry later.",
  token_rejected:
    "The Gateway rejected the credential: check DESKMATES_TOKEN (disabled or rotated service principal?).",
  gateway_unreachable: "The Gateway could not be reached: check DESKMATES_URL and the network.",
};

function errorBody(err: unknown, redact: (text: string) => string): ToolErrorBody {
  if (err instanceof GatewayError) {
    const hint =
      HINTS[err.code] ??
      (err.status === 429
        ? "The Gateway is limiting requests (HTTP 429); retry later."
        : undefined);
    return {
      code: err.code,
      ...(err.status > 0 ? { status: err.status } : {}),
      message: redact(err.message),
      ...(hint ? { hint } : {}),
    };
  }
  if (err instanceof ToolInputError) return { code: "validation", message: redact(err.message) };
  const message = err instanceof Error ? err.message : String(err);
  return { code: "internal", message: redact(message) };
}

export function createAgentMcpServer(options: AgentMcpServerOptions): Server {
  const { config } = options;
  const log: Log = options.log ?? (() => {});
  const client = new GatewayClient({
    baseUrl: config.gatewayUrl,
    token: config.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Deskmates runs work on bots that share a sandboxed computer. Batch pattern: one submit per unit of work with your own externalKey (idempotent), then wait_task until it is delivered or its runs end; fetch results with get_task and download_artifact. Task acceptance is human-only. Pace with get_capacity: each bot runs one run per lane, and a workspace has one browser.",
    },
  );
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const tool = byName.get(name);
    const progressToken = request.params._meta?.progressToken;
    const ctx: ToolContext = {
      client,
      defaultWorkspaceId: config.defaultWorkspaceId,
      pollIntervalMs: config.pollIntervalMs,
      ...(progressToken !== undefined
        ? {
            progress: async (progress: number, total: number, message: string) => {
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, total, message },
              });
            },
          }
        : {}),
    };
    try {
      if (!tool) throw new ToolInputError(`unknown tool ${name}`);
      const result = await tool.run(args, ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      const error = errorBody(err, (text) => client.redact(text));
      log(
        client.redact(
          `${SERVER_NAME}: ${name} failed: ${error.code}${error.status ? ` (HTTP ${error.status})` : ""}: ${error.message}`,
        ),
      );
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error }, null, 2) }],
      };
    }
  });

  return server;
}
