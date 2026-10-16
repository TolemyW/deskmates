// The model proxy: what a sidecar's ANTHROPIC_BASE_URL points at (ADR-0002 item 4). Validates
// the run's short-lived Bearer token, then forwards the request to the upstream that serves its
// model (ADR-0039: `MODEL_BASE_URL` or one of `MODEL_UPSTREAMS`) with that upstream's Bearer
// token, streaming the body back. Upstream tokens exist only in this process's memory.
//
// The sidecar runs in the model's own trust domain, so the proxy offers exactly what the Agent
// SDK needs and nothing else: `POST /v1/messages` and `POST /v1/messages/count_tokens`, with an
// allowlist of request and response headers. Any other method, path or header never reaches the
// upstream, so a prompt-injected bot holding a run token cannot use the upstream credential for
// anything but a model turn.
//
// Every forwarded request is also recorded in `model_requests` (M3 context plan, Phase 1): the
// model, whether it streamed, a sha256 of its `system` field (`request-facts.ts`) and the usage
// the response reported, read off the bytes as they pass without holding or changing them
// (`response-usage.ts`). The system text is never stored.
//
// The body's `model` must be one of the run's frozen models (ADR-0023 decision 1,
// `frozen-models.ts`): the run token sits in the CLI's environment, so without the check a `Bash`
// call could buy any model on the upstream. The CLI's own small-fast id, when configured, is
// rewritten to the run's cheap model; anything else is refused with 403 `model_not_selected`,
// recorded, and never forwarded. The proxy never retries a model call: the SDK owns retries.
// It never sends a request to another upstream either: a model with no upstream is 503
// `model_upstream_missing`, and a failing upstream's answer is the answer (ADR-0039 decision 3).

import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ResolvedUpstream, upstreamSpeaks } from "../config/model-upstreams.js";
import type { ModelRefusal, ModelRequestKind } from "../ledger/model-requests.js";
import type { RunTokenStore } from "../secrets/run-tokens.js";
import { type FrozenModels, modelVerdict, withModel } from "./frozen-models.js";
import {
  ModelTransportTiming,
  type ModelTransportTimingOptions,
  type TimingRecorder,
} from "./model-transport-timing.js";
import { type RequestFacts, requestFacts } from "./request-facts.js";
import { type ResponseFacts, ResponseUsageObserver } from "./response-usage.js";

export interface ModelProxyOptions {
  tokens: RunTokenStore;
  /**
   * The upstream serving a model id (ADR-0039 decision 2), asked with the id the request is
   * forwarded with. Undefined refuses the request with 503 `model_upstream_missing`.
   */
  upstreamFor: (model: string) => ResolvedUpstream | undefined;
  fetchImpl?: typeof fetch;
  /** Resolves the ledger recorder once, at upstream request start. */
  timingForRun?: (runId: Parameters<RunTokenStore["issue"]>[0]) => TimingRecorder | undefined;
  timing?: Omit<ModelTransportTimingOptions, "record">;
  /** Largest request body accepted; defaults to `MODEL_PROXY_BODY_LIMIT_BYTES`. */
  bodyLimitBytes?: number;
  /**
   * Records a forwarded request as it starts (`model_requests`) and returns the callback that
   * fills in the usage its response reported and, on a 2xx response, the model the response named
   * (ADR-0023 decision 3). Observability: a failure here never fails the call.
   */
  recordRequest?: (
    runId: Parameters<RunTokenStore["issue"]>[0],
    facts: RequestFacts & {
      requestKind: ModelRequestKind;
      rewrittenFrom?: string;
      refusal?: ModelRefusal;
    },
  ) => ((response: ResponseFacts) => void) | undefined;
  /**
   * The models the run was frozen on (ADR-0023 decision 1). Required: a proxy without it would
   * forward any model a run names. Undefined, or a throw, refuses the request.
   */
  frozenModels: (runId: Parameters<RunTokenStore["issue"]>[0]) => FrozenModels | undefined;
  /** `CLI_SMALL_FAST_MODEL`: the CLI's background id, rewritten to the run's cheap model. */
  smallFastModel?: string;
  /**
   * Budget admission before each `/v1/messages` call (ADR-0032 decision 5). A returned refusal
   * is answered 402 `budget_exhausted`, final, and the call never reaches the upstream. A throw
   * admits: the budget is accounting, and an accounting fault must not fail a model call.
   */
  admit?: (
    runId: Parameters<RunTokenStore["issue"]>[0],
  ) => { message: string; details: Record<string, unknown> } | undefined;
}

/**
 * The SDK sends the whole conversation on every turn, and a thread's session is resumed run after
 * run, so a request grows with every browser snapshot and screenshot in the transcript. Fastify's
 * default limit (1 MiB) is reached within a few browser turns; this one is meant never to be.
 */
export const MODEL_PROXY_BODY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Upstream paths the proxy forwards, all `POST`. The query string (e.g. `?beta=true`) passes.
 * `/v1/chat/completions` is the OpenAI runtime's path (ADR-0044 decision 5); each path is
 * forwarded only to an upstream of its own protocol (`PATH_PROTOCOL`).
 */
export const PROXIED_PATHS: ReadonlySet<string> = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/chat/completions",
]);

const PATH_PROTOCOL: Readonly<Record<string, "anthropic" | "openai">> = {
  "/v1/messages": "anthropic",
  "/v1/messages/count_tokens": "anthropic",
  "/v1/chat/completions": "openai",
};

/** Request headers forwarded upstream; everything else, including cookies, is dropped. */
const REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "content-type",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
]);
const REQUEST_HEADER_PREFIXES = ["x-stainless-"];

/** Response headers passed back to the sidecar; upstream infrastructure headers are dropped. */
const RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "cache-control",
  "request-id",
  "x-request-id",
  "retry-after",
  "x-should-retry",
]);
const RESPONSE_HEADER_PREFIXES = ["anthropic-", "openai-"];

function allowed(name: string, exact: ReadonlySet<string>, prefixes: readonly string[]): boolean {
  return exact.has(name) || prefixes.some((p) => name.startsWith(p));
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}

export function registerModelProxy(app: FastifyInstance, opts: ModelProxyOptions): void {
  const doFetch = opts.fetchImpl ?? fetch;
  app.register(async (scope) => {
    // Raw bodies: the proxy must not re-encode the request the SDK built.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: opts.bodyLimitBytes ?? MODEL_PROXY_BODY_LIMIT_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post("/v1/*", async (request: FastifyRequest, reply: FastifyReply) => {
      const token = bearerToken(request.headers.authorization);
      const verified = token ? opts.tokens.verify(token) : undefined;
      if (!verified) {
        return reply.code(401).send({
          code: "token_rejected",
          message: "missing, expired or revoked model token",
          details: {},
        });
      }
      const path = request.url.split("?", 1)[0] ?? request.url;
      if (!PROXIED_PATHS.has(path)) {
        return reply.code(404).send({
          code: "not_found",
          message: `the model proxy forwards only ${[...PROXIED_PATHS].join(", ")}`,
          details: { path },
        });
      }

      const requestKind = path === "/v1/messages/count_tokens" ? "count_tokens" : "messages";
      const rawBody = request.body as Buffer | undefined;
      const facts = requestFacts(rawBody);
      let frozen: FrozenModels | undefined;
      try {
        frozen = opts.frozenModels(verified.runId);
      } catch {
        frozen = undefined;
      }
      const verdict = modelVerdict(facts.model, frozen, opts.smallFastModel);
      if (verdict.verdict === "refuse") {
        try {
          opts.recordRequest?.(verified.runId, {
            requestKind,
            ...facts,
            refusal: "model_not_selected",
          });
        } catch {
          // The refusal stands whether or not it could be recorded.
        }
        // `x-should-retry: false` so the SDK treats this as final instead of retrying it.
        return reply
          .code(403)
          .header("x-should-retry", "false")
          .send({
            code: "model_not_selected",
            message: "the request names a model this run was not started on",
            details: facts.model === undefined ? {} : { model: facts.model },
          });
      }
      if (requestKind === "messages" && opts.admit) {
        let refusal: ReturnType<NonNullable<ModelProxyOptions["admit"]>>;
        try {
          refusal = opts.admit(verified.runId);
        } catch {
          refusal = undefined;
        }
        if (refusal) {
          return reply
            .code(402)
            .header("x-should-retry", "false")
            .send({ code: "budget_exhausted", message: refusal.message, details: refusal.details });
        }
      }
      let upstreamTarget: ResolvedUpstream | undefined;
      try {
        upstreamTarget = opts.upstreamFor(verdict.model);
      } catch {
        upstreamTarget = undefined;
      }
      if (!upstreamTarget) {
        return reply
          .code(503)
          .header("x-should-retry", "false")
          .send({
            code: "model_upstream_missing",
            message: "no model upstream serves this model",
            details: { model: verdict.model },
          });
      }
      // ADR-0044 decision 5: a request goes only to an upstream of its own protocol. The proxy
      // never translates one protocol into the other.
      const protocol = PATH_PROTOCOL[path];
      if (protocol !== undefined && !upstreamSpeaks(upstreamTarget, protocol)) {
        return reply
          .code(503)
          .header("x-should-retry", "false")
          .send({
            code: "model_upstream_missing",
            message: `the upstream serving this model speaks ${upstreamTarget.protocol}, not ${protocol}`,
            details: {
              model: verdict.model,
              protocol: upstreamTarget.protocol,
              expected: protocol,
            },
          });
      }
      const body =
        verdict.verdict === "rewrite" && rawBody ? withModel(rawBody, verdict.model) : rawBody;

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || !allowed(name, REQUEST_HEADERS, REQUEST_HEADER_PREFIXES)) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      // The run's Bearer never leaves: it is replaced by the upstream's, or dropped for an
      // upstream configured without one (a local model server).
      if (upstreamTarget.authToken) {
        headers.set("authorization", `Bearer ${upstreamTarget.authToken}`);
      }

      let recorder: TimingRecorder | undefined;
      try {
        recorder = opts.timingForRun?.(verified.runId);
      } catch {
        // Observability cannot make a valid model request fail.
      }
      const timing = new ModelTransportTiming({
        ...opts.timing,
        requestKind,
        ...(recorder ? { record: recorder } : {}),
      });

      // `model_requests`: the request's facts now, its usage once the response has passed. Both
      // halves fail open, and `settleUsage` runs at most once whatever way the response ends.
      let recordUsage: ((response: ResponseFacts) => void) | undefined;
      /** Only a successful response's model is recorded; a failure's is never guessed. */
      let succeeded = false;
      try {
        recordUsage = opts.recordRequest?.(verified.runId, {
          requestKind,
          ...facts,
          ...(verdict.verdict === "rewrite"
            ? { model: verdict.model, rewrittenFrom: verdict.from }
            : {}),
        });
      } catch {
        // Observability cannot make a valid model request fail.
      }
      let usageObserver: ResponseUsageObserver | undefined;
      const settleUsage = () => {
        const observer = usageObserver;
        const record = recordUsage;
        usageObserver = undefined;
        recordUsage = undefined;
        if (!observer || !record) return;
        try {
          const usage = observer.finish();
          const servedModel = succeeded ? observer.servedModel() : undefined;
          if (usage || servedModel !== undefined) {
            record({ ...usage, ...(servedModel === undefined ? {} : { servedModel }) });
          }
        } catch {
          /* Observability only. */
        }
      };

      // A sidecar that dies or is killed mid-stream (run timeout, container removed) leaves the
      // upstream turn running and billing until the model finishes on its own. `reply.raw`'s
      // `close` is the signal: it fires when the response completed *or* the connection went
      // away, and `writableFinished` tells the two apart. `request.raw`'s own `close` cannot be
      // used — Fastify has already buffered the body, so it fires before the handler even reaches
      // the upstream (verified against Fastify 5 / Node 23).
      const aborter = new AbortController();
      const streams: { source?: Readable; observed?: Transform } = {};
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) {
          timing.cancelled();
          aborter.abort();
          streams.source?.destroy();
          streams.observed?.destroy();
        }
      });

      let upstream: Response;
      try {
        upstream = await doFetch(`${upstreamTarget.baseUrl}${request.url}`, {
          method: "POST",
          headers,
          body: body as Buffer,
          signal: aborter.signal,
        });
      } catch (err) {
        // The sidecar hung up: there is no one left to answer, and nothing failed upstream.
        if (aborter.signal.aborted) {
          timing.cancelled();
          return reply;
        }
        timing.failed();
        // Not a DeskmatesErrorCode yet; contracts has no code for an unreachable model upstream.
        return reply.code(502).send({
          code: "upstream_unavailable",
          message: `model upstream unreachable: ${String(err)}`,
          details: {},
        });
      }

      // Some injected fetch implementations can resolve after ignoring an already-aborted signal.
      // Do not attach or leave that late body unread.
      if (aborter.signal.aborted) {
        timing.cancelled();
        await upstream.body?.cancel().catch(() => undefined);
        return reply;
      }

      timing.receivedHeaders();
      succeeded = upstream.ok;

      reply.code(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (allowed(name, RESPONSE_HEADERS, RESPONSE_HEADER_PREFIXES)) reply.header(name, value);
      });
      if (!upstream.body) {
        timing.completed();
        return reply.send();
      }

      const source = Readable.fromWeb(upstream.body as unknown as NodeReadableStream);
      if (recordUsage)
        usageObserver = new ResponseUsageObserver(upstream.headers.get("content-type"));
      const observed = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          timing.receivedBytes(chunk.byteLength);
          try {
            usageObserver?.push(chunk);
          } catch {
            // A usage parse error loses the usage, never the response.
            usageObserver = undefined;
          }
          callback(null, chunk);
        },
      });
      streams.source = source;
      streams.observed = observed;
      source.on("error", (err) => observed.destroy(err));
      observed.on("end", () => {
        settleUsage();
        timing.completed();
      });
      observed.on("error", () => {
        settleUsage();
        if (aborter.signal.aborted) timing.cancelled();
        else timing.failed();
      });
      observed.on("close", settleUsage);
      source.pipe(observed);
      return reply.send(observed);
    });
  });
}
