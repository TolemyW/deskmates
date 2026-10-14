// T1: `POST /hooks/:botId/:token` (design v0.3 §3.4). The run row exists before the sidecar
// does, the body reaches the trigger byte for byte, and the token, the size limit and the queue
// cap are enforced at the edge (test strategy §4.2 "queue cap").

import type { BotDefinition, StartRunRequest, Workspace } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import type { RunRecord } from "../ledger/runs.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import type { SidecarScript } from "../test-support/fake-provider.js";
import { type Harness, openSse, startHarness, waitFor } from "../test-support/harness.js";

const FINISH: SidecarScript = async (req, gw) => {
  await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    usage: [],
    summary: {
      done: "handled the hook",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "",
    },
  });
  return undefined;
};

interface SeededBot {
  bot: BotDefinition;
  token: string;
}

let h: Harness;

async function seedWebhookBot(harness: Harness, name = "hookbot"): Promise<SeededBot> {
  const ws = await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name: `ws-${name}`,
  });
  const token = newWebhookToken();
  const bot = harness.app.deskmates.ctx.bots.create({
    name,
    role: "hooks",
    workspaceId: ws.json.workspace.id,
    webhookTokenHash: hashWebhookToken(token),
  });
  return { bot, token };
}

async function hook(
  harness: Harness,
  botId: string,
  token: string,
  body: string,
  contentType = "text/plain",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${harness.baseUrl}/hooks/${botId}/${token}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

beforeEach(async () => {
  h = await startHarness();
  h.provider.onRun(FINISH);
});

afterEach(async () => {
  await h.close();
});

describe("webhook trigger", () => {
  it("creates the run row first, then hands the raw body to the sidecar", async () => {
    const { bot, token } = await seedWebhookBot(h);
    const started: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      started.push(req);
      return FINISH(req, gw);
    });

    const res = await hook(h, bot.id, token, "hello <script>");
    expect(res.status).toBe(202);
    const runId = res.json.runId as string;
    expect(runId).toBeTruthy();

    const run = h.app.deskmates.ctx.runs.mustGet(runId as RunRecord["id"]);
    expect(run).toMatchObject({ lane: "background", triggerKind: "webhook" });
    expect(run.triggerRef).toMatch(/^whk_/);
    expect(run.threadId).toBeUndefined();
    expect(run.triggerPayload).toMatchObject({
      body: "hello <script>",
      contentType: "text/plain",
    });
    expect(run.config).toMatchObject({ webhookBodyMaxBytes: 65536, webhookQueueMax: 20 });

    await waitFor(() => started.length === 1, 3000, "the webhook run to be exec'd");
    await h.app.deskmates.scheduler.drain();
    const request = started[0] as StartRunRequest;
    expect(request.trigger).toEqual({ kind: "webhook", body: "hello <script>" });
    expect(request.tools).toEqual(sidecarToolsFor(false, run.config));
    expect(request.threadId).toBeUndefined();
    expect(request.sdkSessionId).toBeUndefined();
  });

  it("publishes the queued run_status frame like a thread wake does", async () => {
    const { bot, token } = await seedWebhookBot(h);
    const sse = await openSse(h.baseUrl);
    try {
      const res = await hook(h, bot.id, token, "ping");
      const runId = res.json.runId as string;
      await waitFor(
        () =>
          sse.events.some(
            (e) => e.type === "run_status" && e.run.id === runId && e.run.status === "queued",
          ),
        3000,
        "a queued run_status frame for the webhook run",
      );
      await h.app.deskmates.scheduler.drain();
      const statuses = sse.events
        .filter((e) => e.type === "run_status" && e.run.id === runId)
        .map((e) => (e.type === "run_status" ? e.run.status : ""));
      expect(statuses.slice(0, 2)).toEqual(["queued", "running"]);
    } finally {
      sse.close();
    }
  });

  it("delivers a JSON body as its raw text, one run per delivery", async () => {
    const { bot, token } = await seedWebhookBot(h);
    const bodies = ['{"alert":"disk","pct":91}', '{"alert":"disk","pct":92}'];
    const ids: string[] = [];
    for (const body of bodies) {
      const res = await hook(h, bot.id, token, body, "application/json");
      expect(res.status).toBe(202);
      ids.push(res.json.runId as string);
    }
    expect(new Set(ids).size).toBe(2);
    const stored = ids.map((id) => h.app.deskmates.ctx.runs.mustGet(id as RunRecord["id"]));
    expect(stored.map((r) => r.triggerPayload?.body)).toEqual(bodies);
    await h.app.deskmates.scheduler.drain();
  });

  it("answers a wrong token and an unknown bot with the same 404", async () => {
    const { bot, token } = await seedWebhookBot(h);
    const wrong = await hook(h, bot.id, `${token}x`, "x");
    const missing = await hook(h, "bot_does_not_exist", token, "x");
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(wrong.json).toEqual(missing.json);
    expect(wrong.json.code).toBe("not_found");
    expect(h.app.deskmates.ctx.runs.list({ botId: bot.id })).toHaveLength(0);
  });

  it("rejects a body over the size limit with 413 and creates no run", async () => {
    const small = await startHarness({ webhookBodyMaxBytes: 64 });
    try {
      small.provider.onRun(FINISH);
      const { bot, token } = await seedWebhookBot(small);
      const res = await hook(small, bot.id, token, "x".repeat(65));
      expect(res.status).toBe(413);
      expect(small.app.deskmates.ctx.runs.list({ botId: bot.id })).toHaveLength(0);
      // The limit itself still admits a body of exactly the cap.
      expect((await hook(small, bot.id, token, "y".repeat(64))).status).toBe(202);
      await small.app.deskmates.scheduler.drain();
    } finally {
      await small.close();
    }
  });

  it("stops accepting deliveries once the bot's queue is full", async () => {
    const capped = await startHarness({ webhookQueueMax: 3 });
    try {
      capped.provider.onRun(async () => new Promise(() => {}));
      const { bot, token } = await seedWebhookBot(capped);
      let rejected: { status: number; json: Record<string, unknown> } | undefined;
      for (let i = 0; i < 8 && !rejected; i += 1) {
        const res = await hook(capped, bot.id, token, `delivery ${i}`);
        if (res.status !== 202) rejected = res;
      }
      expect(rejected?.status).toBe(429);
      expect(rejected?.json.code).toBe("queue_full");
      expect(capped.app.deskmates.ctx.runs.countQueued(bot.id, "webhook")).toBe(3);
    } finally {
      capped.app.deskmates.scheduler.stop();
      await capped.app.close();
    }
  });

  it("rotates the token, invalidating the previous one, and never exposes it on the bot", async () => {
    const { bot, token } = await seedWebhookBot(h);
    const rotated = await h.api<{ webhookToken: string }>(
      "POST",
      `/api/bots/${bot.id}/webhook-token`,
      {},
    );
    expect(rotated.status).toBe(200);
    expect(rotated.json.webhookToken).not.toBe(token);

    expect((await hook(h, bot.id, token, "old")).status).toBe(404);
    expect((await hook(h, bot.id, rotated.json.webhookToken, "new")).status).toBe(202);

    const read = await h.api<{ bot: BotDefinition }>("GET", `/api/bots/${bot.id}`);
    const serialized = JSON.stringify(read.json);
    expect(serialized).not.toContain(rotated.json.webhookToken);
    expect(serialized).not.toContain("webhookToken");
    expect(serialized).not.toContain("webhook_token_hash");
    expect(serialized).not.toContain("webhookTokenHash");
    await h.app.deskmates.scheduler.drain();
  });
});
