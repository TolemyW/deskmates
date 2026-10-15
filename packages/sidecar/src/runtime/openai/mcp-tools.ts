// The sidecar's MCP servers attached to the OpenAI runtime through MCP clients (ADR-0042
// decision 4): the in-process `deskmates` server over an in-memory transport, the browser
// `mcp-proxy` over stdio, so the proxy's untrusted-content wrapping and screenshot capture stay
// exactly where they are. Each listed tool becomes a `ToolSpec` named `mcp__<server>__<tool>`,
// the name the Claude SDK gives the same tool, which the tier tables key on.

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolOutcome, ToolSpec } from "./types.js";

export interface McpConnection {
  name: string;
  tools: ToolSpec[];
  close(): Promise<void>;
}

/** The text the model gets for a non-text content block; images are notices on this runtime. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image")
      parts.push(
        `[image ${typeof block.mimeType === "string" ? block.mimeType : ""} omitted on this runtime]`,
      );
    else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const r = block.resource as { text?: unknown };
      if (typeof r.text === "string") parts.push(r.text);
    }
  }
  return parts.join("\n");
}

async function toolsOf(name: string, client: Client): Promise<ToolSpec[]> {
  const listed = await client.listTools();
  return listed.tools.map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description ?? "",
    parameters: {
      additionalProperties: true,
      ...(t.inputSchema as Record<string, unknown>),
      type: "object",
    },
    async run(input): Promise<ToolOutcome> {
      const result = (await client.callTool({ name: t.name, arguments: input })) as {
        content?: unknown;
        isError?: boolean;
      };
      return { text: contentText(result.content), ...(result.isError ? { isError: true } : {}) };
    },
  }));
}

/** Connect every configured server; a server that fails to connect fails the run. */
export async function connectMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
  attachStdio = true,
): Promise<McpConnection[]> {
  const out: McpConnection[] = [];
  for (const [name, config] of Object.entries(servers ?? {})) {
    const client = new Client({ name: "deskmates-openai-runtime", version: "0" });
    if (config.type === "sdk") {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await config.instance.connect(serverTransport);
      await client.connect(clientTransport);
    } else if (config.type === "stdio" || config.type === undefined) {
      if (!attachStdio) continue;
      const stdio = config as { command: string; args?: string[]; env?: Record<string, string> };
      const transport = new StdioClientTransport({
        command: stdio.command,
        args: stdio.args ?? [],
        env: {
          ...getDefaultEnvironment(),
          ...Object.fromEntries(
            Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
          ),
          ...(stdio.env ?? {}),
        },
        stderr: "ignore",
      });
      await client.connect(transport);
    } else {
      throw new Error(
        `MCP server ${name}: transport ${String(config.type)} is not supported on the openai-agents runtime`,
      );
    }
    out.push({
      name,
      tools: await toolsOf(name, client),
      close: () => client.close().catch(() => undefined),
    });
  }
  return out;
}
