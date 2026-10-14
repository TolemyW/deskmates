// Question 1: how much model context the runtime's MCP surface costs. Reads the exchanges probe.mjs
// recorded and writes token-cost.json and token-cost.md. Estimates only: 4 characters per token for
// non-CJK text, 2 characters per token for CJK; no tokenizer is run and no model is called.
import { readFileSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT_DIR ?? "/out";
const read = (name) => JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8"));

const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/g;
function estimate(text) {
  const chars = text.length;
  const cjk = (text.match(CJK) ?? []).length;
  return { chars, cjk, tokens: Math.ceil((chars - cjk) / 4 + cjk / 2) };
}

const rows = [];
function row(group, item, text, note = "") {
  const e = estimate(text);
  rows.push({ group, item, ...e, note });
}

// ---- tool definitions as returned by tools/list ----
const mcp = read("03-mcp-enumeration");
const tools = mcp.toolsList.response.body.result.tools;
let allToolsCompact = 0;
for (const tool of tools) {
  row("tools/list", `${tool.name} description`, tool.description);
  row("tools/list", `${tool.name} inputSchema`, JSON.stringify(tool.inputSchema));
  const whole = JSON.stringify(tool);
  allToolsCompact += whole.length;
  row("tools/list", `${tool.name} whole entry`, whole, "name, title, description, inputSchema, annotations, execution");
}
row("tools/list", "all five tools", JSON.stringify(tools), "what an MCP host would load");
const instructions = mcp.initialize.init.response.body.result.instructions ?? "";
row("initialize", "server instructions", instructions, "only if the host injects MCP instructions");

// ---- results: the text content block the model would see (pretty-printed JSON as returned) ----
const text = (x) => x.response.body?.result?.content?.[0]?.text ?? "";
const compact = (x) => JSON.stringify(x.response.body?.result?.structuredContent ?? null);
const count = (x) => {
  const d = x.response.body?.result?.structuredContent?.data;
  return Array.isArray(d) ? d.length : undefined;
};
for (const key of [
  "listAppsSlack",
  "listAppsGoogleDrive",
  "searchSlack",
  "searchGoogleDrive",
  "searchSlackPost",
  "searchDriveFolder",
  "searchDriveShare",
]) {
  const n = count(mcp[key]);
  const args = JSON.stringify(mcp[key].request.body.params.arguments);
  row("result (as returned)", `${mcp[key].request.body.params.name} ${args}`, text(mcp[key]), `${n} entries`);
  row("result (compact JSON)", `${mcp[key].request.body.params.name} ${args}`, compact(mcp[key]), `${n} entries`);
}
rows.push({
  group: "result (as returned)",
  item: "list_apps {} (whole catalog)",
  chars: mcp.listAppsAll.textChars,
  cjk: mcp.listAppsAll.cjkChars,
  tokens: Math.ceil((mcp.listAppsAll.textChars - mcp.listAppsAll.cjkChars) / 4 + mcp.listAppsAll.cjkChars / 2),
  note: `${mcp.listAppsAll.entries} entries; never offer unfiltered`,
});

const guides = read("04-action-guides");
for (const [id, x] of Object.entries(guides)) {
  const data = x.response.body?.result?.structuredContent?.data;
  row("get_action_guide (as returned)", id, text(x), data?.capability?.operationType ?? "");
  if (data?.markdown) row("get_action_guide markdown only", id, data.markdown, data.capability.operationType);
}

const scope = read("02-scope");
row(
  "result (as returned)",
  "list_connections {} with a token granted one connection",
  text(scope.listConnectionsA),
  `${count(scope.listConnectionsA)} entries: 1 granted + virtual no_auth ones`,
);

const exec = read("05-execute");
row("execute_action (as returned)", "gitea.list_my_repositories (2 repos)", text(exec.giteaListRepos));

writeFileSync(`${OUT}/token-cost.json`, `${JSON.stringify(rows, null, 2)}\n`);

const lines = [
  "| Group | Item | Chars | CJK chars | Est. tokens | Note |",
  "|---|---|---:|---:|---:|---|",
  ...rows.map((r) => `| ${r.group} | ${r.item.replaceAll("|", "\\|")} | ${r.chars} | ${r.cjk} | ${r.tokens} | ${r.note} |`),
];
writeFileSync(`${OUT}/token-cost.md`, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
