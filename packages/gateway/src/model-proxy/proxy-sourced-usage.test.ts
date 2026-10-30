// T1: ADR-0029 decision 8 through the real model proxy. A sidecar makes requests with its run token
// and dies without reporting usage; the Gateway files the attempt's `run_usage` from the requests
// the proxy recorded, marked `proxy`, and a request whose usage the upstream never reported makes
// it incomplete rather than zero.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunId, StartRunRequest } from "@deskmates/contracts";
import { afterEach, expect, it } from "vitest";
import { usageReceipts } from "../ledger/usage-receipts.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

let upstream: Server | undefined;
let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

/** Streams usage for a normal request; `noUsage: true` answers without any usage at all. */
async function startUpstream(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { noUsage?: boolean; input?: number };
      if (parsed.noUsage) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", model: "test-model-default" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse([
          {
            type: "message_start",
            message: {
              id: "m",
              model: "test-model-default",
              usage: { input_tokens: parsed.input ?? 10, output_tokens: 1 },
            },
          },
          { type: "message_delta", usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ]),
      );
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function proxied(req: StartRunRequest, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${req.modelBaseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${req.modelAuthToken}` },
    body: JSON.stringify({ model: "test-model-default", stream: true, ...body }),
  });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`proxy answered ${res.status}`);
}

async function crashAfter(bodies: Record<string, unknown>[]): Promise<RunId> {
  h = await startHarness({ modelBaseUrl: await startUpstream() });
  const harness = h;
  const { thread } = await harness.seed();
  harness.provider.onRun(async (req) => {
    for (const body of bodies) await proxied(req, body);
    // The process dies here: no run_ended, no usage report.
    return { exitCode: 137, stderr: "killed" };
  });
  const m = await harness.api<{ runs: { id: string }[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    { body: "work" },
  );
  const runId = m.json.runs[0]?.id as RunId;
  await waitFor(
    () => harness.app.deskmates.ctx.runs.mustGet(runId).status === "failed",
    3000,
    "the crash",
  );
  await harness.app.deskmates.scheduler.drain();
  return runId;
}

it("files a crashed attempt's usage from its two proxied requests, marked proxy", async () => {
  const runId = await crashAfter([{ input: 10 }, { input: 30 }]);
  const ctx = (h as Harness).app.deskmates.ctx;
  expect(ctx.usage.listByAttempt(runId)).toMatchObject([
    {
      attempt: 1,
      model: "test-model-default",
      source: "proxy",
      usageComplete: true,
      inputTokens: 40,
      outputTokens: 6,
    },
  ]);
  expect(usageReceipts(ctx.db, runId).coverage).toBe("complete");
});

it("counts a request the upstream reported no usage for as unknown, never zero", async () => {
  const runId = await crashAfter([{ input: 10 }, { noUsage: true }]);
  const ctx = (h as Harness).app.deskmates.ctx;
  const [row] = ctx.usage.listByAttempt(runId);
  expect(row).toMatchObject({ source: "proxy", usageComplete: false, inputTokens: 10 });
  expect(usageReceipts(ctx.db, runId).coverage).toBe("partial");
});
