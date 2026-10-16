// Model jobs and presentation summaries on the `openai-agents` runtime (ADR-0044 decision 7, as
// amended): one tool-free Chat Completions turn through the Gateway's model proxy, composed into
// the same `RunEnded` the Claude path produces (`model-job.ts`, `presentation-summary.ts`), so
// the Gateway's job modules read either the same way.

import {
  ACTIVITY_SUMMARY_SOURCE_MAX,
  type ModelJobRequest,
  type RunEnded,
  type StartRunRequest,
  type TurnUsagePayload,
  boundActivitySummary,
} from "@deskmates/contracts";
import type { SidecarDeps } from "../../deps.js";
import type { EventSink } from "../../ledger.js";
import { MODEL_JOB_DEADLINE_MS, jobPrompt } from "../../model-job.js";
import { ACTIVITY_INSTRUCTION, APPROVAL_INSTRUCTION } from "../../presentation-summary.js";
import { redactText } from "../../redact.js";
import type { OpenAiCompletionParams, OpenAiCompletionResult } from "./types.js";

type Sink = Pick<EventSink, "emit"> | undefined;

/** One turn, with the deadline, usage and ledger events the Claude path records. */
async function oneTurn(
  request: StartRunRequest,
  deps: SidecarDeps,
  sink: Sink,
  turn: Omit<OpenAiCompletionParams, "modelBaseUrl" | "modelAuthToken" | "model" | "signal">,
  deadlineMs: number,
): Promise<{ ended: RunEnded; result?: OpenAiCompletionResult }> {
  const ended: RunEnded = { type: "run_ended", runId: request.runId, outcome: "failed", usage: [] };
  if (deps.completeOpenAi === undefined) {
    ended.error = "this sidecar cannot host the openai-agents runtime (ADR-0044)";
    return { ended };
  }
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), deadlineMs);
  try {
    const result = await deps.completeOpenAi({
      ...turn,
      modelBaseUrl: request.modelBaseUrl,
      modelAuthToken: request.modelAuthToken,
      model: request.model,
      signal: abort.signal,
    });
    const usage: TurnUsagePayload = {
      model: result.model,
      turn: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadInputTokens,
      cacheCreateTokens: 0,
    };
    sink?.emit("turn_usage", { ...usage });
    ended.usage = [
      {
        model: request.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadInputTokens,
        cacheCreateTokens: 0,
      },
    ];
    if (result.text.trim())
      sink?.emit("log", {
        source: "assistant",
        text: redactText(result.text, [request.modelAuthToken]),
      });
    return { ended, result };
  } catch (error) {
    ended.error = abort.signal.aborted
      ? `model job deadline of ${deadlineMs} ms reached`
      : redactText(String(error), [request.modelAuthToken]);
    return { ended };
  } finally {
    clearTimeout(deadline);
  }
}

export async function runOpenAiModelJob(
  request: StartRunRequest,
  job: ModelJobRequest,
  deps: SidecarDeps,
  sink: Sink,
): Promise<RunEnded> {
  const prompt = jobPrompt(job);
  sink?.emit("log", { source: "model_job", kind: job.kind });
  const content: OpenAiCompletionParams["content"] = [];
  const blocks =
    typeof prompt.content === "string" ? [{ type: "text", text: prompt.content }] : prompt.content;
  for (const block of blocks as Record<string, unknown>[]) {
    if (block.type === "text" && typeof block.text === "string")
      content.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      const source = block.source as { media_type?: unknown; data?: unknown } | undefined;
      if (typeof source?.data === "string")
        content.push({
          type: "image",
          mediaType: typeof source.media_type === "string" ? source.media_type : "image/png",
          base64: source.data,
        });
    }
  }
  const { ended, result } = await oneTurn(
    request,
    deps,
    sink,
    { systemPrompt: prompt.systemPrompt, content, maxOutputTokens: prompt.maxOutputTokens },
    MODEL_JOB_DEADLINE_MS,
  );
  if (result?.text.trim()) {
    ended.outcome = "completed";
    ended.summary = {
      done: prompt.done,
      reply: redactText(result.text.trim(), [request.modelAuthToken]).slice(
        0,
        prompt.maxReplyChars,
      ),
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    };
  }
  if (ended.outcome !== "completed") ended.error ??= "The model returned no answer";
  return ended;
}

export async function openAiPresentationSummary(
  request: StartRunRequest,
  deps: SidecarDeps,
  sink: Sink,
): Promise<RunEnded> {
  const activity = request.presentationKind === "activity";
  const source = redactText(request.trigger.kind === "cron" ? request.trigger.prompt : "", [
    request.modelAuthToken,
  ]).slice(0, activity ? ACTIVITY_SUMMARY_SOURCE_MAX : 12000);
  const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const { ended, result } = await oneTurn(
    request,
    deps,
    sink,
    {
      systemPrompt: activity ? ACTIVITY_INSTRUCTION : APPROVAL_INSTRUCTION,
      content: [
        {
          type: "text",
          text: `<untrusted source="${activity ? "activity" : "approval"}">${escaped}</untrusted>`,
        },
      ],
      maxOutputTokens: activity ? 256 : 512,
    },
    45_000,
  );
  if (result?.text.trim()) {
    const redacted = redactText(result.text.trim(), [request.modelAuthToken]);
    ended.outcome = "completed";
    ended.summary = {
      done: activity ? "Activity summary" : "Approval presentation summary",
      reply: activity ? boundActivitySummary(redacted) : redacted.slice(0, 700),
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    };
  }
  return ended;
}
