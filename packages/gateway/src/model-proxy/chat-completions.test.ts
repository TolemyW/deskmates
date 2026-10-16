// T1: the model proxy's OpenAI Chat Completions path (ADR-0042 decision 5): forwarded only to an
// `openai` upstream, with the frozen-model check and OpenAI-shaped usage recorded; `/v1/messages`
// for a model on an `openai` upstream is refused, never translated.

import { type BotDefinition, type RunId, type Thread, isTerminal } from "@deskmates/contracts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const OAI = "oai-model";

const priced = (model: string) => ({
  model,
  inputPerM: 1,
  outputPerM: 1,
  cacheReadPerM: 1,
  cacheCreatePerM: 1,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

let fake: FakeOpenAiServer;
let h: Harness;

beforeEach(async () => {
  fake = await startFakeOpenAiServer({
    steps: () => ({ text: "hello from the fake" }),
    usage: { promptTokens: 120, completionTokens: 9, cachedTokens: 100 },
    servedModel: `${OAI}-served`,
  });
  h = await startHarness({
    modelPrices: [priced(OAI), priced("oai-cheap")],
    modelUpstreams: [
      { id: "oai", baseUrl: fake.baseUrl, models: [OAI, "oai-cheap"], protocol: "openai" },
    ],
  });
});

afterEach(async () => {
  await h.close();
  await fake.close();
});

/** A run frozen on the OpenAI model: a bot on the `openai-agents` runtime, woken once. */
async function openAiRunId(): Promise<RunId> {
  const { workspace } = await h.seed();
  const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: "oai",
    workspaceId: workspace.id,
    model: OAI,
    runtime: "openai-agents",
    welcome: false,
  });
  expect(bot.status).toBe(201);
  const thread = h.app.deskmates.ctx.threads.create({
    workspaceId: workspace.id,
    botIds: [bot.json.bot.id],
  }) as Thread;
  const m = await h.api<{ runs: { id: string }[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "hi",
  });
  const runId = m.json.runs[0]?.id as RunId;
  await waitFor(() => isTerminal(h.app.deskmates.ctx.runs.mustGet(runId).status), 2000, "run end");
  return runId;
}

async function post(runId: RunId, path: string, body: Record<string, unknown>) {
  const issued = h.app.deskmates.ctx.tokens.issue(runId);
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify(body),
  });
}

function rows(runId: RunId) {
  return h.app.deskmates.ctx.modelRequests.list(runId);
}

describe("model proxy: /v1/chat/completions", () => {
  it("forwards to the openai upstream with its token and records the OpenAI usage shape", async () => {
    const runId = await openAiRunId();
    const res = await post(runId, "/v1/chat/completions", {
      model: OAI,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(answer.choices[0]?.message.content).toBe("hello from the fake");
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    await waitFor(() => rows(runId)[0]?.inputTokens !== null, 2000, "usage row");
    expect(rows(runId)[0]).toMatchObject({
      requestKind: "messages",
      model: OAI,
      stream: false,
      imageBlocks: 1,
      inputTokens: 120,
      outputTokens: 9,
      cacheReadTokens: 100,
      servedModel: `${OAI}-served`,
    });
  });

  it("records a streamed completion's usage from its last chunk", async () => {
    const runId = await openAiRunId();
    const res = await post(runId, "/v1/chat/completions", {
      model: OAI,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("data: [DONE]");
    await waitFor(() => rows(runId)[0]?.outputTokens === 9, 2000, "usage row");
    expect(rows(runId)[0]).toMatchObject({ stream: true, inputTokens: 120, cacheReadTokens: 100 });
  });

  it("refuses the Anthropic path for a model on an openai upstream, and the reverse", async () => {
    const runId = await openAiRunId();
    const wrong = await post(runId, "/v1/messages", { model: OAI, messages: [] });
    expect(wrong.status).toBe(503);
    expect(wrong.headers.get("x-should-retry")).toBe("false");
    expect(await wrong.json()).toMatchObject({
      code: "model_upstream_missing",
      details: { model: OAI, protocol: "openai", expected: "anthropic" },
    });
    // The run's cheap model sits on the default (anthropic) upstream.
    const reverse = await post(runId, "/v1/chat/completions", {
      model: "test-model-cheap",
      messages: [],
    });
    expect(reverse.status).toBe(503);
    expect(await reverse.json()).toMatchObject({
      details: { protocol: "anthropic", expected: "openai" },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("still applies the frozen-model check", async () => {
    const runId = await openAiRunId();
    const res = await post(runId, "/v1/chat/completions", { model: "other", messages: [] });
    expect(res.status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });
});
