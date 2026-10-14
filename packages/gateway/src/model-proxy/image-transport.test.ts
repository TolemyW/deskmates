// T1, ADR-0023 amendment 1 decision 4 (issue #87): an image the SDK sends reaches the upstream
// unchanged through the model proxy, with and without the small-fast rewrite, and the request's
// row says how many image blocks it carried, tool results included. Unreadable is NULL, not 0.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { countImageBlocks } from "./request-facts.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

let upstream: Server | undefined;
let received: string[] = [];
let h: Harness | undefined;

async function start(): Promise<Harness> {
  received = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", model: "served", usage: { input_tokens: 900 } }));
    });
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  h = await startHarness({
    modelBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cliSmallFastModel: "cli-small-fast",
  });
  return h;
}

afterEach(async () => {
  await h?.close();
  h = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

async function frozenRun(harness: Harness): Promise<RunId> {
  const { bot } = await harness.seed();
  const run = harness.app.deskmates.ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "cron",
    triggerRef: "image-transport",
    triggerPayload: { prompt: "" },
    config: { model: "test-model-default", cheapModel: "test-model-cheap" },
  });
  return run.id;
}

async function send(harness: Harness, runId: RunId, body: string): Promise<number> {
  const token = harness.app.deskmates.ctx.tokens.issue(runId).token;
  const res = await fetch(`${harness.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body,
  });
  await res.text();
  return res.status;
}

const imageMessage = (model: string) =>
  JSON.stringify({
    model,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          { type: "text", text: "What digits?" },
        ],
      },
    ],
  });

describe("images through the model proxy", () => {
  it("forwards an image block byte-identical and records one image block", async () => {
    const harness = await start();
    const runId = await frozenRun(harness);
    const body = imageMessage("test-model-default");
    expect(await send(harness, runId, body)).toBe(200);
    expect(received).toEqual([body]);
    const [row] = harness.app.deskmates.ctx.modelRequests.list(runId);
    expect(row).toMatchObject({ imageBlocks: 1, inputTokens: 900, servedModel: "served" });
  });

  it("keeps the image when the proxy rewrites the CLI's small-fast model", async () => {
    const harness = await start();
    const runId = await frozenRun(harness);
    expect(await send(harness, runId, imageMessage("cli-small-fast"))).toBe(200);
    const forwarded = JSON.parse(received[0] ?? "{}") as {
      model: string;
      messages: { content: { type: string; source?: { data: string } }[] }[];
    };
    expect(forwarded.model).toBe("test-model-cheap");
    expect(forwarded.messages[0]?.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG },
    });
    expect(harness.app.deskmates.ctx.modelRequests.list(runId)[0]?.imageBlocks).toBe(1);
  });

  it("counts images inside tool results, records 0 for text and NULL for an unreadable body", async () => {
    const harness = await start();
    const runId = await frozenRun(harness);
    const toolResult = JSON.stringify({
      model: "test-model-default",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
              ],
            },
          ],
        },
      ],
    });
    await send(harness, runId, toolResult);
    await send(harness, runId, JSON.stringify({ model: "test-model-default", messages: [] }));
    await send(harness, runId, "not json");
    const rows = harness.app.deskmates.ctx.modelRequests.list(runId);
    expect(rows.map((r) => r.imageBlocks)).toEqual([1, 0, null]);
  });

  it("counts nested blocks without walking forever", () => {
    expect(countImageBlocks([{ type: "image" }, { content: [{ type: "image" }] }])).toBe(2);
    expect(countImageBlocks(undefined)).toBe(0);
  });
});
