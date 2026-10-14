// Actual SDK automatic compaction and production hook/ledger; synthetic usage, no real model.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { join } from "node:path";
import {
  type BotDefinition,
  type RunContextMetrics,
  type Workspace,
  botHomeDir,
} from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const marker = "M3_SYNTHETIC_AUTO_COMPACTION_MARKER";
const token = "fake-auto-compaction-only";
const injectedInputTokens = 195_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function hasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/** Alter only the first actual tool-response usage; no context setting or SDK message injection. */
function highUsage(text: string, streamed: boolean): string {
  if (!streamed) {
    const message = JSON.parse(text);
    message.usage.input_tokens = injectedInputTokens;
    return JSON.stringify(message);
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ")) return line;
      const data = JSON.parse(line.slice(6));
      if (data.type === "message_start") data.message.usage.input_tokens = injectedInputTokens;
      return `data: ${JSON.stringify(data)}`;
    })
    .join("\n");
}

describe.skipIf(!available)("M3 actual SDK automatic compaction (T2)", () => {
  let stack: Stack | undefined;
  let upstream: FakeModelUpstream | undefined;
  let bridge: Server | undefined;
  let mainRequests = 0;
  let summaryRequests = 0;
  const requests: Record<string, unknown>[] = [];

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: token,
      reply: "unused",
      script: (_turn, body) => {
        if (
          !body ||
          !hasTools(body) ||
          JSON.stringify(body.messages).includes(
            "Your task is to create a detailed summary of the conversation so far",
          )
        ) {
          summaryRequests += 1;
          return {
            kind: "text",
            text: `Synthetic compact summary: ${marker}; local progress is at /work/auto-compaction-progress.txt. Continue the declared local fixture task.`,
          };
        }
        mainRequests += 1;
        if (mainRequests === 1) {
          return {
            kind: "tool_use",
            name: "Bash",
            input: {
              command: `printf '${marker}\\n' > /work/auto-compaction-progress.txt${process.env.DESKMATES_QA_AUTO_COMPACT_DELAY === "2" ? "; sleep 2" : ""}`,
            },
          };
        }
        return { kind: "text", text: assistantText("AUTO_COMPACTION_PROTOCOL_OK") };
      },
    });
    const localUpstream = upstream;
    bridge = createServer((req, res) => {
      void (async () => {
        const raw = await bodyText(req);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const firstMain =
          req.method === "POST" &&
          new URL(req.url ?? "/", "http://fixture").pathname === "/v1/messages" &&
          hasTools(body) &&
          mainRequests === 0;
        const row = {
          method: req.method,
          path: req.url,
          requestSha256: hash(raw),
          systemSha256: hash(JSON.stringify(body.system ?? "")),
          hasTools: hasTools(body),
          containsMarker: raw.includes(marker),
          injectedInputTokens: firstMain ? injectedInputTokens : null,
          at: new Date().toISOString(),
        };
        requests.push(row);
        const evidenceDir = process.env.DESKMATES_QA_AUTO_COMPACT_DIR;
        if (evidenceDir)
          writeFileSync(
            join(evidenceDir, "upstream-requests.json"),
            JSON.stringify(requests, null, 2),
            { mode: 0o600 },
          );
        const forwarded = await fetch(localUpstream.url + (req.url ?? "/"), {
          method: req.method ?? "GET",
          headers: {
            authorization: req.headers.authorization ?? "",
            "content-type": "application/json",
          },
          ...(req.method === "POST" ? { body: raw } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await forwarded.text();
        res.writeHead(forwarded.status, {
          "content-type": forwarded.headers.get("content-type") ?? "application/json",
        });
        res.end(firstMain && forwarded.ok ? highUsage(text, body.stream === true) : text);
      })().catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      bridge?.once("error", reject);
      bridge?.listen(0, "127.0.0.1", resolve);
    });
    const address = bridge.address();
    if (!address || typeof address !== "object") throw Error("bridge has no address");
    stack = await startStack({
      modelBaseUrl: `http://127.0.0.1:${address.port}`,
      modelAuthToken: token,
      defaultModel: "fake-auto-compaction",
      cheapModel: "fake-auto-compaction",
      label: "m3-auto-compaction",
      botName: "autocompactcheck",
      soul: `# Local automatic compaction protocol fixture\nReport the declared local step. ${marker}\n`,
    });
    stack.config.maxTurns = 4;
    stack.config.runTimeoutSeconds = 120;
  }, 180_000);

  afterAll(async () => {
    try {
      await stopStack(stack);
    } finally {
      if (bridge) {
        bridge.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          bridge?.close((err) => (err ? reject(err) : resolve())),
        );
      }
      await upstream?.close();
    }
  }, 120_000);

  it("automatically archives the pre-boundary transcript and exposes matching production metrics", async () => {
    if (!stack) throw Error("auto-compaction stack missing");
    const s = stack;
    const task = await postMessage(
      s,
      `M3_AUTO_START: perform the declared local step containing ${marker}.`,
    );
    const run = await waitForRun(s, task.run.id, 120_000);
    await s.app.deskmates.scheduler.drain();
    expect(run.status).toBe("succeeded");
    expect(run.attempt).toBe(1);
    expect(run.config.maxTurns).toBe(4);
    expect(run.config.runTimeoutSeconds).toBe(120);
    expect(run.config).not.toHaveProperty("claudeCodeMaxContextTokens");
    expect(s.provider.sidecarRuns().filter((entry) => entry.request.runId === run.id)).toHaveLength(
      1,
    );
    const events = await runEvents(s, run.id);
    const evidenceDir = process.env.DESKMATES_QA_AUTO_COMPACT_DIR;
    if (evidenceDir)
      writeFileSync(
        join(evidenceDir, "observed-state.json"),
        JSON.stringify({ run, events, requests, mainRequests, realModelCalls: 0 }, null, 2),
        { mode: 0o600 },
      );
    const boundaries = events.filter((e) => e.kind === "compact_boundary");
    const archives = events.filter(
      (e) => e.payload.source === "pre_compact" && e.payload.op === "archived",
    );
    const flushes = events.filter(
      (e) => e.payload.source === "pre_compact" && e.payload.op === "memory_flush",
    );
    const diagnostics = await s.provider.exec(s.handle, {
      cmd: [
        "node",
        "-e",
        "const fs=require('fs'),p=require('path');const root=process.argv[1];const files=[];function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.jsonl'))files.push({path:f,bytes:fs.statSync(f).size,modifiedMs:fs.statSync(f).mtimeMs});}}walk(root);console.log(JSON.stringify(files));",
        botHomeDir(s.bot.name),
      ],
      timeoutMs: 10000,
    });
    if (evidenceDir)
      writeFileSync(join(evidenceDir, "post-run-transcripts.json"), diagnostics.stdout, {
        mode: 0o600,
      });
    expect(mainRequests).toBe(2);
    expect(summaryRequests).toBe(1);
    // The summary is a separate proxy request; only the two main responses are SDK turns.
    const proxyRequests = s.app.deskmates.ctx.modelRequests
      .list(run.id)
      .filter((r) => r.requestKind === "messages");
    const mainUsage = [proxyRequests[0], proxyRequests[2]].map((r) => ({
      inputTokens: r?.inputTokens,
      outputTokens: r?.outputTokens,
      cacheReadTokens: r?.cacheReadTokens,
      cacheCreateTokens: r?.cacheCreateTokens,
    }));
    const turnUsage = events.filter((e) => e.kind === "turn_usage");
    if (evidenceDir)
      writeFileSync(
        join(evidenceDir, "turn-usage-comparison.json"),
        JSON.stringify({ proxyRequests, mainUsage, turnUsage, realModelCalls: 0 }, null, 2),
        { mode: 0o600 },
      );
    expect(proxyRequests).toHaveLength(3);
    expect(turnUsage).toHaveLength(2);
    for (const [i, turn] of turnUsage.entries()) {
      expect(mainUsage[i]?.outputTokens).toBeGreaterThan(1);
      expect(turn.payload).toMatchObject(mainUsage[i] ?? {});
    }
    expect(boundaries).toHaveLength(1);
    expect(archives).toHaveLength(1);
    expect(flushes).toHaveLength(1);
    expect(boundaries[0]?.payload.trigger).toBe("auto");
    expect(archives[0]?.payload.trigger).toBe("auto");
    expect(archives[0]?.seq).toBeLessThan(boundaries[0]?.seq ?? 0);
    expect(
      events.filter((e) =>
        ["archive_failed", "memory_flush_failed"].includes(String(e.payload.op)),
      ),
    ).toHaveLength(0);
    const archivePath = String(archives[0]?.payload.archivePath);
    const session = run.sdkSessionId;
    expect(session).toBeTruthy();
    const copied = await s.provider.exec(s.handle, {
      cmd: [
        "node",
        "-e",
        `
const fs=require('fs'),p=require('path'),crypto=require('crypto');let input='';
process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const {archivePath,home,session,marker}=JSON.parse(input);
 const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=p.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name===session+'.jsonl')files.push(f);}}
 walk(p.join(home,'.claude','projects'));if(files.length!==1)throw Error('expected one session transcript');
 const archive=fs.readFileSync(archivePath,'utf8'),current=fs.readFileSync(files[0],'utf8');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 console.log(JSON.stringify({archiveSha256:hash(archive),currentSha256:hash(current),archiveChars:archive.length,
 prefixSha256:hash(current.slice(0,archive.length)),prefixMatches:current.startsWith(archive),archiveContainsMarker:archive.includes(marker),
 transcriptPath:files[0],archiveBase64:Buffer.from(archive).toString('base64'),transcriptBase64:Buffer.from(current).toString('base64')}));
});`,
      ],
      stdin: JSON.stringify({ archivePath, home: botHomeDir(s.bot.name), session, marker }),
      timeoutMs: 10_000,
    });
    expect(copied.exitCode).toBe(0);
    const proof = JSON.parse(copied.stdout) as {
      archiveSha256: string;
      currentSha256: string;
      archiveChars: number;
      prefixSha256: string;
      prefixMatches: boolean;
      archiveContainsMarker: boolean;
      transcriptPath: string;
      archiveBase64: string;
      transcriptBase64: string;
    };
    // Preserve the actual bytes before assertions, including a retained failed invocation.
    if (evidenceDir) {
      writeFileSync(
        join(evidenceDir, "archive.jsonl"),
        Buffer.from(proof.archiveBase64, "base64"),
        {
          mode: 0o600,
        },
      );
      writeFileSync(
        join(evidenceDir, "transcript.jsonl"),
        Buffer.from(proof.transcriptBase64, "base64"),
        {
          mode: 0o600,
        },
      );
    }
    const archivedMessages = Buffer.from(proof.archiveBase64, "base64")
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const originalTool = archivedMessages
      .filter((row) => row.type === "assistant" && Array.isArray(row.message?.content))
      .flatMap((row) => row.message.content)
      .find(
        (block: { type?: string; name?: string; input?: { command?: string } }) =>
          block.type === "tool_use" &&
          block.name === "Bash" &&
          block.input?.command?.includes(marker),
      );
    expect(originalTool?.id).toBeTruthy();
    const originalResult = archivedMessages
      .filter((row) => row.type === "user" && Array.isArray(row.message?.content))
      .flatMap((row) => row.message.content)
      .find(
        (block: { type?: string; tool_use_id?: string }) =>
          block.type === "tool_result" && block.tool_use_id === originalTool.id,
      );
    expect(originalResult).toBeDefined();
    expect(originalResult.is_error).toBe(false);
    expect(proof.archiveContainsMarker).toBe(true);
    expect(proof.archiveChars).toBe(archives[0]?.payload.chars);
    expect(proof.prefixMatches).toBe(true);
    expect(proof.prefixSha256).toBe(proof.archiveSha256);
    const context = await s.api<RunContextMetrics>("GET", `/api/runs/${run.id}/context`);
    expect(context.status).toBe(200);
    expect(context.json.compactions).toHaveLength(1);
    expect(context.json.compactions[0]?.trigger).toBe("auto");
    expect(context.json.peakInputTokens).toBeGreaterThanOrEqual(injectedInputTokens);
    expect(context.json.turns).toBe(2);
    expect(context.json.contextSections).not.toBeNull();
    expect(context.json.systemPromptSha256).toMatch(/^[a-f0-9]{64}$/);
    const tool = await s.provider.exec(s.handle, {
      cmd: ["cat", "/work/auto-compaction-progress.txt"],
      timeoutMs: 5000,
    });
    expect(tool.exitCode).toBe(0);
    expect(tool.stdout).toBe(`${marker}\n`);
    const directory = process.env.DESKMATES_QA_AUTO_COMPACT_DIR;
    if (directory) {
      writeFileSync(join(directory, "archive.jsonl"), Buffer.from(proof.archiveBase64, "base64"), {
        mode: 0o600,
      });
      writeFileSync(
        join(directory, "transcript.jsonl"),
        Buffer.from(proof.transcriptBase64, "base64"),
        { mode: 0o600 },
      );
      const { archiveBase64: _, transcriptBase64: __, ...metadata } = proof;
      writeFileSync(
        join(directory, "proof.json"),
        JSON.stringify(
          {
            run,
            workspaceId: s.workspace.id,
            session,
            metadata,
            context: context.json,
            events,
            requests,
            mainRequests,
            realModelCalls: 0,
            injectedInputTokens,
            contextLimitSettingChanged: false,
            retentionQualityMeasured: false,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      // Operator reads for an offline decision replay; no internal route or DB reconstruction.
      const [runDetail, botDetail, workspaceDetail] = await Promise.all([
        s.api<{ run: typeof run; usage?: unknown[] }>("GET", `/api/runs/${run.id}`),
        s.api<{ bot: BotDefinition }>("GET", `/api/bots/${s.bot.id}`),
        s.api<{ workspace: Workspace }>("GET", `/api/workspaces/${s.workspace.id}`),
      ]);
      for (const response of [runDetail, botDetail, workspaceDetail])
        expect(response.status).toBe(200);
      const bot = botDetail.json.bot;
      const workspace = workspaceDetail.json.workspace;
      writeFileSync(
        join(directory, "trace-source.json"),
        JSON.stringify(
          {
            gateway: s.gatewayUrl,
            exportedAt: new Date().toISOString(),
            run: runDetail.json.run,
            events,
            usage: runDetail.json.usage ?? [],
            bot: {
              id: bot.id,
              name: bot.name,
              workspaceId: bot.workspaceId,
              model: bot.model,
              connectors: bot.connectors,
            },
            workspace: { id: workspace.id, egressAllowlist: workspace.egressAllowlist },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  }, 180_000);
});
