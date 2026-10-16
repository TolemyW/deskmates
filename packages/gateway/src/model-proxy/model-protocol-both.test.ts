// T1: an upstream that speaks both protocols (ADR-0044 decision 5): the same model id serves a
// bot on the default runtime over `/v1/messages` and one on the OpenAI runtime over `/v1/chat/completions`, which
// is what a paired comparison of the two runtimes on one model needs.

import { type BotDefinition, type RunId, type Thread, isTerminal } from "@deskmates/contracts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry, upstreamSpeaks } from "../config/model-upstreams.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let fake: FakeOpenAiServer;
let h: Harness;

beforeEach(async () => {
  fake = await startFakeOpenAiServer({ steps: () => ({ text: "from the dual endpoint" }) });
  // The default upstream is the fake, declared as speaking both protocols.
  h = await startHarness({ modelBaseUrl: fake.baseUrl, modelProtocol: "both" });
});

afterEach(async () => {
  await h.close();
  await fake.close();
});

describe("MODEL_PROTOCOL=both", () => {
  it("resolves the default models as speaking both protocols", () => {
    const registry = new ModelRegistry({
      modelBaseUrl: "http://gw.test",
      modelAuthToken: "t",
      modelProtocol: "both",
      defaultModel: "m",
      cheapModel: "c",
    });
    const upstream = registry.resolve("m");
    expect(upstream?.protocol).toBe("both");
    expect(upstreamSpeaks(upstream as { protocol: "both" }, "anthropic")).toBe(true);
    expect(upstreamSpeaks(upstream as { protocol: "both" }, "openai")).toBe(true);
    expect(upstreamSpeaks({ protocol: "anthropic" }, "openai")).toBe(false);
  });

  it("lets a bot take the openai-agents runtime on the default models, and the proxy forwards its turns", async () => {
    const { workspace } = await h.seed();
    const created = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "dual",
      workspaceId: workspace.id,
      runtime: "openai-agents",
      welcome: false,
    });
    expect(created.status).toBe(201);
    expect(created.json.bot.model).toBeUndefined();
    const thread = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [created.json.bot.id],
    }) as Thread;
    const m = await h.api<{ runs: { id: string }[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: "hi",
      },
    );
    const runId = m.json.runs[0]?.id as RunId;
    await waitFor(() => isTerminal(h.app.deskmates.ctx.runs.mustGet(runId).status), 2000, "run");
    expect(h.app.deskmates.ctx.runs.mustGet(runId).config.runtime).toBe("openai-agents");
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({
        model: "test-model-default",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message
        .content,
    ).toBe("from the dual endpoint");
    // The Anthropic path is admitted too (the fake answers 404, but the proxy forwarded it).
    const other = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: "test-model-default", messages: [] }),
    });
    expect(other.status).toBe(404);
    expect(fake.requests).toHaveLength(1);
  });
});
