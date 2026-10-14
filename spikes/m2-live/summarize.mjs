import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const folder = resolve(process.argv[2] ?? "spikes/m2-live/work-final");
const cases = JSON.parse(readFileSync(join(folder, "results.json"), "utf8"));
const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens"];
const totals = Object.fromEntries(keys.map((key) => [key, 0]));
const details = cases.map((c) => {
  const usage = Object.fromEntries(keys.map((key) => [key, 0]));
  let duplicateMessages = 0;
  for (const t of c.threads) {
    const seen = new Set();
    for (const m of t.messages.filter((m) => m.authorKind === "bot")) {
      const key = `${m.authorId}:${m.body.trim()}`;
      if (seen.has(key)) duplicateMessages++;
      seen.add(key);
    }
  }
  let silentWithoutPosting = 0;
  for (const r of c.runs) {
    for (const row of r.usage) for (const key of keys) usage[key] += row[key];
    const posted = c.threads.some((t) => t.messages.some((m) => m.authorKind === "bot" && m.runId === r.id));
    if (r.status === "silent" && !posted) silentWithoutPosting++;
  }
  for (const key of keys) totals[key] += usage[key];
  return { label: c.label, passed: c.passed, wallSeconds: Math.round(c.wallMs / 100) / 10,
    runs: c.runs.length, silentWithoutPosting, duplicateMessages, usage, error: c.error };
});
const result = { cases: details, totals, runs: details.reduce((n, c) => n + c.runs, 0),
  passed: details.filter((c) => c.passed).length, failed: details.filter((c) => !c.passed).length };
writeFileSync(join(folder, "summary.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
