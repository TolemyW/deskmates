import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const html = `<!doctype html><button id="action" style="margin:40px;width:180px;height:50px">Click target</button><output id="count">0</output><script>let n=0;action.onclick=()=>count.textContent=String(++n)</script>`;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(8081, "127.0.0.1", resolve);
});

const children = [];
async function client(label) {
  const child = spawn(
    "playwright-mcp",
    ["--cdp-endpoint", "http://127.0.0.1:9222", "--caps", "vision"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  children.push(child);
  let serial = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `${label}-${++serial}`;
      const timer = setTimeout(() => reject(new Error(`RPC timeout ${method}`)), 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: label, version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    tool: (name, args = {}) => call("tools/call", { name, arguments: args }),
    list: () => call("tools/list"),
  };
}

const text = (result) => (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
const refOf = (result) => {
  const match = /button "Click target"[^\n]*\[ref=([^\]]+)\]/.exec(text(result));
  if (!match?.[1]) throw new Error(`no button ref: ${text(result)}`);
  return match[1];
};
const summary = [];
const rounds = Number(process.env.PROBE_ROUNDS ?? 8);
try {
  const [a, b] = await Promise.all([client("mcp-a"), client("mcp-b")]);
  const schema = (await a.list()).tools.find((tool) => tool.name === "browser_click")?.inputSchema;
  await a.tool("browser_tabs", { action: "new" });
  await b.tool("browser_tabs", { action: "new" });
  for (let round = 1; round <= rounds; round += 1) {
    await Promise.all([
      a.tool("browser_navigate", { url: `http://localhost:8081/?tab=a&round=${round}` }),
      b.tool("browser_navigate", { url: `http://localhost:8081/?tab=b&round=${round}` }),
    ]);
    if (process.env.PROBE_FOCUS_EMULATION === "1") {
      const focusCode =
        process.env.PROBE_FOCUS_KEEP === "1"
          ? "async(page)=>{const s=await page.context().newCDPSession(page);await s.send('Emulation.setFocusEmulationEnabled',{enabled:true});globalThis.__deskmatesFocusSessions??=[];globalThis.__deskmatesFocusSessions.push(s);return {visibility:await page.evaluate(()=>document.visibilityState),focus:await page.evaluate(()=>document.hasFocus()),session:'kept'}}"
          : "async(page)=>{const s=await page.context().newCDPSession(page);try{await s.send('Emulation.setFocusEmulationEnabled',{enabled:true});return {visibility:await page.evaluate(()=>document.visibilityState),focus:await page.evaluate(()=>document.hasFocus()),session:'detached'}}finally{await s.detach()}}";
      await Promise.all(
        [a, b].map((client) =>
          client.tool("browser_run_code_unsafe", {
            code: focusCode,
          }),
        ),
      );
    }
    const [sa, sb] = await Promise.all([a.tool("browser_snapshot"), b.tool("browser_snapshot")]);
    const [ra, rb] = [refOf(sa), refOf(sb)];
    const started = Date.now();
    const clicked = await Promise.all([
      a.tool("browser_click", { target: ra }),
      b.tool("browser_click", { target: rb }),
    ]);
    const states = await Promise.all([
      a.tool("browser_run_code_unsafe", { code: "async(page)=>({url:page.url(),visibility:await page.evaluate(()=>document.visibilityState),count:await page.locator('#count').textContent()})" }),
      b.tool("browser_run_code_unsafe", { code: "async(page)=>({url:page.url(),visibility:await page.evaluate(()=>document.visibilityState),count:await page.locator('#count').textContent()})" }),
    ]);
    summary.push({ round, elapsedMs: Date.now() - started, clicks: clicked.map((result) => ({ isError: result.isError === true, text: text(result).slice(0, 500) })), states: states.map((result) => text(result).slice(0, 500)) });
  }
  console.log(JSON.stringify({ mode: process.env.PROBE_MODE, rounds, schema, summary }, null, 2));
} finally {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
}
