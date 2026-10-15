// T1: the streamed reply preview (ADR-0037 decisions 7 and 8). Only the summary block's `reply`
// string is decoded and posted, redacted and cumulative; frames coalesce behind a slow post; a
// refused post stops previews and never changes the run; the last frame lands before RunEnded.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  BotId,
  ReplyPreviewRequest,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { ReplyPreviewer, decodeReplySoFar } from "./reply-preview.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-preview-7c2d";
const HOME = "/home/nova";

function delta(text: string, parent: string | null = null): SDKMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: parent,
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "s",
  } as SDKMessage;
}

function blockStart(): SDKMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "s",
  } as unknown as SDKMessage;
}

describe("decodeReplySoFar", () => {
  it("decodes the reply string as far as it has arrived", () => {
    const block = '```json\n{"done": "said \\"reply\\": \\"x\\"", "reply": "Hel';
    expect(decodeReplySoFar(block)).toBe("Hel");
    expect(decodeReplySoFar(`${block}lo\\n\\"you\\" \\u00e9`)).toBe('Hello\n"you" é');
    expect(decodeReplySoFar(`${block}lo", "x": 1}`)).toBe("Hello");
  });

  it("waits for a partial escape and ignores text before the block", () => {
    expect(decodeReplySoFar('{"reply": "a\\')).toBe("a");
    expect(decodeReplySoFar('{"reply": "a\\u00')).toBe("a");
    expect(decodeReplySoFar('Prose "reply": "leak" ```json\n{"done": "d"')).toBeUndefined();
    expect(decodeReplySoFar("no key yet")).toBeUndefined();
  });
});

describe("ReplyPreviewer", () => {
  it("posts redacted cumulative snapshots and coalesces behind a slow post", async () => {
    const frames: ReplyPreviewRequest[] = [];
    let release: () => void = () => {};
    const previewer = new ReplyPreviewer({
      runId: "run-1" as RunId,
      attempt: 2,
      post: async (frame) => {
        frames.push(frame);
        if (frames.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
      redact: (text) => text.replaceAll("SECRET", "[redacted]"),
    });
    previewer.observe(delta('```json\n{"done": "x", "reply": "Hi'));
    previewer.observe(delta(" SECRET"));
    previewer.observe(delta(" there"));
    previewer.observe(delta(" there", "toolu_sub"));
    release();
    await previewer.flush();
    expect(frames).toEqual([
      { type: "reply_preview", runId: "run-1", attempt: 2, seq: 1, text: "Hi" },
      { type: "reply_preview", runId: "run-1", attempt: 2, seq: 2, text: "Hi [redacted] there" },
    ]);
  });

  it("starts over at a new content block and stops after a refused post", async () => {
    const frames: ReplyPreviewRequest[] = [];
    const previewer = new ReplyPreviewer({
      runId: "run-1" as RunId,
      attempt: 1,
      post: async (frame) => {
        frames.push(frame);
        throw new Error("404");
      },
      redact: (text) => text,
    });
    previewer.observe(delta('{"reply": "first'));
    await previewer.flush();
    previewer.observe(blockStart());
    previewer.observe(delta('{"reply": "second'));
    await previewer.flush();
    expect(frames.map((f) => f.text)).toEqual(["first"]);
  });
});

describe("runOnce reply preview", () => {
  function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
    return {
      runId: "run-preview" as RunId,
      botId: "bot-nova" as BotId,
      botName: "nova",
      workspaceId: "ws-1" as WorkspaceId,
      threadId: "thread-1" as ThreadId,
      botHomeDir: HOME,
      attempt: 1,
      trigger: {
        kind: "thread_message",
        thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
        messages: [
          {
            seq: 1,
            authorKind: "human",
            authorId: "alice",
            authorName: "Alice",
            body: "hi",
            attachments: [],
          },
        ],
        relayCount: 0,
      },
      model: "model-under-test",
      cheapModel: "cheap-model-under-test",
      modelBaseUrl: "http://gateway.test",
      modelAuthToken: TOKEN,
      gatewayBaseUrl: "http://gateway.test",
      shortWaitSeconds: 300,
      maxTurns: 50,
      egressAllowlist: [],
      connectors: [],
      tools: ["thread_post"],
      ...overrides,
    };
  }

  const block = (reply: string) =>
    `\`\`\`json\n${JSON.stringify({ done: "d", filesChanged: [], sitesVisited: [], pendingApprovals: [], learned: [], reply })}\n\`\`\``;

  async function play(
    script: ScriptStep[],
    overrides: Partial<StartRunRequest> = {},
    status = 200,
    withoutThread = false,
  ) {
    const sdk = createFakeSdk(script);
    const gateway = createFakeGateway({ egressAllowlist: () => [], replyPreviewStatus: status });
    const deps: SidecarDeps = {
      query: sdk.query,
      tool: sdk.tool,
      createSdkMcpServer: sdk.createSdkMcpServer,
      fetch: gateway.fetch,
      fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
      now: () => new Date("2026-10-14T10:00:00Z"),
      env: { PATH: "/usr/bin" },
      sleep: async () => {},
    };
    const req = request(overrides);
    if (withoutThread) req.threadId = undefined as unknown as ThreadId;
    const ended = await runOnce(req, deps, { approvalPollMs: 1, batchDelayMs: 1 });
    return { ended, gateway };
  }

  it("streams the reply of a thread run and finishes before RunEnded", async () => {
    const text = block(`Hello ${TOKEN} world`);
    const cut = text.indexOf("world");
    const { ended, gateway } = await play([
      { type: "streamed_text", chunks: [text.slice(0, cut), text.slice(cut)] },
      { type: "end", summary: text },
    ]);
    expect(ended.outcome).toBe("completed");
    expect(ended.summary?.reply).toContain("world");
    const texts = gateway.previews.map((p) => p.text);
    expect(texts.at(-1)).toBe("Hello [redacted] world");
    expect(texts.join("")).not.toContain(TOKEN);
    expect(gateway.previews.map((p) => p.seq)).toEqual(texts.map((_, i) => i + 1));
    const order = gateway.requests.map((r) => new URL(r.url).pathname.split("/").at(-1));
    expect(order.lastIndexOf("reply-preview")).toBeLessThan(order.indexOf("ended"));
  });

  it("sends nothing for a run without a thread and survives a refusing Gateway", async () => {
    const text = block("Hello");
    const script: ScriptStep[] = [
      { type: "streamed_text", chunks: [text] },
      { type: "end", summary: text },
    ];
    const noThread = await play(script, {}, 200, true);
    expect(noThread.gateway.previews).toEqual([]);
    const refused = await play(script, {}, 404);
    expect(refused.ended.outcome).toBe("completed");
    expect(refused.ended.summary?.reply).toBe("Hello");
  });
});
