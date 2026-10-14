// The five connector tools (ADR-0012 item 3), hosted on the in-process `deskmates` MCP server. They
// are offered only when the run's tool list includes them and the bot's `connectors` list names at
// least one connector, and they accept only those names. The list is a prompt-level choice, not
// access control: any bot of the workspace may name any of its connectors.
//
// The sidecar never learns where a connector is or how to authenticate to it; every call goes to
// the Gateway's run routes with the run token. Results enter model context wrapped as untrusted
// external output. The raw result is in the ledger as the Gateway's own `tool_result` event for
// the call (`source: "connector_proxy"`), written by the only process that saw it unwrapped.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { type ConnectorToolName, isDeskmatesError } from "@deskmates/contracts";
import { z } from "zod";
import type { ThreadToolsContext } from "./thread-tools.js";
import { wrapConnectorContent } from "./untrusted.js";

// biome-ignore lint/suspicious/noExplicitAny: the SDK erases schema generics in its tool registry
export function connectorTools(ctx: ThreadToolsContext): SdkMcpToolDefinition<any>[] {
  const names = [...ctx.request.connectors];
  const [first, ...rest] = names;
  if (first === undefined) return [];
  const connector = z.enum([first, ...rest]);
  const offered = (name: ConnectorToolName) => ctx.request.tools.includes(name);

  const ok = (name: string, value: unknown) => ({
    content: [{ type: "text" as const, text: wrapConnectorContent(name, JSON.stringify(value)) }],
  });
  const refused = (name: string, op: string, err: unknown) => {
    const body = isDeskmatesError(err)
      ? { code: err.code, message: err.message, details: err.details }
      : { code: "unavailable", message: "the Gateway could not be reached" };
    return {
      content: [
        {
          type: "text" as const,
          text: `connector_${op} on ${name} was refused.\n${wrapConnectorContent(name, JSON.stringify(body))}`,
        },
      ],
      isError: true,
    };
  };
  const run = async (name: string, op: string, call: () => Promise<unknown>) => {
    // Belt and braces: the schema already limits `connector` to the bot's list.
    if (!names.includes(name)) return refused(name, op, new Error("not in this bot's list"));
    try {
      return ok(name, await call());
    } catch (err) {
      return refused(name, op, err);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: matches the SDK's CreateSdkMcpServerOptions.tools
  const tools: SdkMcpToolDefinition<any>[] = [];
  if (offered("connector_describe"))
    tools.push(
      ctx.tool(
        "connector_describe",
        "Describe a connector: its operations and their effect class, limits, submission schema and what it does not support.",
        { connector },
        async (args) =>
          run(args.connector, "describe", () => ctx.client.connectorDescribe(args.connector)),
      ),
    );
  if (offered("connector_validate"))
    tools.push(
      ctx.tool(
        "connector_validate",
        "Dry-check a submission on a connector. Nothing is executed. Returns validationId, contentHash, effect, a summary and field-specific errors. Submit only a valid validation, unchanged.",
        { connector, submission: z.unknown() },
        async (args) =>
          run(args.connector, "validate", () =>
            ctx.client.connectorValidate(args.connector, args.submission),
          ),
      ),
    );
  if (offered("connector_submit"))
    tools.push(
      ctx.tool(
        "connector_submit",
        "Execute a previously validated submission. Pass the validationId and contentHash from connector_validate. Repeating the same idempotencyKey returns the existing receipt and executes nothing. An external effect waits for approval.",
        {
          connector,
          validationId: z.string().min(1),
          contentHash: z.string().min(1),
          idempotencyKey: z.string().min(1).optional(),
        },
        async (args) =>
          run(args.connector, "submit", () =>
            ctx.client.connectorSubmit(args.connector, {
              validationId: args.validationId,
              contentHash: args.contentHash,
              ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
            }),
          ),
      ),
    );
  if (offered("connector_status"))
    tools.push(
      ctx.tool(
        "connector_status",
        "Current status of a submission's receipt. The Gateway's receipt is the truth, not any file mirroring it.",
        { connector, receiptId: z.string().min(1) },
        async (args) =>
          run(args.connector, "status", () =>
            ctx.client.connectorStatus(args.connector, args.receiptId),
          ),
      ),
    );
  if (offered("connector_receipt"))
    tools.push(
      ctx.tool(
        "connector_receipt",
        "The authoritative, versioned receipt of a submission, with every status it has had.",
        { connector, receiptId: z.string().min(1) },
        async (args) =>
          run(args.connector, "receipt", () =>
            ctx.client.connectorReceipt(args.connector, args.receiptId),
          ),
      ),
    );
  return tools;
}
