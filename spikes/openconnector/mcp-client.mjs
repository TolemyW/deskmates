// Minimal MCP client for OpenConnector's stateless Streamable HTTP endpoint (`POST /mcp`, JSON
// responses). No SDK: one JSON-RPC request per HTTP POST, which is all the runtime needs.
// Every exchange is returned with the raw request and response so the probe can record them.

const PROTOCOL_VERSION = "2025-06-18";

export function createMcpClient({ url, token }) {
  let nextId = 1;
  let sessionId;

  async function post(message) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
    const text = await response.text();
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;
    // v1.7.0 answers some requests as a one-event SSE stream even in JSON response mode;
    // take the JSON-RPC message from its `data:` line(s).
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    let body;
    try {
      body = payload ? JSON.parse(payload) : null;
    } catch {
      body = { unparsed: text };
    }
    return {
      request: { method: "POST", url, headers: redactAuth(headers), body: message },
      response: {
        status: response.status,
        contentType,
        bytes: text.length,
        mcpSessionId: returnedSession,
        body,
      },
    };
  }

  return {
    async request(method, params) {
      return post({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
    },
    async notify(method, params) {
      return post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    async initialize() {
      const init = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "deskmates-openconnector-spike", version: "0.0.1" },
      });
      const initialized = await this.notify("notifications/initialized");
      return { init, initialized };
    },
    async callTool(name, args) {
      return this.request("tools/call", { name, arguments: args });
    },
  };
}

/** Runtime tokens are throwaway values of a throwaway container, but a recorded file still shows only a prefix. */
function redactAuth(headers) {
  if (!headers.authorization) return headers;
  return { ...headers, authorization: `${headers.authorization.slice(0, 13)}...` };
}
