// T1: a bot's `runtime` (ADR-0042 decisions 1, 6 and 7): accepted and audited through the bot
// routes, refused when its model's upstream speaks the other protocol, frozen on every run row
// and handed to the sidecar, and sessions kept per runtime.

import type { BotDefinition, BotId, ThreadId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
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

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    modelPrices: [priced(OAI), priced("model-swapped")],
    modelUpstreams: [
      { id: "oai", baseUrl: "http://127.0.0.1:1", models: [OAI], protocol: "openai" },
    ],
  });
});

afterEach(async () => {
  await h.close();
});

describe("bot runtime", () => {
  it("is stored at create, read back, audited, and cleared with null", async () => {
    const { workspace } = await h.seed();
    const created = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "oai",
      workspaceId: workspace.id,
      model: OAI,
      runtime: "openai-agents",
      welcome: false,
    });
    expect(created.status).toBe(201);
    expect(created.json.bot.runtime).toBe("openai-agents");
    const got = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${created.json.bot.id}`);
    expect(got.json.bot.runtime).toBe("openai-agents");

    // Back to the installation default: the model must then fit the Claude SDK's protocol.
    const mismatch = await h.api("PATCH", `/api/bots/${created.json.bot.id}`, { runtime: null });
    expect(mismatch.status).toBe(400);
    const cleared = await h.api<{ bot: BotDefinition }>(
      "PATCH",
      `/api/bots/${created.json.bot.id}`,
      {
        runtime: null,
        model: "model-swapped",
      },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.bot.runtime).toBeUndefined();
    expect(cleared.json.bot.model).toBe("model-swapped");
    const audit = h.app.deskmates.ctx.db
      .prepare("SELECT after_json FROM audit_events WHERE action = 'bot.update' ORDER BY seq DESC")
      .get() as { after_json: string };
    expect(JSON.parse(audit.after_json)).toMatchObject({ runtime: null, model: "model-swapped" });
  });

  it("refuses a runtime whose model is served over the other protocol, and an unknown runtime", async () => {
    const { workspace, bot } = await h.seed();
    const withDefaultModel = await h.api("POST", "/api/bots", {
      name: "oai2",
      workspaceId: workspace.id,
      runtime: "openai-agents",
      welcome: false,
    });
    expect(withDefaultModel.status).toBe(400);
    expect(JSON.stringify((withDefaultModel.json as { message?: string }).message)).toContain(
      "openai-protocol upstream",
    );
    const patch = await h.api("PATCH", `/api/bots/${bot.id}`, { runtime: "openai-agents" });
    expect(patch.status).toBe(400);
    const unknown = await h.api("PATCH", `/api/bots/${bot.id}`, { runtime: "codex" });
    expect(unknown.status).toBe(400);
    // A bot on the default runtime cannot take a model on an openai upstream either.
    const model = await h.api("PATCH", `/api/bots/${bot.id}`, { model: OAI });
    expect(model.status).toBe(400);
  });

  it("is frozen on the run row and handed to the sidecar; the default is recorded too", async () => {
    const { workspace, thread: defaultThread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "ok",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
        usage: [],
        sdkSessionId: "sess-1",
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${defaultThread.id}/messages`,
      { body: "x" },
    );
    const defaultRun = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(defaultRun.id).status === "succeeded",
      3000,
      "run",
    );
    // Frozen at start, beside the models (ADR-0023 decision 1), not at creation.
    expect(h.app.deskmates.ctx.runs.mustGet(defaultRun.id).config.runtime).toBe("claude-agent-sdk");
    expect(h.provider.execCalls[0]?.request.runtime).toBe("claude-agent-sdk");

    const created = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
      name: "oai",
      workspaceId: workspace.id,
      model: OAI,
      runtime: "openai-agents",
      welcome: false,
    });
    const botId = created.json.bot.id as BotId;
    const thread = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [botId],
    });
    const second = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      {
        body: "y",
      },
    );
    const run = second.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    const frozen = h.app.deskmates.ctx.runs.mustGet(run.id).config;
    expect(frozen.runtime).toBe("openai-agents");
    expect(frozen.model).toBe(OAI);
    const request = h.provider.execCalls.at(-1)?.request;
    expect(request?.runtime).toBe("openai-agents");
    expect(request?.sdkSessionId).toBeUndefined();
    // Decision 6: the session the run left belongs to its runtime.
    const sessions = h.app.deskmates.ctx.sessions;
    expect(sessions.get(botId, thread.id as ThreadId, "openai-agents")).toBe("sess-1");
    expect(sessions.get(botId, thread.id as ThreadId, "claude-agent-sdk")).toBeUndefined();
    expect(sessions.get(botId, thread.id as ThreadId)).toBeUndefined();
  });
});
