// T1, ADR-0023 amendment 2, decisions 11 and 14 (issue #87): a run's vision policy is derived
// from its model's recorded capability at start, kept on resume, sent to the sidecar only when it
// withholds, and reported on the capabilities route. The fake provider plays the sidecar; the
// probe's request crosses the real model proxy so `supported` has its image evidence.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ModelCapabilityView,
  ModelPrice,
  RunId,
  StartRunRequest,
  Workspace,
} from "@deskmates/contracts";
import { isTerminal } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { visionStart } from "./vision-policy.js";

const price = (model: string): ModelPrice => ({
  model,
  inputPerM: 1,
  outputPerM: 2,
  cacheReadPerM: 0,
  cacheCreatePerM: 0,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

let upstream: Server | undefined;
let h: Harness | undefined;
let answer: (code: string) => string = (code) => code;
const requests: StartRunRequest[] = [];

async function startUpstream(): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const model = (JSON.parse(body) as { model?: string }).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", model, usage: { input_tokens: 900, output_tokens: 2 } }));
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function playSidecar(request: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  requests.push(request);
  if (request.modelJob?.kind === "vision_probe") {
    const res = await gw.model("/v1/messages", {
      model: request.model,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            { type: "text", text: "digits?" },
          ],
        },
      ],
    });
    await res.text();
  }
  const reply = request.modelJob?.kind === "vision_probe" ? answer(request.modelJob.code) : "ok";
  await gw.post("ended", {
    type: "run_ended",
    runId: request.runId,
    outcome: "completed",
    summary: {
      done: "done",
      reply,
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    },
    usage: [],
  });
}

afterEach(async () => {
  await h?.close();
  h = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  answer = (code) => code;
  requests.length = 0;
});

async function start(): Promise<Harness> {
  h = await startHarness({
    modelBaseUrl: await startUpstream(),
    visionProbe: "auto",
    modelPrices: [price("test-model-default"), price("test-model-cheap")],
  });
  h.provider.onRun(playSidecar);
  return h;
}

async function capabilities(harness: Harness, ws: Workspace): Promise<ModelCapabilityView[]> {
  return (
    await harness.api<{ capabilities: ModelCapabilityView[] }>(
      "GET",
      `/api/workspaces/${ws.id}/model-capabilities`,
    )
  ).json.capabilities;
}

/** Probe the default model with the chosen answer, then send one chat message; the chat run. */
async function chatRunAfterProbe(
  harness: Harness,
  probeAnswer: ((code: string) => string) | undefined,
): Promise<{ run: RunRecord; request: StartRunRequest; ws: Workspace; probeRunId?: RunId }> {
  const { thread, bot, workspace } = await harness.seed();
  const ctx = harness.app.deskmates.ctx;
  let probeRunId: RunId | undefined;
  if (probeAnswer) {
    answer = probeAnswer;
    const queued = ctx.modelJobs.vision.queue({
      workspaceId: bot.workspaceId,
      model: "test-model-default",
      trigger: "retry",
      requestedBy: "t",
    });
    probeRunId = queued.run?.id;
    harness.app.deskmates.scheduler.kick();
    await waitFor(
      async () =>
        (await capabilities(harness, workspace)).find((c) => c.model === "test-model-default")
          ?.vision.status !== "pending",
      3000,
      "probe settled",
    );
  }
  const m = await harness.api<{ runs: { id: string }[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "look at /work/chart.png" },
  );
  const runId = m.json.runs[0]?.id as RunId;
  await waitFor(() => isTerminal(ctx.runs.mustGet(runId).status), 3000, "chat run");
  const request = requests.find((r) => r.runId === runId) as StartRunRequest;
  return {
    run: ctx.runs.mustGet(runId),
    request,
    ws: workspace,
    ...(probeRunId ? { probeRunId } : {}),
  };
}

describe("run vision policy (amendment 2, decision 11)", () => {
  it("delivers on a verified model and sends no policy key", async () => {
    const { run, request } = await chatRunAfterProbe(await start(), (code) => code);
    expect(run.config.visionPolicy).toBe("deliver");
    expect(request.visionPolicy).toBeUndefined();
  });

  it("withholds on an explicit refusal and tells the sidecar", async () => {
    const { run, request } = await chatRunAfterProbe(await start(), () => "NO IMAGE");
    expect(run.config.modelCapabilities).toMatchObject({ vision: { status: "unsupported" } });
    expect(run.config.visionPolicy).toBe("withhold");
    expect(request.visionPolicy).toBe("withhold");
  });

  it("withholds after a confabulated answer without rewriting the evidence", async () => {
    const { run, request } = await chatRunAfterProbe(
      await start(),
      () => "GOING BEYOND COUNTING EYEBALLS",
    );
    expect(run.config.modelCapabilities).toMatchObject({
      vision: { status: "unknown", reason: "wrong_answer" },
    });
    expect(run.config.visionPolicy).toBe("withhold");
    expect(request.visionPolicy).toBe("withhold");
  });

  it("delivers unchanged on a model never probed", async () => {
    const { run, request } = await chatRunAfterProbe(await start(), undefined);
    expect(run.config.modelCapabilities).toMatchObject({
      vision: { status: "unknown", reason: "not_probed" },
    });
    expect(run.config.visionPolicy).toBe("deliver");
    expect(request.visionPolicy).toBeUndefined();
  });

  it("records no policy on the probe run itself", async () => {
    const { probeRunId } = await chatRunAfterProbe(await start(), () => "NO IMAGE");
    const probe = h?.app.deskmates.ctx.runs.mustGet(probeRunId as RunId);
    expect(probe?.config.visionPolicy).toBeUndefined();
    expect(requests.find((r) => r.runId === probeRunId)?.visionPolicy).toBeUndefined();
  });

  it("keeps the first attempt's policy on resume, and delivers for a run recorded before it", async () => {
    const harness = await start();
    const { run } = await chatRunAfterProbe(harness, () => "NO IMAGE");
    const ctx = harness.app.deskmates.ctx;
    const ws = ctx.bots.mustGet(run.botId).workspaceId;
    // A newer probe now says `supported`; the recorded run keeps what it started with.
    answer = (code) => code;
    ctx.modelJobs.vision.queue({
      workspaceId: ws,
      model: "test-model-default",
      trigger: "retry",
      requestedBy: "t",
    });
    harness.app.deskmates.scheduler.kick();
    await waitFor(
      () => ctx.modelJobs.vision.current(ws, "test-model-default").status === "supported",
      3000,
      "second probe",
    );
    expect(visionStart(ctx, run, ws, "test-model-default")).toEqual({
      patch: {},
      request: { visionPolicy: "withhold" },
    });
    const { visionPolicy: _dropped, ...legacyConfig } = run.config;
    const legacy: RunRecord = { ...run, config: legacyConfig };
    expect(visionStart(ctx, legacy, ws, "test-model-default")).toEqual({
      patch: { visionPolicy: "deliver" },
      request: {},
    });
  });
});

describe("capabilities route (decision 14)", () => {
  it("returns each model's policy and the bots that use it", async () => {
    const harness = await start();
    const { ws } = await chatRunAfterProbe(harness, () => "NO IMAGE");
    const list = await capabilities(harness, ws);
    const bot = harness.app.deskmates.ctx.bots.list(ws.id)[0];
    expect(list.find((c) => c.model === "test-model-default")).toMatchObject({
      visionPolicy: "withhold",
      botIds: [bot?.id],
    });
  });
});
