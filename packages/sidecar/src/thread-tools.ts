// Thread tools exposed to the model as an in-process MCP server named `deskmates`
// (design v0.3 §3.2; ADR-0005 "Sidecar contract"). `thread_post` forwards a
// `PostMessageRequest`; the Gateway routes it. The sidecar parses no mentions.
// `message_bot` uses the same endpoint; pair selection and routing remain in the Gateway.

import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { type ApprovalId, DeskmatesError, type StartRunRequest } from "@deskmates/contracts";
import { z } from "zod";
import { appShareTools } from "./app-share-tools.js";
import {
  type BrowserCliWorkflowContext,
  type BrowserCliWorkflowDeps,
  browserCliWorkflowTool,
} from "./browser-cli-workflow.js";
import { connectorTools } from "./connector-tools.js";
import type { CreateSdkMcpServerFn, ToolFn } from "./deps.js";
import type { GatewayClient } from "./gateway-client.js";
import { integrationTools } from "./integration-tools.js";
import { knowledgeTools } from "./knowledge-tools.js";
import type { EventSink } from "./ledger.js";
import { memoryTools } from "./memory-tools.js";
import type { OperationFiles } from "./operation-input.js";
import { operationTools } from "./operation-tools.js";
import { describePosted } from "./posted-message.js";
import { DESKMATES_MCP_SERVER } from "./risk-tier.js";
import { taskTools } from "./task-tools.js";
import { type TtySessions, ttySessionTool } from "./tty-session.js";
import { withholdingToolResults } from "./vision-withhold.js";

export interface ThreadToolsContext {
  request: StartRunRequest;
  tty?: TtySessions;
  redactTerminal?: (text: string) => string;
  browserCli?: { context: BrowserCliWorkflowContext; deps: BrowserCliWorkflowDeps };
  client: GatewayClient;
  sink: EventSink;
  tool: ToolFn;
  createSdkMcpServer: CreateSdkMcpServerFn;
  /** How `image_describe` and `audio_transcribe` read files (ADR-0040); tests use a temp root. */
  operationFiles?: OperationFiles;
}

const attachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  ref: z.string(),
});

export function createThreadTools(ctx: ThreadToolsContext): McpSdkServerConfigWithInstance {
  const { request, client, sink } = ctx;
  // `SdkMcpToolDefinition<any>` is the SDK's own element type for the `tools` array; the schema
  // generic is erased there by the SDK, not by us.
  // biome-ignore lint/suspicious/noExplicitAny: matches the SDK's CreateSdkMcpServerOptions.tools
  const tools: SdkMcpToolDefinition<any>[] = [];

  if (request.tools.includes("message_bot")) {
    tools.push(
      ctx.tool(
        "message_bot",
        "Send a message to another configured bot in this workspace. The recipient handles it in a separate conversation and may reply later.",
        {
          to: z.string().min(1),
          body: z.string().min(1),
          attachments: z.array(attachmentSchema).optional(),
        },
        async (args) => {
          try {
            await client.postMessage({
              type: "post_message",
              runId: request.runId,
              tool: "message_bot",
              to: args.to,
              body: args.body,
              attachments: args.attachments ?? [],
            });
          } catch (err) {
            // Routing refusals are readable tool results, not fatal agent-loop errors.
            return {
              content: [{ type: "text", text: `The message was not delivered: ${String(err)}` }],
              isError: true,
            };
          }
          sink.emit("log", { source: "message_bot", to: args.to, body: args.body });
          return {
            content: [
              {
                type: "text",
                text: "Message recorded in the conversation. The recipient runs when routing limits and scheduling allow.",
              },
            ],
          };
        },
      ),
    );
  }

  if (request.tools.includes("thread_post")) {
    tools.push(
      ctx.tool(
        "thread_post",
        "Post a message to the current thread now: progress, a question, or a handoff. Mention a teammate with @name.",
        { body: z.string(), attachments: z.array(attachmentSchema).optional() },
        async (args) => {
          const attachments = args.attachments ?? [];
          const routing = await client.postMessage({
            type: "post_message",
            runId: request.runId,
            tool: "thread_post",
            body: args.body,
            attachments,
          });
          sink.emit("log", {
            source: "thread_post",
            threadId: request.threadId,
            body: args.body,
            attachments,
          });
          return {
            content: [
              {
                type: "text",
                text: describePosted(routing, request.groupGuidance === "owner-v1"),
              },
            ],
          };
        },
      ),
    );
  }

  // Any member of the thread may decide an approval posted in it: a human from the operator UI,
  // a bot through this tool (ADR-0002 amendment 2, A2). The Gateway checks membership and records
  // which bot decided; the sidecar neither knows nor enforces who may answer.
  if (request.tools.includes("approval_decide")) {
    tools.push(
      ctx.tool(
        "approval_decide",
        "Decide a pending approval posted in this thread. Only use it when the thread asked you to review an approval request; approvalId is the ref of the approval attachment.",
        {
          approvalId: z.string(),
          decision: z.enum(["allow_once", "allow_always", "deny"]),
          reason: z.string().optional(),
        },
        async (args) => {
          try {
            await client.decideApproval({
              type: "approval_decide",
              runId: request.runId,
              approvalId: args.approvalId as ApprovalId,
              decision: args.decision,
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            });
          } catch (err) {
            // A refusal is an answer to the model, not a crash: the Gateway rejects a decision
            // from a bot that is not a member, and one already decided is a 409.
            // The Gateway's reason is the useful part: "approval ap-1 was already allow_once"
            // tells the model to stop retrying, and `decidedBy` says who got there first.
            const typed = err instanceof DeskmatesError ? err : undefined;
            const decidedBy =
              typed && typeof typed.details.decidedBy === "string"
                ? ` (decided by ${typed.details.decidedBy})`
                : "";
            const error = `${String(err)}${decidedBy}`;
            const text = `The Gateway did not record the decision: ${error}`;
            sink.emit("log", {
              source: "approval_decide",
              approvalId: args.approvalId,
              decision: args.decision,
              level: "warn",
              ...(typed ? { code: typed.code } : {}),
              error,
            });
            return { content: [{ type: "text", text }], isError: true };
          }
          sink.emit("log", {
            source: "approval_decide",
            approvalId: args.approvalId,
            decision: args.decision,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
          });
          return { content: [{ type: "text", text: "Decision recorded." }] };
        },
      ),
    );
  }

  tools.push(...knowledgeTools(ctx));
  tools.push(...memoryTools(ctx));
  tools.push(...connectorTools(ctx));
  tools.push(...integrationTools(ctx));
  tools.push(...taskTools(ctx));
  tools.push(...appShareTools(ctx));
  tools.push(...operationTools(ctx));
  if (
    request.tools.includes("browser_cli_workflow") &&
    request.browserExecutionMode === "vision-cli-v2" &&
    ctx.browserCli
  )
    tools.push(browserCliWorkflowTool(ctx.tool, ctx.browserCli.context, ctx.browserCli.deps));
  if (request.tools.includes("tty_session") && ctx.tty)
    tools.push(ttySessionTool(ctx.tool, ctx.tty, ctx.redactTerminal));
  return ctx.createSdkMcpServer({
    name: DESKMATES_MCP_SERVER,
    version: "0.0.0",
    // ADR-0023 amendment 3, decision 16: no tool of this server hands a blind model an image.
    tools: withholdingToolResults(request, sink, tools),
  });
}
