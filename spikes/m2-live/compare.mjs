// Descriptive paired regression report, not the planned full strategy comparator.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error("Usage: compare.mjs <baseline-dir> <candidate-dir>");
function load(folder) {
  const root = resolve(folder);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const cases = JSON.parse(readFileSync(join(root, "results.json"), "utf8"));
  const expected = Array.from({length: manifest.repetitions}, (_, i) =>
    ["chief", "ordered", "parallel", "direct"].map((name) => `${name}${i + 1}`)).flat().sort();
  if (JSON.stringify(cases.map((c) => c.label).sort()) !== JSON.stringify(expected))
    throw new Error(`Incomplete or duplicated case matrix in ${root}`);
  return { root, manifest, cases };
}
const baseline = load(paths[0]);
const candidate = load(paths[1]);
for (const key of ["testSha256", "model", "cheapModel", "endpointOrigin", "repetitions", "maxTurns", "runTimeoutSeconds"])
  if (baseline.manifest[key] !== candidate.manifest[key]) throw new Error(`Unpaired configuration: ${key}`);
// Source commits can differ only in sidecar rendering/test documentation. Check the
// actual Gateway and shared contract trees, not merely whole-repository commit IDs.
for (const path of ["packages/gateway", "packages/contracts"]) {
  const tree = (revision) => execFileSync("git", ["rev-parse", `${revision}:${path}`], {encoding: "utf8"}).trim();
  if (tree(baseline.manifest.revision) !== tree(candidate.manifest.revision))
    throw new Error(`Unpaired runtime source tree: ${path}`);
}
const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens"];
function total(cases) {
  const usage = Object.fromEntries(keys.map((key) => [key, 0]));
  let deduplicated = 0;
  let duplicateRows = 0;
  let runs = 0;
  for (const c of cases) {
    runs += c.runs.length;
    for (const r of c.runs) {
      for (const row of r.usage) for (const key of keys) usage[key] += row[key];
      deduplicated += r.events.filter((e) => e.payload.source === "final_reply" && e.payload.op === "deduplicated").length;
    }
    for (const thread of c.threads) {
      const seen = new Set();
      for (const m of thread.messages.filter((m) => m.authorKind === "bot")) {
        const key = JSON.stringify([m.runId, m.authorId, m.body.trim()]);
        if (seen.has(key)) duplicateRows++;
        seen.add(key);
      }
    }
  }
  return { passed: cases.filter((c) => c.passed).length, total: cases.length, runs, deduplicated, duplicateRows, usage };
}
const pairs = baseline.cases.map((before) => {
  const after = candidate.cases.find((c) => c.label === before.label);
  return { label: before.label, baseline: before.passed, candidate: after.passed,
    baselineMs: before.wallMs, candidateMs: after.wallMs,
    ...(before.error ? { baselineError: before.error } : {}),
    ...(after.error ? { candidateError: after.error } : {}) };
});
const result = {
  scope: "Short synthetic messaging regression; same Gateway with final-reply deduplication in both variants; legacy versus routing-context-v1 sidecar.",
  verdict: "Inconclusive for general reliability or strategy improvement; the planned evals/compare.ts is not implemented. Timings are descriptive and variants ran sequentially.",
  baseline: { image: baseline.manifest.image, ...total(baseline.cases) },
  candidate: { image: candidate.manifest.image, ...total(candidate.cases) },
  paired: { bothPass: pairs.filter((p) => p.baseline && p.candidate).length,
    onlyBaseline: pairs.filter((p) => p.baseline && !p.candidate).length,
    onlyCandidate: pairs.filter((p) => !p.baseline && p.candidate).length,
    bothFail: pairs.filter((p) => !p.baseline && !p.candidate).length },
  pairs,
};
writeFileSync(join(candidate.root, "comparison.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
