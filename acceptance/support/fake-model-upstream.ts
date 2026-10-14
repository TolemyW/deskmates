// A stand-in for MODEL_BASE_URL: a node:http server that speaks just enough of the Anthropic
// Messages protocol for the Agent SDK's CLI to complete one turn. By default every
// `POST /v1/messages` gets the same assistant text (a reply plus the fenced JSON summary block
// the sidecar's summary.ts parses) with `stop_reason: "end_turn"`, streamed as SSE when the
// request says `stream: true` and as one JSON message otherwise. Records every request so a test
// can see what the CLI sent and which credential reached the upstream.
//
// `script` lets a test answer a turn with a `tool_use` block instead, which is how a T2 drives a
// real tool call through the sidecar's hooks with no model in the loop. Both response paths use
// the real API's block shapes — a `tool_use` content block in the JSON body, and
// `content_block_start` (`type: "tool_use"`) plus `input_json_delta` deltas in the SSE one — with
// `stop_reason: "tool_use"`, because the SDK's CLI parses the wire format, not a summary of it.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunSummary } from "@deskmates/contracts";

export interface RecordedUpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  rawBody: string;
}

/**
 * What the "model" answers with for one request: assistant text, or a single tool call. A `text`
 * turn is sent verbatim, so a script that wants the sidecar's summary block back has to build it
 * with `assistantText`.
 */
export type FakeTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: Record<string, unknown> }
  /** An upstream failure such as 529 `overloaded_error`, sent as the real API's error body. */
  | { kind: "error"; status: number; type: string; message: string };

export interface FakeModelUpstreamOptions {
  /** `reply` of the summary block; also the first line of the assistant text. */
  reply: string;
  /** The upstream Bearer token; anything else is answered 401 like the real API. */
  expectedToken: string;
  /**
   * Answer a turn with something other than the default text reply. `turn` counts
   * `POST /v1/messages` requests this upstream instance has served, starting at 1, across every
   * run; `body` is the parsed request, so a script can also branch on what the CLI sent (the
   * declared tools, or a `tool_result` block from the previous turn). Unset means every turn
   * answers `assistantText(reply)`, which is what the M0 and trigger suites rely on.
   */
  script?: (turn: number, body: RecordedUpstreamRequest["body"]) => FakeTurn | Promise<FakeTurn>;
  /**
   * The `model` a response names, from the id the request named. Unset echoes the request, as an
   * upstream that serves exactly what was asked does; a test of the served-model ledger
   * (ADR-0023 decision 3) sets it so a recorded value can only have come from the response.
   */
  servedModel?: (requested: string) => string;
}

export interface FakeModelUpstream {
  url: string;
  requests: RecordedUpstreamRequest[];
  close(): Promise<void>;
}

/** The text the "model" produces: reply, blank line, summary block, nothing after. */
export function assistantText(reply: string): string {
  const summary: RunSummary = {
    done: `Replied "${reply}" without using any tool.`,
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
  return `${reply}\n\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Rough token count so `usage` is non-zero and the Gateway's usage row has something to price. */
function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function startFakeModelUpstream(
  opts: FakeModelUpstreamOptions,
): Promise<FakeModelUpstream> {
  const requests: RecordedUpstreamRequest[] = [];
  let counter = 0;

  const server: Server = createServer((req, res) => {
    readBody(req)
      .then(async (rawBody) => {
        let body: Record<string, unknown> | undefined;
        try {
          body = rawBody === "" ? undefined : (JSON.parse(rawBody) as Record<string, unknown>);
        } catch {
          body = undefined;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(", ");
        }
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers, body, rawBody });

        const path = (req.url ?? "").split("?")[0] ?? "";
        if (headers.authorization !== `Bearer ${opts.expectedToken}`) {
          return json(res, 401, {
            type: "error",
            error: { type: "authentication_error", message: "invalid bearer token" },
          });
        }
        if (req.method === "POST" && path === "/v1/messages/count_tokens") {
          return json(res, 200, { input_tokens: tokens(rawBody) });
        }
        if (req.method !== "POST" || path !== "/v1/messages") {
          return json(res, 404, {
            type: "error",
            error: {
              type: "not_found_error",
              message: `fake upstream: no route ${req.method} ${path}`,
            },
          });
        }

        counter += 1;
        const turnNumber = counter;
        const requested = typeof body?.model === "string" ? body.model : "unknown-model";
        const model = opts.servedModel ? opts.servedModel(requested) : requested;
        const turn: FakeTurn = opts.script
          ? await opts.script(turnNumber, body)
          : { kind: "text", text: assistantText(opts.reply) };
        if (turn.kind === "error") {
          return json(res, turn.status, {
            type: "error",
            error: { type: turn.type, message: turn.message },
          });
        }
        const id = `msg_fake_${turnNumber}`;
        // The real API's tool_use ids are `toolu_`-prefixed and unique per block; the sidecar
        // keys its ledger and its deferred-call bookkeeping on them, so they must not repeat.
        const toolUseId = `toolu_fake_${turnNumber}`;
        const toolInput = turn.kind === "tool_use" ? JSON.stringify(turn.input) : "";
        const inputTokens = tokens(rawBody);
        const outputTokens =
          turn.kind === "text" ? tokens(turn.text) : tokens(`${turn.name}${toolInput}`);
        const usage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
        const stopReason = turn.kind === "tool_use" ? "tool_use" : "end_turn";

        if (body?.stream !== true) {
          const content =
            turn.kind === "text"
              ? [{ type: "text", text: turn.text }]
              : [{ type: "tool_use", id: toolUseId, name: turn.name, input: turn.input }];
          return json(res, 200, {
            id,
            type: "message",
            role: "assistant",
            model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage,
          });
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sse(res, "message_start", {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
          },
        });
        if (turn.kind === "text") {
          sse(res, "content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          sse(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: turn.text },
          });
        } else {
          // The real shape: the block opens with the id and the name and an empty input, the
          // arguments arrive as `input_json_delta` fragments the client concatenates and parses.
          sse(res, "content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: toolUseId, name: turn.name, input: {} },
          });
          sse(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: toolInput },
          });
        }
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
      })
      .catch((err: unknown) => {
        json(res, 500, { type: "error", error: { type: "api_error", message: String(err) } });
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
