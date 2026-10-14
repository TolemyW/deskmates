// UX-01 / ADR-0011 A5: simultaneous real SDK starts import every legacy workspace
// bot before a scripted upstream sees context. No real model or behavior evaluation.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotDefinition, type Thread, botHomeDir } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const names = ["legacyalpha", "legacybeta"] as const;
const souls = names.map(
  (name) => `# ${name}\nLEGACY_SOUL_${name}\nKeep the operator's original rules.\n`,
);
const memories = names.map(
  (name) => `LEGACY_NOTES_${name}\nPreserve this original note exactly.\n`,
);
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const token = "fake-legacy-concurrent-only";
const observations: Record<string, unknown>[] = [];

function resultBlocks(body: Record<string, unknown> | undefined): number {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.reduce((total, message) => {
    const content = typeof message === "object" && message !== null ? message.content : undefined;
    return (
      total + (Array.isArray(content) ? content.filter((b) => b?.type === "tool_result").length : 0)
    );
  }, 0);
}

describe.skipIf(!available)("M3 concurrent legacy import before actual SDK execution (T2)", () => {
  let upstream: FakeModelUpstream | undefined;
  let stack: Stack | undefined;
  let bots: BotDefinition[] = [];
  let peerThread: Thread | undefined;
  const waiting = new Map<string, () => void>();
  let overlapObserved = false;
  const saveProof = () => {
    const dir = process.env.DESKMATES_QA_LEGACY_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Do not serialize run tokens, provider stdin, upstream headers or SDK transcripts.
    writeFileSync(
      join(dir, "legacy-import-proof.json"),
      JSON.stringify(
        {
          realSdk: true,
          realModelCalls: 0,
          overlapObserved,
          observations,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  };
  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: token,
      reply: "unused",
      script: async (_turn, body): Promise<FakeTurn> => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0)
          return { kind: "text", text: "OK" };
        const index = names.findIndex((name) =>
          JSON.stringify(body.system).includes(`LEGACY_SOUL_${name}`),
        );
        if (index < 0 || !stack)
          return { kind: "text", text: "Missing legacy instruction marker." };
        const name = names[index];
        if (!name) throw Error("unknown legacy bot index");
        if (resultBlocks(body) === 0) {
          const canonical = bots.map((bot) => ({
            botId: bot.id,
            soul: stack?.app.deskmates.ctx.bots.canonicalSoul(bot.id),
            manualMemory: stack?.app.deskmates.ctx.bots.legacyMemory(bot.id),
          }));
          const completedReads = stack.provider.execs
            .filter(
              (entry) =>
                entry.request.cmd[0] === "deskmates-sidecar" &&
                entry.request.cmd[1] === "memory" &&
                entry.result?.exitCode === 0,
            )
            .map((entry) => {
              const input = JSON.parse(entry.request.stdin ?? "{}") as {
                botName: string;
                fileName: string;
                op: string;
              };
              const result = JSON.parse(entry.result?.stdout ?? "{}") as {
                body: string;
                version: string;
              };
              return { ...input, bodySha256: sha(result.body), version: result.version };
            });
          observations.push({
            event: "first_sdk_context",
            name,
            canonical,
            completedReads,
            running: stack.app.deskmates.ctx.runs
              .list()
              .map((run) => ({ botId: run.botId, status: run.status })),
            systemSha256: sha(JSON.stringify(body.system)),
            requestSha256: sha(JSON.stringify(body)),
            at: new Date().toISOString(),
          });
          await new Promise<void>((done, reject) => {
            const timer = setTimeout(() => {
              waiting.delete(name);
              reject(Error("second SDK did not reach the declared overlap barrier"));
            }, 30_000);
            waiting.set(name, () => {
              clearTimeout(timer);
              done();
            });
            if (waiting.size === 2) {
              overlapObserved = true;
              for (const release of waiting.values()) release();
              waiting.clear();
            }
          });
          saveProof();
          return {
            kind: "tool_use",
            name: "Bash",
            input: {
              command: `cat ${botHomeDir(name)}/SOUL.md ${botHomeDir(name)}/MEMORY.md`,
            },
          };
        }
        const reply = `Legacy files checked for ${name}.`;
        return {
          kind: "text",
          text: `${reply}\n\n\`\`\`json\n${JSON.stringify({
            done: "Read the fixture canonical files through Bash",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply,
          })}\n\`\`\``,
        };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: token,
      defaultModel: "fake-legacy-import",
      cheapModel: "fake-legacy-import",
      label: "m3-legacy-concurrent",
      botName: names[0],
      soul: souls[0] ?? "",
    });
    const created = await stack.api<{
      bot: BotDefinition;
      privateChat: Thread;
      welcomeRun: { id: string };
    }>("POST", "/api/bots", {
      workspaceId: stack.workspace.id,
      name: names[1],
      role: "Legacy concurrent import fixture",
    });
    expect(created.status).toBe(201);
    stack.app.deskmates.scheduler.cancel(
      created.json.welcomeRun.id as import("@deskmates/contracts").RunId,
      "test",
    );
    await stack.app.deskmates.scheduler.drain();
    bots = [stack.bot, created.json.bot];
    peerThread = created.json.privateChat;
    const files = Object.fromEntries(
      names.flatMap((name, i) => [
        [`${botHomeDir(name)}/SOUL.md`, Buffer.from(souls[i] ?? "").toString("base64")],
        [`${botHomeDir(name)}/MEMORY.md`, Buffer.from(memories[i] ?? "").toString("base64")],
      ]),
    );
    const seeded = await stack.provider.exec(stack.handle, {
      cmd: [
        "node",
        "-e",
        "const fs=require('fs'),p=require('path');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{for(const [name,value] of Object.entries(JSON.parse(s))){fs.mkdirSync(p.dirname(name),{recursive:true});fs.writeFileSync(name,Buffer.from(value,'base64'));}});",
      ],
      stdin: JSON.stringify(files),
      timeoutMs: 15_000,
    });
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    // Isolated migrated-legacy state; no model/SDK has run before this null seed.
    for (const bot of bots)
      stack.app.deskmates.ctx.db
        .prepare("UPDATE bots SET soul_body=NULL,memory_body=NULL WHERE id=?")
        .run(bot.id);
    expect(
      stack.provider.sidecarRuns().filter((entry) => entry.request.trigger.kind !== "welcome"),
    ).toHaveLength(0);
    expect(
      stack.app.deskmates.ctx.runs.list().filter((run) => run.triggerKind !== "welcome"),
    ).toHaveLength(0);
    observations.push({
      event: "legacy_files_seeded",
      workspaceId: stack.workspace.id,
      bots: bots.map((bot, i) => ({
        botId: bot.id,
        name: bot.name,
        soulSha256: sha(souls[i] ?? ""),
        manualMemorySha256: sha(memories[i] ?? ""),
      })),
    });
    saveProof();
  }, 180_000);
  afterAll(async () => {
    for (const release of waiting.values()) release();
    waiting.clear();
    saveProof();
    try {
      await stopStack(stack);
    } finally {
      await upstream?.close();
    }
  }, 120_000);

  it("imports all four existing files before either simultaneous SDK sees context and preserves both notes", async () => {
    if (!stack || !peerThread || !upstream) throw Error("legacy fixture not ready");
    const active = stack;
    const submitted = await Promise.all([
      postMessage(active, "Check existing legacy canonical files."),
      postMessage(active, "Check existing peer legacy canonical files.", peerThread.id),
    ]);
    const done = await Promise.all(submitted.map(({ run }) => waitForRun(active, run.id, 180_000)));
    expect(done.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(overlapObserved).toBe(true);
    const firstContexts = observations.filter((row) => row.event === "first_sdk_context");
    expect(firstContexts).toHaveLength(2);
    for (const row of firstContexts) {
      expect(row.canonical).toEqual(
        bots.map((bot, i) => ({
          botId: bot.id,
          soul: { body: souls[i], version: sha(souls[i] ?? "") },
          manualMemory: { body: memories[i], version: sha(memories[i] ?? "") },
        })),
      );
      const reads = row.completedReads as {
        botName: string;
        fileName: string;
        bodySha256: string;
      }[];
      for (const [i, name] of names.entries()) {
        expect(
          reads.some(
            (r) =>
              r.botName === name &&
              r.fileName === "SOUL.md" &&
              r.bodySha256 === sha(souls[i] ?? ""),
          ),
        ).toBe(true);
        expect(
          reads.some(
            (r) =>
              r.botName === name &&
              r.fileName === "MEMORY.md" &&
              r.bodySha256 === sha(memories[i] ?? ""),
          ),
        ).toBe(true);
      }
      expect(row.running).toEqual(
        expect.arrayContaining(bots.map((bot) => ({ botId: bot.id, status: "running" }))),
      );
    }
    const actualRequests = active.provider
      .sidecarRuns()
      .filter((entry) => entry.request.trigger.kind !== "welcome");
    expect(actualRequests).toHaveLength(2);
    for (const [i, bot] of bots.entries()) {
      const started = actualRequests.find((row) => row.request.botId === bot.id);
      expect(started).toBeDefined();
      expect(started?.request.canonicalFiles?.soul).toEqual({
        body: souls[i],
        version: sha(souls[i] ?? ""),
      });
      const expectedMemory = started?.request.canonicalFiles?.memory;
      expect(expectedMemory?.body).toContain(memories[i]);
      expect(expectedMemory?.version).toBe(sha(expectedMemory?.body ?? ""));
      const read = await active.provider.exec(active.handle, {
        cmd: [
          "node",
          "-e",
          "const fs=require('fs');console.log(JSON.stringify(process.argv.slice(1).map(p=>fs.readFileSync(p,'utf8'))))",
          `${botHomeDir(bot.name)}/SOUL.md`,
          `${botHomeDir(bot.name)}/MEMORY.md`,
        ],
        timeoutMs: 10_000,
      });
      expect(read.exitCode, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toEqual([souls[i], expectedMemory?.body]);
      const run = done.find((row) => row.botId === bot.id);
      if (!run) throw Error(`missing completed run for ${bot.name}`);
      expect(run?.sdkSessionId).toBeTruthy();
      const events = await runEvents(active, run.id);
      expect(
        events.some((event) => event.kind === "tool_call" && event.payload.toolName === "Bash"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === "tool_result" &&
            String(event.payload.content).includes(`LEGACY_NOTES_${bot.name}`),
        ),
      ).toBe(true);
      expect(active.app.deskmates.ctx.bots.legacyMemory(bot.id)?.body).toBe(memories[i]);
      observations.push({
        event: "run_verified",
        runId: run?.id,
        botId: bot.id,
        sdkSessionId: run?.sdkSessionId,
        canonicalSoulVersion: started?.request.canonicalFiles?.soul?.version,
        canonicalMemoryVersion: expectedMemory?.version,
        config: active.app.deskmates.ctx.runs.mustGet(run.id).config,
        usage: active.app.deskmates.ctx.db
          .prepare(
            "SELECT attempt,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens FROM run_usage WHERE run_id=?",
          )
          .all(run.id),
      });
    }
    expect(new Set(done.map((run) => run.sdkSessionId)).size).toBe(2);
    observations.push({
      event: "verified",
      logicalRuns: done.length,
      physicalSdkAttempts: actualRequests.length,
      upstreamMessages: upstream.requests.filter((r) => r.url?.split("?")[0] === "/v1/messages")
        .length,
    });
    saveProof();
  }, 240_000);
});
