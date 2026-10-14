// Build-time compatibility shim for pinned MCP 0.0.82. No model code, modal guard change,
// selector access or upload bypass. Read stable IDs in the very same MCP tab list handler.
// The sidecar mcp-proxy strips the added line before results reach the model
// (packages/sidecar/src/mcp-proxy/browser-coordinator.ts, stripTabIdentity).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function patchTabIdentity(source) {
  const expected = "728ee6ffd51548f3b200a442749421b039a21621775ec751bff33d10a05b2637";
  if (createHash("sha256").update(source).digest("hex") !== expected)
    throw new Error("Unsupported MCP core bundle: review tab identity shim before building");
  const anchor =
    '        const result2 = renderTabsMarkdown(tabHeaders);\n        response2.addTextResult(result2.join("\\n"));';
  if (source.split(anchor).length !== 2) throw new Error("MCP tab handler shape changed");
  const addition = `        if (params2.action === "list") {
          const tabs = [];
          for (const tab of context.tabs()) {
            const session = await tab.page.context().newCDPSession(tab.page);
            try {
              const { targetInfo } = await session.send("Target.getTargetInfo");
              tabs.push({ id: targetInfo.targetId, url: tab.page.url(), current: tab.isCurrentTab() });
            } finally { await session.detach(); }
          }
          response2.addTextResult(JSON.stringify({ tabs }));
        }
`;
  return source.replace(anchor, addition + anchor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(join(process.argv[2], "package.json"));
  const pkg = JSON.parse(readFileSync(require.resolve("@playwright/mcp/package.json"), "utf8"));
  if (pkg.version !== "0.0.82") throw new Error("Expected MCP 0.0.82");
  const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
  const bundle = join(
    dirname(mcpRequire.resolve("playwright-core/package.json")),
    "lib/coreBundle.js",
  );
  writeFileSync(bundle, patchTabIdentity(readFileSync(bundle, "utf8")));
}
