// Zero-token local CPU measurement using the production context builder and synthetic files.
// This is not a provider-cache experiment, filesystem benchmark or persistent-host proposal.
// Run: npx tsx --tsconfig evals/tsconfig.json evals/cache-analysis/context-construction.ts

import { performance } from "node:perf_hooks";
import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { buildContext } from "@deskmates/sidecar/context.js";
import { createMemoryFs } from "@deskmates/sidecar/testing/in-memory-fs.js";

const now = new Date("2026-10-19T00:00:00.000Z");
const request: StartRunRequest = {
  runId: "run-cache-fixture" as RunId,
  botId: "bot-cache-fixture" as BotId,
  botName: "fixture",
  botRole: "fixture role",
  workspaceName: "Cache fixture",
  workspaceId: "workspace-cache-fixture" as WorkspaceId,
  threadId: "thread-cache-fixture" as ThreadId,
  botHomeDir: "/home/fixture",
  attempt: 1,
  trigger: {
    kind: "cron",
    prompt: "Read the synthetic notes and summarize them.",
  },
  model: "model-under-test",
  cheapModel: "cheap-model-under-test",
  modelBaseUrl: "http://gateway.test/model",
  modelAuthToken: "test-token",
  gatewayBaseUrl: "http://gateway.test",
  shortWaitSeconds: 300,
  maxTurns: 10,
  egressAllowlist: [],
  connectors: [],
  tools: ["thread_post", "memory_search"],
};
const fs = createMemoryFs({
  "/home/fixture/SOUL.md": "You are a synthetic measurement bot.\n".repeat(100),
  "/home/fixture/MEMORY.md": "A synthetic stable note.\n".repeat(500),
  "/home/fixture/memory/2026-10-17.md": "Synthetic diary A.\n".repeat(500),
  "/home/fixture/memory/2026-10-18.md": "Synthetic diary B.\n".repeat(500),
  "/home/fixture/memory/2026-10-19.md": "Synthetic diary C.\n".repeat(500),
});

// Warm module code, excluding import/SDK/process startup. No local cache is introduced.
for (let i = 0; i < 100; i += 1) await buildContext(request, fs, now);
const elapsed: number[] = [];
const hashes = new Set<string>();
let contextChars = 0;
for (let i = 0; i < 2000; i += 1) {
  const started = performance.now();
  const context = await buildContext(request, fs, now);
  elapsed.push(performance.now() - started);
  hashes.add(context.systemPromptStaticSha256);
  contextChars = context.systemPrompt.length + context.prompt.length;
}
const baseline = await buildContext(request, fs, now);
fs.files.set("/home/fixture/MEMORY.md", "Updated synthetic memory.");
fs.files.set("/home/fixture/memory/2026-10-19.md", "Updated synthetic diary.");
const changedDynamic = await buildContext(request, fs, now);
fs.files.set("/home/fixture/SOUL.md", "A new synthetic SOUL revision.");
const changedSoul = await buildContext(request, fs, now);
if (baseline.systemPromptStaticSha256 !== changedDynamic.systemPromptStaticSha256)
  throw new Error("dynamic notes changed the static prefix");
if (baseline.prompt === changedDynamic.prompt) throw new Error("dynamic notes were stale");
if (baseline.systemPromptStaticSha256 === changedSoul.systemPromptStaticSha256)
  throw new Error("SOUL revision did not invalidate the static prefix");
elapsed.sort((a, b) => a - b);
process.stdout.write(
  `${JSON.stringify(
    {
      schema: 1,
      source: "production buildContext, synthetic in-memory files, no cache",
      iterations: elapsed.length,
      contextChars,
      staticHashCount: hashes.size,
      p50Ms: elapsed[Math.ceil(elapsed.length * 0.5) - 1],
      p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
      maxMs: elapsed.at(-1),
      dynamicRefreshAndSoulInvalidation: "passed",
      limitations: "CPU construction only; excludes process, SDK, disk, provider and network",
    },
    null,
    2,
  )}\n`,
);
