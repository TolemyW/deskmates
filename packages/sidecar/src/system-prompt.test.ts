// T0: the system prompt split at the SDK's dynamic boundary (ADR-0023 amendment 5, decision 23).
// The static part is byte-stable across runs of a bot, whatever its memory, diary or index; the
// sections chosen per run sit after the marker; the joined text is the prompt every earlier run
// sent, so the split moves no byte the model reads.

import { createHash } from "node:crypto";
import type {
  BotId,
  PinnedCandidate,
  RunId,
  StartRunRequest,
  ThreadId,
  TriggerPayload,
  WorkspaceId,
} from "@deskmates/contracts";
import { assemblePinnedIndex } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  sdkSystemPrompt,
  systemPromptText,
} from "./system-prompt.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";
import { VISION_WITHHELD_GUIDANCE } from "./vision-withhold.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const cron: TriggerPayload = { kind: "cron", prompt: "Review the queue." };

function request(over: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-split" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "workspace-split" as WorkspaceId,
    threadId: "thread-1" as ThreadId,
    botHomeDir: "/home/nova",
    attempt: 1,
    trigger: cron,
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
    workdirMode: "per-bot",
    ...over,
  };
}

function pinned(id: string, body: string): PinnedCandidate {
  return {
    id,
    version: 1,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    observedAt: "2026-10-01T00:00:00.000Z",
    tombstoned: false,
  };
}

describe("the static part of the system prompt", () => {
  it("hashes the same across two runs of a bot with a different diary, memory and index", async () => {
    const one = await buildContext(
      request({
        runId: "run-a" as RunId,
        memoryIndex: assemblePinnedIndex(
          [pinned("w1", "S3 egress is billed separately.")],
          new Date("2026-10-15T00:00:00Z"),
        ),
      }),
      createMemoryFs({
        "/home/nova/SOUL.md": "You are Nova.",
        "/home/nova/MEMORY.md": "Tickets close on Fridays.",
        "/home/nova/memory/2026-10-15.md": "- 09:00 run r1 (cron) completed",
      }),
      new Date("2026-10-15T12:00:00Z"),
    );
    const two = await buildContext(
      request({
        runId: "run-b" as RunId,
        attempt: 2,
        memoryIndex: assemblePinnedIndex(
          [pinned("w2", "case_id is at most 12 characters.")],
          new Date("2026-10-16T00:00:00Z"),
        ),
      }),
      createMemoryFs({
        "/home/nova/SOUL.md": "You are Nova.",
        "/home/nova/MEMORY.md": "Something else entirely.",
        "/home/nova/memory/2026-10-16.md": "- 10:00 run r2 (cron) failed",
      }),
      new Date("2026-10-16T12:00:00Z"),
    );
    expect(two.systemPromptStaticSha256).toBe(one.systemPromptStaticSha256);
    expect(one.systemPromptStaticSha256).toBe(sha(one.systemPromptParts.static));
    expect(one.systemPromptParts.dynamic).toEqual([]);
    expect(one).not.toHaveProperty("systemPromptDynamicSha256");
    // The per-run text went to the first user turn, not into either part.
    expect(one.prompt).toContain("S3 egress is billed separately.");
    expect(one.systemPromptParts.static).not.toContain("S3 egress");
    expect(one.systemPromptParts.static).not.toContain("Tickets close");
  });

  it("puts a withheld-image notice after the boundary and keeps the static hash", async () => {
    const fs = () => createMemoryFs({ "/home/nova/SOUL.md": "You are Nova." });
    const now = new Date("2026-10-16T12:00:00Z");
    const seeing = await buildContext(request(), fs(), now);
    const blind = await buildContext(request({ visionPolicy: "withhold" }), fs(), now);
    expect(blind.systemPromptStaticSha256).toBe(seeing.systemPromptStaticSha256);
    expect(blind.systemPromptParts.dynamic).toEqual([VISION_WITHHELD_GUIDANCE]);
    expect(blind.systemPromptDynamicSha256).toBe(sha(VISION_WITHHELD_GUIDANCE));
    expect(blind.systemPromptSha256).not.toBe(seeing.systemPromptSha256);
  });

  it("joins back to exactly the system prompt the run reports, with and without a dynamic part", async () => {
    const now = new Date("2026-10-16T12:00:00Z");
    for (const over of [{}, { visionPolicy: "withhold" as const }]) {
      const context = await buildContext(
        request(over),
        createMemoryFs({ "/home/nova/SOUL.md": "You are Nova." }),
        now,
      );
      const option = sdkSystemPrompt(context.systemPromptParts);
      expect(systemPromptText(option)).toBe(context.systemPrompt);
      expect(sha(systemPromptText(option))).toBe(context.systemPromptSha256);
    }
  });
});

describe("the SDK option", () => {
  it("is a custom prompt recorded once per session, the boundary a block of its own", () => {
    expect(sdkSystemPrompt({ static: "S", dynamic: ["D1", "D2"] })).toEqual({
      type: "custom",
      prompt: ["S", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "D1", "D2"],
      snapshot: true,
    });
    expect(sdkSystemPrompt({ static: "S", dynamic: [] })).toEqual({
      type: "custom",
      prompt: ["S", SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
      snapshot: true,
    });
  });

  it("reads a string, a block list and a custom prompt as their text", () => {
    expect(systemPromptText("plain")).toBe("plain");
    expect(systemPromptText(["a", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "b"])).toBe("a\n\nb");
    expect(systemPromptText({ type: "custom", prompt: "c" })).toBe("c");
    expect(systemPromptText(undefined)).toBe("");
  });
});
