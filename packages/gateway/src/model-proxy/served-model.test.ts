// The model the upstream actually served (ADR-0023 decision 3; test plan FB-05). T0: the
// response observer reads `model` off `message_start` in a stream and off the top level of a JSON
// body, the same bytes it reads usage from. T1: the proxy stores it as `served_model` on every
// successful request, streaming or not, and leaves it NULL, never guessed, when the upstream
// failed, was unreachable, or the request was refused.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type RunId, isTerminal } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { ResponseUsageObserver } from "./response-usage.js";

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const STREAM = sse([
  {
    type: "message_start",
    message: { id: "m", model: "served-upstream-id", usage: { input_tokens: 5, output_tokens: 1 } },
  },
  { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  { type: "message_delta", usage: { output_tokens: 4 } },
  { type: "message_stop" },
]);

describe("ResponseUsageObserver reads the served model", () => {
  it("from message_start in a stream split at every byte", () => {
    const o = new ResponseUsageObserver("text/event-stream");
    for (const byte of Buffer.from(STREAM)) o.push(Buffer.from([byte]));
    expect(o.finish()).toMatchObject({ inputTokens: 5, outputTokens: 4 });
    expect(o.servedModel()).toBe("served-upstream-id");
  });

  it("from the top level of a JSON body", () => {
    const o = new ResponseUsageObserver("application/json");
    o.push(Buffer.from(JSON.stringify({ id: "m", model: "served-json-id", usage: {} })));
    o.finish();
    expect(o.servedModel()).toBe("served-json-id");
  });

  it("is undefined when the response names no model, or names it with a non-string", () => {
    for (const [type, body] of [
      ["application/json", JSON.stringify({ input_tokens: 12 })],
      ["application/json", JSON.stringify({ model: 7 })],
      ["text/event-stream", sse([{ type: "message_start", message: { usage: {} } }])],
      ["application/octet-stream", "model"],
    ] as const) {
      const o = new ResponseUsageObserver(type);
      o.push(Buffer.from(body));
      o.finish();
      expect(o.servedModel(), body).toBeUndefined();
    }
  });
});

let upstream: Server | undefined;
let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

/** Streams for `stream: true`, JSON otherwise; `fail: true` answers 529 naming a model anyway. */
async function startUpstream(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { stream?: boolean; fail?: boolean };
      if (parsed.fail) {
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", model: "must-not-be-recorded" }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(STREAM);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", model: "served-json-id", usage: { input_tokens: 2 } }));
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startedRun(harness: Harness): Promise<RunId> {
  const { thread } = await harness.seed();
  const m = await harness.api<{ runs: { id: string }[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "hi" },
  );
  const runId = m.json.runs[0]?.id as RunId;
  await waitFor(
    () => isTerminal(harness.app.deskmates.ctx.runs.mustGet(runId).status),
    2000,
    "end",
  );
  return runId;
}

async function post(harness: Harness, runId: RunId, body: Record<string, unknown>) {
  const issued = harness.app.deskmates.ctx.tokens.issue(runId);
  const res = await fetch(`${harness.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

describe("the proxy records served_model (FB-05)", () => {
  it("on streaming and non-streaming successes, and never on a failure or a refusal", async () => {
    h = await startHarness({ modelBaseUrl: await startUpstream() });
    const harness = h;
    const runId = await startedRun(harness);
    expect(await post(harness, runId, { model: "test-model-default", stream: true })).toBe(200);
    expect(await post(harness, runId, { model: "test-model-cheap" })).toBe(200);
    expect(await post(harness, runId, { model: "test-model-default", fail: true })).toBe(529);
    expect(await post(harness, runId, { model: "test-model-unlisted" })).toBe(403);
    await waitFor(
      () => harness.app.deskmates.ctx.modelRequests.list(runId).length === 4,
      2000,
      "rows",
    );
    await waitFor(
      () => harness.app.deskmates.ctx.modelRequests.list(runId)[1]?.servedModel !== null,
      2000,
      "served model",
    );
    const rows = harness.app.deskmates.ctx.modelRequests.list(runId);
    expect(rows.map((r) => [r.model, r.servedModel])).toEqual([
      ["test-model-default", "served-upstream-id"],
      ["test-model-cheap", "served-json-id"],
      ["test-model-default", null],
      ["test-model-unlisted", null],
    ]);
    expect(rows[0]).toMatchObject({ inputTokens: 5, outputTokens: 4 });
  });

  it("leaves served_model NULL when the upstream is unreachable", async () => {
    h = await startHarness({ modelBaseUrl: "http://127.0.0.1:1" });
    const runId = await startedRun(h);
    expect(await post(h, runId, { model: "test-model-default" })).toBe(502);
    expect(h.app.deskmates.ctx.modelRequests.list(runId).map((r) => r.servedModel)).toEqual([null]);
  });
});
