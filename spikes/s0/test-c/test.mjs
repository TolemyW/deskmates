// Test C: one Chromium shared by (1) Playwright MCP over CDP, (2) a "human" acting at X11 level (xdotool = what noVNC input becomes), (3) VNC screenshot path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import fs from "node:fs";

const R = { steps: [] };
const step = (name, ok, info) => { R.steps.push({ name, ok, info }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${info ? JSON.stringify(info) : ""}`); };
const text = (r) => r.content?.filter(c => c.type === "text").map(c => c.text).join(String.fromCharCode(10)) || "";

// serve a local test page with a shadow-DOM button (for the vision-fallback check)
import http from "node:http";
http.createServer((q, s) => {
  s.setHeader("content-type", "text/html");
  s.end(`<html><body><h1 id="h">Shared Browser Test</h1>
  <button id="plain" onclick="document.getElementById('h').textContent='PLAIN CLICKED'">Plain</button>
  <div id="host"></div>
  <script>
    const sr = document.getElementById('host').attachShadow({mode:'closed'});
    const b = document.createElement('button'); b.textContent='Shadow'; b.style.cssText='position:absolute;left:400px;top:300px;width:120px;height:40px';
    b.onclick=()=>document.getElementById('h').textContent='SHADOW CLICKED'; sr.appendChild(b);
  </script></body></html>`);
}).listen(8099);

try {
  // 1. Playwright MCP attaches to the existing browser over CDP
  const transport = new StdioClientTransport({ command: "node", args: ["/app/node_modules/@playwright/mcp/cli.js", "--cdp-endpoint", "http://127.0.0.1:9222", "--caps", "vision"] });
  const mcp = new Client({ name: "spike", version: "0.0.1" });
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  step("mcp.attach_over_cdp", tools.includes("browser_navigate"), { toolCount: tools.length, vision: tools.filter(t => t.includes("_xy")) });

  await mcp.callTool({ name: "browser_navigate", arguments: { url: "http://127.0.0.1:8099/" } });
  const snap = text(await mcp.callTool({ name: "browser_snapshot", arguments: {} }));
  step("mcp.navigate_and_snapshot", snap.includes("Shared Browser Test"), { snapLen: snap.length });
  step("a11y_tree_sees_shadow_button", snap.includes("Shadow"), { note: "closed shadow root; expected NOT visible in tree" });

  // 2. Human takeover at the X11 level: xdotool clicks the Plain button (what a noVNC user's click becomes)
  execSync("xdotool search --sync --onlyvisible --class chrom | head -1 | xargs -I{} xdotool windowactivate --sync {}", { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 500));
  // find button screen coords via CDP from a second connection (a real human would just see it)
  const cdp = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = cdp.contexts()[0].pages().find(p => p.url().includes("8099"));
  const box = await page.locator("#plain").boundingBox();
  const win = JSON.parse(execSync("xdotool getactivewindow getwindowgeometry --shell | sed 's/^/\"/;s/=/\":/;s/$/,/' | tr -d '\n' | sed 's/^/{/;s/,$/}/'").toString());
  const chromeTop = 0; // fluxbox+kiosk-less window; approximate: use CDP page->screen via window.screenY
  const offY = await page.evaluate(() => window.outerHeight - window.innerHeight);
  const offX = await page.evaluate(() => (window.outerWidth - window.innerWidth) / 2);
  execSync(`xdotool mousemove ${Math.round(win.X + offX + box.x + box.width / 2)} ${Math.round(win.Y + offY + box.y + box.height / 2)} click 1`);
  await new Promise(r => setTimeout(r, 500));
  const h1 = await page.locator("#h").textContent();
  step("human_x11_click_reaches_page", h1 === "PLAIN CLICKED", { h1, win, offX, offY, box });

  // 3. Agent (MCP) still sees the human's change
  const snap2 = text(await mcp.callTool({ name: "browser_snapshot", arguments: {} }));
  step("mcp_sees_human_change", snap2.includes("PLAIN CLICKED"));

  // 4. Vision fallback: MCP coordinate click on the closed-shadow button the tree cannot see
  const vp = await page.evaluate(() => ({ dpr: window.devicePixelRatio }));
  await mcp.callTool({ name: "browser_mouse_click_xy", arguments: { element: "shadow button", x: 460, y: 320 } });
  await new Promise(r => setTimeout(r, 300));
  const h1b = await page.locator("#h").textContent();
  step("vision_xy_click_hits_shadow_button", h1b === "SHADOW CLICKED", { h1: h1b, vp });

  // 5. VNC path is live: grab framebuffer via x11 (what noVNC shows)
  execSync("import -display :99 -window root /tmp/vnc-frame.png");
  const sz = fs.statSync("/tmp/vnc-frame.png").size;
  step("vnc_display_capturable", sz > 10000, { bytes: sz, novnc_log: fs.readFileSync("/tmp/novnc.log", "utf8").split(String.fromCharCode(10)).slice(0, 2).join(" | ") });

  // 6. Profile persistence: cookie set via MCP survives in /profile on disk
  await mcp.callTool({ name: "browser_evaluate", arguments: { function: "() => { document.cookie = 'spike=1; max-age=3600'; return document.cookie }" } });
  await cdp.close();
  await mcp.close();
  await new Promise(r => setTimeout(r, 1500));
  const cookieFiles = execSync("find /profile -name Cookies -newer /app/test.mjs | head -3").toString().trim();
  step("profile_persisted_on_disk", cookieFiles.length > 0, { cookieFiles });
} catch (e) {
  step("exception", false, { error: String(e).slice(0, 800) });
}
fs.writeFileSync("/tmp/result.json", JSON.stringify(R, null, 2));
console.log("RESULT " + JSON.stringify(R));
process.exit(R.steps.every(s => s.ok) ? 0 : 1);
