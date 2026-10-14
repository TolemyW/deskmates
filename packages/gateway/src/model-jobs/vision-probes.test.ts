// T0/T1, ADR-0023 amendment 1 decisions 5 to 9 (issue #87): the vision probe lifecycle. The fake
// provider plays the sidecar: it sends the probe's request through the real model proxy to a fake
// upstream, so the image evidence the grade needs is the one the proxy recorded, then reports the
// answer the test chose.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  BotDefinition,
  ModelCapabilityView,
  ModelPrice,
  RunId,
  StartRunRequest,
  VisionProbeView,
  Workspace,
} from "@deskmates/contracts";
import { isTerminal } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { endpointSha256, gradeVisionAnswer } from "./vision-probes.js";

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

async function startUpstream(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const model = (JSON.parse(body) as { model?: string }).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: "msg_1", model, usage: { input_tokens: 1200, output_tokens: 3 } }),
      );
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Behaviour = "image" | "text-only" | "fail";
let answer: (request: StartRunRequest) => string = (r) =>
  r.modelJob?.kind === "vision_probe" ? r.modelJob.code : "";
let behaviour: Behaviour = "image";
const probeRequests: StartRunRequest[] = [];

async function playSidecar(request: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  if (request.modelJob?.kind !== "vision_probe") {
    await gw.post("ended", {
      type: "run_ended",
      runId: request.runId,
      outcome: "completed",
      usage: [],
    });
    return;
  }
  probeRequests.push(request);
  if (behaviour === "fail") {
    await gw.post("ended", {
      type: "run_ended",
      runId: request.runId,
      outcome: "failed",
      error: "API Error: 401 token rejected",
      usage: [],
    });
    return;
  }
  const content = [
    ...(behaviour === "image"
      ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]
      : []),
    { type: "text", text: "Reply with the digits." },
  ];
  const res = await gw.model("/v1/messages", {
    model: request.model,
    max_tokens: 64,
    messages: [{ role: "user", content }],
  });
  await res.text();
  await gw.post("ended", {
    type: "run_ended",
    runId: request.runId,
    outcome: "completed",
    summary: {
      done: "Vision probe answer",
      reply: answer(request),
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    },
    usage: [
      {
        model: request.model,
        inputTokens: 1200,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    ],
  });
}

async function start(): Promise<Harness> {
  const url = await startUpstream();
  h = await startHarness({
    modelBaseUrl: url,
    visionProbe: "auto",
    modelPrices: [price("test-model-default"), price("test-model-cheap"), price("vision-b")],
  });
  h.provider.onRun(playSidecar);
  return h;
}

afterEach(async () => {
  await h?.close();
  h = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  answer = (r) => (r.modelJob?.kind === "vision_probe" ? r.modelJob.code : "");
  behaviour = "image";
  probeRequests.length = 0;
});

async function workspace(harness: Harness, name = "ws"): Promise<Workspace> {
  return (await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", { name })).json
    .workspace;
}

async function createBot(harness: Harness, ws: Workspace, name: string, model?: string) {
  const res = await harness.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name,
    workspaceId: ws.id,
    ...(model ? { model } : {}),
    welcome: false,
  });
  expect(res.status).toBe(201);
  return res.json.bot;
}

async function capabilities(harness: Harness, ws: Workspace): Promise<ModelCapabilityView[]> {
  return (
    await harness.api<{ capabilities: ModelCapabilityView[] }>(
      "GET",
      `/api/workspaces/${ws.id}/model-capabilities`,
    )
  ).json.capabilities;
}

function vision(list: ModelCapabilityView[], model: string): VisionProbeView {
  const found = list.find((c) => c.model === model);
  if (!found) throw new Error(`no capability for ${model}`);
  return found.vision;
}

async function settled(harness: Harness, ws: Workspace, model: string): Promise<VisionProbeView> {
  await waitFor(
    async () => vision(await capabilities(harness, ws), model).status !== "pending",
    3000,
    "probe settled",
  );
  return vision(await capabilities(harness, ws), model);
}

function probeRows(harness: Harness): number {
  return (
    harness.app.deskmates.ctx.db
      .prepare("SELECT count(*) AS n FROM model_capability_probes")
      .get() as {
      n: number;
    }
  ).n;
}

describe("gradeVisionAnswer (decision 7)", () => {
  it("matches only the exact digits, recognises an explicit refusal, and calls the rest wrong", () => {
    expect(gradeVisionAnswer("4096", "4096")).toBe("match");
    expect(gradeVisionAnswer("The number is 4096.", "4096")).toBe("match");
    expect(gradeVisionAnswer("NO IMAGE", "4096")).toBe("refusal");
    expect(gradeVisionAnswer("I cannot see any image.", "4096")).toBe("refusal");
    expect(gradeVisionAnswer("GOING BEYOND COUNTING EYEBALLS", "4096")).toBe("wrong");
    expect(gradeVisionAnswer("4069", "4096")).toBe("wrong");
    expect(gradeVisionAnswer("I can't see it, maybe 4096", "4096")).toBe("match");
  });

  it("keys the endpoint by a hash that ignores a trailing slash", () => {
    expect(endpointSha256("http://m.test/")).toBe(endpointSha256("http://m.test"));
    expect(endpointSha256("http://m.test")).not.toBe(endpointSha256("http://other.test"));
  });
});

describe("vision probe lifecycle", () => {
  it("probes once on create, through the proxy, and reports supported with its receipt", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    const bot = await createBot(harness, ws, "alpha");
    // Run row first: the probe's run exists before any sidecar ran.
    const runs = harness.app.deskmates.ctx.runs.list({ botId: bot.id });
    expect(runs.map((r) => r.config.runType)).toEqual(["vision_probe"]);
    expect(runs[0]?.config).toMatchObject({
      model: "test-model-default",
      cheapModel: "test-model-default",
      fallbackModel: null,
      maxTurns: 1,
    });
    const result = await settled(harness, ws, "test-model-default");
    expect(result).toMatchObject({
      status: "supported",
      reason: "verified_answer",
      trigger: "model_added",
      imageBlocks: 1,
      inputTokens: 1200,
    });
    expect(probeRequests).toHaveLength(1);
    expect(probeRequests[0]?.modelJob?.kind).toBe("vision_probe");
    // Usage is the run's, so the workspace's.
    const runId = result.runId as RunId;
    expect(harness.app.deskmates.ctx.runs.mustGet(runId).status).toBe("succeeded");

    // A second bot on the same model, and any number of reads, queue nothing.
    await createBot(harness, ws, "beta");
    for (let i = 0; i < 3; i++) await capabilities(harness, ws);
    expect(probeRows(harness)).toBe(1);

    // Another workspace starts at unknown: no namesake reuse across workspaces.
    const other = await workspace(harness, "other");
    expect(vision(await capabilities(harness, other), "test-model-default")).toMatchObject({
      id: null,
      status: "unknown",
      reason: "not_probed",
    });
  });

  it("probes the new model on a model change and records the result per model", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    const bot = await createBot(harness, ws, "alpha");
    await settled(harness, ws, "test-model-default");
    const patched = await harness.api("PATCH", `/api/bots/${bot.id}`, { model: "vision-b" });
    expect(patched.status).toBe(200);
    const b = await settled(harness, ws, "vision-b");
    expect(b).toMatchObject({ status: "supported", trigger: "model_changed" });
    expect(vision(await capabilities(harness, ws), "test-model-default").status).toBe("supported");
  });

  it("calls an explicit refusal unsupported and keeps every uncertain outcome unknown", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    answer = () => "NO IMAGE";
    await createBot(harness, ws, "alpha");
    expect(await settled(harness, ws, "test-model-default")).toMatchObject({
      status: "unsupported",
      reason: "explicit_refusal",
      answer: "NO IMAGE",
    });

    answer = () => "GOING BEYOND COUNTING EYEBALLS";
    const retry = async () =>
      harness.api<{ probe: VisionProbeView }>(
        "POST",
        `/api/workspaces/${ws.id}/model-capabilities/vision/probe`,
        { model: "test-model-default" },
      );
    expect((await retry()).status).toBe(202);
    expect(await settled(harness, ws, "test-model-default")).toMatchObject({
      status: "unknown",
      reason: "wrong_answer",
      answer: "GOING BEYOND COUNTING EYEBALLS",
    });

    // The right digits without an image on the wire are not evidence of vision.
    answer = (r) => (r.modelJob?.kind === "vision_probe" ? r.modelJob.code : "");
    behaviour = "text-only";
    expect((await retry()).status).toBe(202);
    expect(await settled(harness, ws, "test-model-default")).toMatchObject({
      status: "unknown",
      reason: "no_transport_evidence",
      imageBlocks: 0,
    });

    behaviour = "fail";
    expect((await retry()).status).toBe(202);
    const failed = await settled(harness, ws, "test-model-default");
    expect(failed).toMatchObject({ status: "unknown", reason: "job_failed" });
    expect(failed.error).toContain("401");

    // Retries are bounded: three in 24 hours (the automatic first probe does not count).
    expect((await retry()).status).toBe(429);
    // Every receipt is kept.
    expect(probeRows(harness)).toBe(4);
  });

  it("never duplicates a pending probe and never lets an older model's result answer a newer one", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    harness.provider.onRun(async (request, gw) => {
      if (request.modelJob?.kind === "vision_probe" && request.model === "test-model-default")
        await gate;
      await playSidecar(request, gw);
    });
    const bot = await createBot(harness, ws, "alpha");
    const vp = harness.app.deskmates.ctx.modelJobs.vision;
    const first = vp.queue({
      workspaceId: ws.id,
      model: "test-model-default",
      trigger: "model_changed",
      requestedBy: "t",
    });
    const second = vp.queue({
      workspaceId: ws.id,
      model: "test-model-default",
      trigger: "retry",
      requestedBy: "t",
    });
    expect(first.run).toBeUndefined();
    expect(second.run).toBeUndefined();
    expect(first.probe.id).toBe(second.probe.id);
    expect(probeRows(harness)).toBe(1);

    // The bot moves to another model while the first probe is still running; the bot's one
    // background lane runs the second probe after the first.
    await harness.api("PATCH", `/api/bots/${bot.id}`, { model: "vision-b" });
    expect(vision(await capabilities(harness, ws), "vision-b").status).toBe("pending");
    answer = (r) =>
      r.modelJob?.kind !== "vision_probe"
        ? ""
        : r.model === "test-model-default"
          ? "NO IMAGE"
          : r.modelJob.code;
    release();
    await settled(harness, ws, "test-model-default");
    await settled(harness, ws, "vision-b");
    const list = await capabilities(harness, ws);
    expect(vision(list, "vision-b").status).toBe("supported");
    expect(vision(list, "test-model-default").status).toBe("unsupported");
  });

  it("settles a pending probe whose run ended without a result before queueing another", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    harness.provider.onRun(async () => undefined);
    const bot = await createBot(harness, ws, "alpha");
    const [run] = harness.app.deskmates.ctx.runs.list({ botId: bot.id });
    await waitFor(
      () => isTerminal(harness.app.deskmates.ctx.runs.mustGet(run?.id as RunId).status),
      3000,
      "probe run ended",
    );
    harness.provider.onRun(playSidecar);
    const queued = harness.app.deskmates.ctx.modelJobs.vision.queue({
      workspaceId: ws.id,
      model: "test-model-default",
      trigger: "retry",
      requestedBy: "t",
    });
    expect(queued.run).toBeDefined();
    const rows = harness.app.deskmates.ctx.db
      .prepare("SELECT status, reason FROM model_capability_probes ORDER BY created_at, rowid")
      .all();
    expect(rows[0]).toMatchObject({ status: "unknown", reason: "job_failed" });
  });

  it("records a blocked result, not an implicit bot, when no bot can host the probe", async () => {
    const harness = await start();
    const ws = await workspace(harness);
    const res = await harness.api<{ probe: VisionProbeView }>(
      "POST",
      `/api/workspaces/${ws.id}/model-capabilities/vision/probe`,
      { model: "test-model-default" },
    );
    expect(res.status).toBe(202);
    expect(res.json.probe).toMatchObject({ status: "unknown", reason: "blocked", runId: null });
    expect(harness.app.deskmates.ctx.bots.list(ws.id)).toHaveLength(0);
  });

  it("stamps each run with what was known about its model at start (decision 9)", async () => {
    const harness = await start();
    const { thread, bot } = await harness.seed();
    const probe = harness.app.deskmates.ctx.modelJobs.vision.queue({
      workspaceId: bot.workspaceId,
      model: "test-model-default",
      trigger: "retry",
      requestedBy: "t",
    });
    const ws = harness.app.deskmates.ctx.workspaces.mustGet(bot.workspaceId);
    harness.app.deskmates.scheduler.kick();
    await settled(harness, ws, "test-model-default");
    const m = await harness.api<{ runs: { id: string }[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "hi" },
    );
    const runId = m.json.runs[0]?.id as RunId;
    await waitFor(
      () => isTerminal(harness.app.deskmates.ctx.runs.mustGet(runId).status),
      3000,
      "run",
    );
    expect(harness.app.deskmates.ctx.runs.mustGet(runId).config.modelCapabilities).toEqual({
      vision: { status: "supported", reason: "verified_answer", probeId: probe.probe.id },
    });
  });
});
