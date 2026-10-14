#!/usr/bin/env node
// `deskmates-agent-mcp`: the stdio MCP server. Configuration comes from the environment
// (DESKMATES_URL, DESKMATES_TOKEN, optional DESKMATES_WORKSPACE_ID and DESKMATES_POLL_INTERVAL_MS).
// stdout carries the protocol; diagnostics go to stderr and never include the token.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SERVER_NAME, createAgentMcpServer } from "./server.js";
import { TOOLS } from "./tools.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // Config errors name the variable, never its value.
    log(`${SERVER_NAME}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const server = createAgentMcpServer({ config, log });
  await server.connect(new StdioServerTransport());
  log(`${SERVER_NAME}: serving ${TOOLS.length} tools for ${config.gatewayUrl}`);
}

main().catch((err: unknown) => {
  log(`${SERVER_NAME}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
