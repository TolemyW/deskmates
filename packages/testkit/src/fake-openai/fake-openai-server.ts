// A scripted OpenAI Chat Completions server for T1 tests of the OpenAI runtime (ADR-0044) and of
// the Gateway's model proxy. It speaks only what the OpenAI Agents SDK's chat model sends:
// `POST /v1/chat/completions`, streaming or not. Each request is answered by the next step of
// the script: a text reply, or one or more tool calls. Every request is recorded so a test can
// assert on the messages and tools the runtime sent.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Defaults to `call_<n>`. */
  id?: string;
}

export type FakeOpenAiStep =
  | { text: string }
  | { toolCalls: FakeToolCall[] }
  /** The server answers with this status and body instead of a completion. */
  | { status: number; body: unknown };

export interface FakeOpenAiUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface FakeOpenAiOptions {
  /** The script, consumed one step per request; when it runs out the server answers 500. */
  steps: FakeOpenAiStep[] | ((request: RecordedChatRequest) => FakeOpenAiStep);
  /** Usage reported on every completion; defaults to small fixed numbers. */
  usage?: FakeOpenAiUsage | ((index: number) => FakeOpenAiUsage);
  /** The model id the responses name; defaults to the request's. */
  servedModel?: string;
}

export interface RecordedChatRequest {
  index: number;
  model: string | undefined;
  stream: boolean;
  messages: unknown[];
  /** Tool names offered on this request, in order. */
  tools: string[];
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface FakeOpenAiServer {
  /** `http://127.0.0.1:<port>`; the runtime appends `/v1`. */
  baseUrl: string;
  requests: RecordedChatRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakeOpenAiServer(opts: FakeOpenAiOptions): Promise<FakeOpenAiServer> {
  const requests: RecordedChatRequest[] = [];
  let callCounter = 0;
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?", 1)[0];
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    const tools = Array.isArray(body.tools)
      ? (body.tools as { function?: { name?: string } }[]).map((t) => t.function?.name ?? "")
      : [];
    const recorded: RecordedChatRequest = {
      index: requests.length,
      model: typeof body.model === "string" ? body.model : undefined,
      stream: body.stream === true,
      messages: Array.isArray(body.messages) ? body.messages : [],
      tools,
      headers: req.headers,
      body,
    };
    requests.push(recorded);
    const step =
      typeof opts.steps === "function"
        ? opts.steps(recorded)
        : (opts.steps[recorded.index] ?? {
            status: 500,
            body: { error: { message: "script exhausted" } },
          });
    if ("status" in step) {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify(step.body));
      return;
    }
    const usage = typeof opts.usage === "function" ? opts.usage(recorded.index) : opts.usage;
    const u = usage ?? { promptTokens: 11, completionTokens: 7 };
    const model = opts.servedModel ?? recorded.model ?? "fake-model";
    const id = `chatcmpl_${recorded.index + 1}`;
    const created = 1_760_000_000;
    const toolCalls =
      "toolCalls" in step
        ? step.toolCalls.map((call, i) => ({
            id: call.id ?? `call_${++callCounter}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            index: i,
          }))
        : undefined;
    const content = "text" in step ? step.text : null;
    const finish = toolCalls ? "tool_calls" : "stop";
    const usageJson = {
      prompt_tokens: u.promptTokens,
      completion_tokens: u.completionTokens,
      total_tokens: u.promptTokens + u.completionTokens,
      ...(u.cachedTokens === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: u.cachedTokens } }),
    };
    if (!recorded.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: finish,
            },
          ],
          usage: usageJson,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (
      delta: Record<string, unknown>,
      finishReason: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      })}\n\n`;
    res.write(chunk({ role: "assistant", content: "" }, null));
    if (content !== null) {
      // Two deltas, so a consumer that concatenates is exercised.
      const half = Math.ceil(content.length / 2);
      res.write(chunk({ content: content.slice(0, half) }, null));
      if (content.length > half) res.write(chunk({ content: content.slice(half) }, null));
    }
    if (toolCalls) {
      for (const call of toolCalls) {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: call.index,
                  id: call.id,
                  type: "function",
                  function: { name: call.function.name, arguments: "" },
                },
              ],
            },
            null,
          ),
        );
        res.write(
          chunk(
            {
              tool_calls: [{ index: call.index, function: { arguments: call.function.arguments } }],
            },
            null,
          ),
        );
      }
    }
    res.write(chunk({}, finish));
    // The usage chunk the SDK asks for with `stream_options.include_usage`.
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageJson })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
