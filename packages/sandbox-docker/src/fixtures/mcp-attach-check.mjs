// Runs INSIDE the workspace container (piped to `node --input-type=module -` by the T2 test).
// Starts the preinstalled Playwright MCP against the shared Chromium over CDP, lists tools,
// navigates, takes a snapshot, and prints one JSON line. No npx, no downloads.
import { spawn } from "node:child_process";

const cli = `${process.env.NPM_GLOBAL_ROOT ?? "/usr/lib/node_modules"}/@playwright/mcp/cli.js`;
const cdp = process.env.DESKMATES_CDP_URL ?? "http://127.0.0.1:9222";
const mcp = spawn("node", [cli, "--cdp-endpoint", cdp, "--caps", "vision"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buf = "";
mcp.stdout.on("data", (d) => {
  buf += d.toString();
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() !== "") {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
    i = buf.indexOf("\n");
  }
});

let nextId = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "deskmates-t2", version: "0" },
});
mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const tools = (await call("tools/list", {})).result.tools.map((t) => t.name);
await call("tools/call", {
  name: "browser_navigate",
  arguments: { url: "data:text/html,<h1>mcp-attach-ok</h1>" },
});
const snapshot = (
  await call("tools/call", { name: "browser_snapshot", arguments: {} })
).result.content
  .map((c) => c.text ?? "")
  .join("\n");
console.log(
  JSON.stringify({
    server: init.result.serverInfo,
    toolCount: tools.length,
    vision: tools.includes("browser_mouse_click_xy"),
    snapshotHasText: snapshot.includes("mcp-attach-ok"),
  }),
);
await call("tools/call", { name: "browser_close", arguments: {} });
mcp.kill();
