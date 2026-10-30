// T0, issue #39 item 8: a model job on the openai-agents runtime ends on the Gateway's deadline
// (`modelJobDeadlineMs`, else the 55 s default) with the same error the Claude path reports, and
// sends no reasoning parameter (Chat Completions has no portable one).

import type { StartRunRequest } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "../../deps.js";
import { modelJobDeadlineError } from "../../model-job.js";
import { runOpenAiModelJob } from "./model-job.js";
import type { OpenAiCompletionParams } from "./types.js";

const request = (extra: Partial<StartRunRequest>): StartRunRequest =>
  ({
    runId: "run_job",
    runtime: "openai-agents",
    model: "m",
    modelBaseUrl: "http://proxy",
    modelAuthToken: "secret-test-token",
    trigger: { kind: "cron", prompt: "" },
    ...extra,
  }) as unknown as StartRunRequest;

/** A completion that never answers and rejects when the job's signal aborts. */
function hanging(seen: OpenAiCompletionParams[]): SidecarDeps["completeOpenAi"] {
  return (params) => {
    seen.push(params);
    return new Promise((_resolve, reject) => {
      params.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  };
}

describe("openai-agents model job deadline (issue #39 item 8)", () => {
  it("ends on the Gateway's deadline with the Claude path's error and no reasoning parameter", async () => {
    const seen: OpenAiCompletionParams[] = [];
    const deps = { completeOpenAi: hanging(seen) } as unknown as SidecarDeps;
    const ended = await runOpenAiModelJob(
      request({ modelJobDeadlineMs: 20, thinking: { type: "disabled" } }),
      { kind: "vision_probe", code: "4096" },
      deps,
      undefined,
    );
    expect(ended.outcome).toBe("failed");
    expect(ended.error).toBe(modelJobDeadlineError([], 20));
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "content",
      "maxOutputTokens",
      "model",
      "modelAuthToken",
      "modelBaseUrl",
      "signal",
      "systemPrompt",
    ]);
  });
});
