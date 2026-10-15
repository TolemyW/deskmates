// The five integration tools (ADR-0013 item 5), hosted on the in-process `deskmates` MCP server.
// They are offered only when the start request says the workspace has at least one integration
// connection and the run's tool list includes them.
//
// The sidecar never learns where the integration runtime is or how to authenticate to it; every
// call goes to the Gateway's run routes with the run token, and the Gateway applies the workspace
// boundary. Results enter model context wrapped as untrusted external output. The raw result is in
// the ledger as the Gateway's own `tool_result` event for the call (`source: "integration_proxy"`).
// `integration_execute` is tiered by the PreToolUse hook from the catalog, not here.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import {
  type IntegrationToolName,
  integrationServiceOf,
  isDeskmatesError,
} from "@deskmates/contracts";
import { z } from "zod";
import { deskmatesToolName } from "./risk-tier.js";
import type { ThreadToolsContext } from "./thread-tools.js";
import { wrapIntegrationContent } from "./untrusted.js";
import { valueForModel } from "./vision-withhold.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function integrationTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  if ((ctx.request.integrationConnections ?? 0) <= 0) return [];
  const offered = (name: IntegrationToolName) => ctx.request.tools.includes(name);

  const answer = (source: string, value: unknown, isError = false): ToolResult => ({
    content: [{ type: "text", text: wrapIntegrationContent(source, JSON.stringify(value)) }],
    ...(isError ? { isError: true } : {}),
  });
  const refused = (source: string, tool: string, err: unknown): ToolResult => {
    const body = isDeskmatesError(err)
      ? { code: err.code, message: err.message, details: err.details }
      : { code: "unavailable", message: "the Gateway could not be reached" };
    return {
      content: [
        {
          type: "text",
          text: `${tool} was refused.\n${wrapIntegrationContent(source, JSON.stringify(body))}`,
        },
      ],
      isError: true,
    };
  };
  const run = async (
    source: string,
    tool: string,
    call: () => Promise<unknown>,
    failed: (value: unknown) => boolean = () => false,
  ): Promise<ToolResult> => {
    try {
      const value = await call();
      return answer(
        source,
        valueForModel(ctx.request, ctx.sink, deskmatesToolName(tool), value),
        failed(value),
      );
    } catch (err) {
      return refused(source, tool, err);
    }
  };
  const sourceOf = (actionId: string) => integrationServiceOf(actionId) ?? "unknown";

  // biome-ignore lint/suspicious/noExplicitAny: matches the SDK's CreateSdkMcpServerOptions.tools
  const tools: SdkMcpToolDefinition<any>[] = [];
  if (offered("integration_apps"))
    tools.push(
      ctx.tool(
        "integration_apps",
        "List the SaaS apps this workspace may use and its connection names for each.",
        {},
        async () => run("apps", "integration_apps", () => ctx.client.integrationApps()),
      ),
    );
  if (offered("integration_connections"))
    tools.push(
      ctx.tool(
        "integration_connections",
        "List this workspace's connected accounts, optionally for one service, with the connection names to pass to the other integration tools.",
        { service: z.string().min(1).optional() },
        async (args) =>
          run(args.service ?? "connections", "integration_connections", () =>
            ctx.client.integrationConnections(args.service),
          ),
      ),
    );
  if (offered("integration_search"))
    tools.push(
      ctx.tool(
        "integration_search",
        "Find actions of one service by keyword. Returns at most 5 actions with actionId, description, operationType (read, write or destructive) and inputs.",
        {
          service: z.string().min(1),
          query: z.string().optional(),
          limit: z.number().int().min(1).max(5).optional(),
        },
        async (args) =>
          run(args.service, "integration_search", () =>
            ctx.client.integrationSearch({
              service: args.service,
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            }),
          ),
      ),
    );
  if (offered("integration_guide"))
    tools.push(
      ctx.tool(
        "integration_guide",
        "Read how to call one action: its inputs, required scopes and notes. actionId is <service>.<name> from integration_search.",
        { actionId: z.string().min(1), connectionName: z.string().min(1).optional() },
        async (args) =>
          run(sourceOf(args.actionId), "integration_guide", () =>
            ctx.client.integrationGuide({
              actionId: args.actionId,
              ...(args.connectionName === undefined ? {} : { connectionName: args.connectionName }),
            }),
          ),
      ),
    );
  if (offered("integration_execute"))
    tools.push(
      ctx.tool(
        "integration_execute",
        "Run one action on a connected account. Name the connection when the workspace has more than one for the service. A write or destructive action waits for approval.",
        {
          actionId: z.string().min(1),
          connectionName: z.string().min(1).optional(),
          // Not `z.record`: SDK 0.3.278's JSON Schema conversion throws on it, and the CLI then
          // drops the whole `deskmates` server (found by the integrations T2).
          input: z.object({}).catchall(z.unknown()).optional(),
        },
        async (args) =>
          run(
            sourceOf(args.actionId),
            "integration_execute",
            () =>
              ctx.client.integrationExecute({
                actionId: args.actionId,
                ...(args.connectionName === undefined
                  ? {}
                  : { connectionName: args.connectionName }),
                input: args.input ?? {},
              }),
            (value) => (value as { ok?: unknown }).ok === false,
          ),
      ),
    );
  return tools;
}
