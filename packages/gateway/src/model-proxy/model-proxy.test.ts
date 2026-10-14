// T1: the model proxy against a local fake upstream (ADR-0002 item 4; test strategy §4.2
// "short-lived token", §6 "an expired short-lived token is rejected").

import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type PhaseTimingSample, type RunId, isTerminal } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  TEST_UPSTREAM_TOKEN,
  startHarness,
  waitFor,
} from "../test-support/harness.js";

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const USAGE_SSE = [
  "event: message_start",
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_s",
      usage: {
        input_tokens: 700,
        output_tokens: 1,
        cache_read_input_tokens: 25000,
        cache_creation_input_tokens: 0,
      },
    },
  })}`,
  "",
  "event: content_block_delta",
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hé ✓" } })}`,
  "",
  "event: message_delta",
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 88 } })}`,
  "",
  "event: message_stop",
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
  "",
].join("\n");

/** The run's frozen model: the proxy forwards only that and the cheap one (ADR-0023). */
const M = "test-model-default";

let upstream: Server;
let upstreamUrl: string;
let captured: Captured[];
let h: Harness;
/** Set when the upstream turn that never answers is hung up on instead of left running. */
let hangingHungUp: boolean;

function startUpstream(): Promise<void> {
  captured = [];
  hangingHungUp = false;
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/messages" && body.includes('"hang":true')) {
        // A long model turn that has not produced its first byte yet: no status line, no headers,
        // nothing. It ends only when the caller hangs up.
        res.on("close", () => {
          if (!res.writableFinished) hangingHungUp = true;
        });
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"hangBody":true')) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        // Send one byte so Fastify flushes the proxied headers, then leave the body open.
        res.write(Buffer.from([42]));
        res.on("close", () => {
          if (!res.writableFinished) hangingHungUp = true;
        });
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"noBody":true')) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"binary":true')) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 255, 1, 128, 10]));
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"timed":true')) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.write(Buffer.from([1]));
          setTimeout(() => res.end(Buffer.from([2])), 20);
        }, 20);
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"usageStream":true')) {
        // A realistic stream, written in small pieces that split lines and events.
        res.writeHead(200, { "content-type": "text/event-stream" });
        const pieces = USAGE_SSE.match(/[\s\S]{1,11}/g) ?? [];
        const next = () => {
          const piece = pieces.shift();
          if (piece === undefined) return void res.end();
          res.write(piece);
          setImmediate(next);
        };
        next();
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"usageJson":true')) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_2",
            content: [{ type: "text", text: "ok" }],
            usage: {
              input_tokens: 321,
              output_tokens: 12,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 50,
            },
          }),
        );
        return;
      }
      if (req.url === "/v1/messages" && body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "fake" });
        res.write("event: message_start\ndata: {}\n\n");
        setTimeout(() => {
          res.write("event: message_stop\ndata: {}\n\n");
          res.end();
        }, 10);
        return;
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "whatever" }] }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "fake",
        "request-id": "req_abc",
        "anthropic-ratelimit-requests-remaining": "41",
        "set-cookie": "upstream=session; HttpOnly",
      });
      res.end(JSON.stringify({ id: "msg_1", echo: JSON.parse(body || "{}") }));
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  await startUpstream();
  h = await startHarness({ modelBaseUrl: upstreamUrl });
});

afterEach(async () => {
  await h.close();
  // The proxy's fetch pool keeps its upstream connection alive; without this `close` waits it out.
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function seededRunId(): Promise<RunId> {
  const { thread } = await h.seed();
  const m = await h.api<{ runs: { id: string }[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "hi",
  });
  const runId = m.json.runs[0]?.id as RunId;
  // The default fake sidecar exits at once, so the run fails and its own token is revoked;
  // each test then issues a fresh token for the run row.
  await waitFor(() => isTerminal(h.app.deskmates.ctx.runs.mustGet(runId).status), 2000, "run end");
  return runId;
}

describe("model proxy", () => {
  it("forwards /v1/messages with the upstream Bearer token and streams the body back", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issued.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-stainless-lang": "js",
        cookie: "session=leak",
        "x-forwarded-for": "10.0.0.9",
        "x-api-key": "should-not-pass",
      },
      body: JSON.stringify({ model: M, messages: [], max_tokens: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "msg_1",
      echo: { model: M, messages: [], max_tokens: 5 },
    });
    // Response headers: the SDK's are kept, upstream infrastructure headers are not.
    expect(res.headers.get("request-id")).toBe("req_abc");
    expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("41");
    expect(res.headers.get("x-upstream")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();

    const seen = captured[0] as Captured;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/messages");
    expect(seen.headers.authorization).toBe(`Bearer ${TEST_UPSTREAM_TOKEN}`);
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(seen.headers["x-stainless-lang"]).toBe("js");
    // Request headers: only the allowlist reaches the upstream.
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(issued.token);

    const timing = h.app.deskmates.ctx.events
      .list(runId)
      .filter((event) => event.payload.source === "phase_timing");
    expect(timing).toHaveLength(8);
    expect(timing.every((event) => event.attempt === 1)).toBe(true);
    expect(timing.map((event) => (event.payload as unknown as PhaseTimingSample).phase)).toEqual(
      expect.arrayContaining(["model_request", "model_headers", "model_first_byte", "model_body"]),
    );
    expect(JSON.stringify(timing)).not.toContain(TEST_UPSTREAM_TOKEN);
    expect(JSON.stringify(timing)).not.toContain('"max_tokens"');
  });

  it("forwards count_tokens and keeps the query string", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/messages/count_tokens?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(captured[0]?.url).toBe("/v1/messages/count_tokens?beta=true");
    const timing = h.app.deskmates.ctx.events
      .list(runId)
      .filter((event) => event.payload.source === "phase_timing");
    expect(timing).not.toHaveLength(0);
    expect(timing.every((event) => event.payload.requestKind === "count_tokens")).toBe(true);
  });

  it("forwards a request body well past Fastify's 1 MiB default (long transcripts, screenshots)", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const body = JSON.stringify({
      model: M,
      messages: [{ role: "user", content: "x".repeat(1_200_000) }],
    });
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body,
    });
    expect(res.status).toBe(200);
    expect(captured[0]?.body.length).toBe(body.length);
  });

  it("streams SSE responses through", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  });

  // M3 context plan, Phase 1: every forwarded request leaves a `model_requests` row with the
  // hash of its system prompt and the usage its response reported; never the system text.
  const SYSTEM_TEXT = "You are Nova. SYSTEM-TEXT-MUST-NOT-BE-STORED";
  const sha = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

  async function post(runId: RunId, path: string, body: Record<string, unknown>) {
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    return fetch(`${h.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify(body),
    });
  }

  it("records a non-streaming request with the response's usage", async () => {
    const runId = await seededRunId();
    const res = await post(runId, "/v1/messages", {
      model: M,
      system: SYSTEM_TEXT,
      messages: [],
      usageJson: true,
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { usage: { input_tokens: number } };
    expect(answer.usage.input_tokens).toBe(321);
    const rows = await waitForRows(runId, (r) => r[0]?.inputTokens !== null);
    expect(rows).toEqual([
      expect.objectContaining({
        attempt: 1,
        seq: 1,
        requestKind: "messages",
        model: M,
        stream: false,
        systemSha256: sha(SYSTEM_TEXT),
        inputTokens: 321,
        outputTokens: 12,
        cacheReadTokens: 4000,
        cacheCreateTokens: 50,
      }),
    ]);
    expect(dbText()).not.toContain("SYSTEM-TEXT-MUST-NOT-BE-STORED");
  });

  it("records a streaming request's usage from message_start and message_delta, body unchanged", async () => {
    const runId = await seededRunId();
    const system = [{ type: "text", text: SYSTEM_TEXT, cache_control: { type: "ephemeral" } }];
    const res = await post(runId, "/v1/messages", {
      model: M,
      stream: true,
      usageStream: true,
      system,
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(USAGE_SSE);
    const rows = await waitForRows(runId, (r) => r[0]?.outputTokens === 88);
    expect(rows[0]).toMatchObject({
      stream: true,
      systemSha256: sha([
        { cache_control: { type: "ephemeral" }, text: SYSTEM_TEXT, type: "text" },
      ]),
      inputTokens: 700,
      outputTokens: 88,
      cacheReadTokens: 25000,
      cacheCreateTokens: 0,
    });
    expect(dbText()).not.toContain("SYSTEM-TEXT-MUST-NOT-BE-STORED");
  });

  it("numbers every request of a run, count_tokens included, with unknown usage left NULL", async () => {
    const runId = await seededRunId();
    await (await post(runId, "/v1/messages/count_tokens", { model: M, messages: [] })).text();
    await (await post(runId, "/v1/messages", { model: M, messages: [] })).text();
    const rows = await waitForRows(runId, (r) => r.length === 2);
    expect(rows.map((r) => [r.seq, r.requestKind, r.systemSha256, r.inputTokens])).toEqual([
      [1, "count_tokens", null, null],
      [2, "messages", null, null],
    ]);
  });

  it("still records the request when the upstream is unreachable", async () => {
    await h.close();
    h = await startHarness({ modelBaseUrl: "http://127.0.0.1:1" });
    const runId = await seededRunId();
    const res = await post(runId, "/v1/messages", { model: M, system: "S", messages: [] });
    expect(res.status).toBe(502);
    const rows = h.app.deskmates.ctx.modelRequests.list(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.systemSha256).toBe(sha("S"));
    expect(rows[0]?.inputTokens).toBeNull();
  });

  async function waitForRows(
    runId: RunId,
    done: (
      rows: ReturnType<Harness["app"]["deskmates"]["ctx"]["modelRequests"]["list"]>,
    ) => boolean,
  ) {
    await waitFor(() => done(h.app.deskmates.ctx.modelRequests.list(runId)), 2000, "usage row");
    return h.app.deskmates.ctx.modelRequests.list(runId);
  }

  function dbText(): string {
    const db = h.app.deskmates.ctx.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    return tables
      .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n");
  }

  it("measures delayed headers, first received byte and body completion at transport boundaries", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M, timed: true }),
    });
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2]);

    const endByPhase = Object.fromEntries(
      h.app.deskmates.ctx.events
        .list(runId)
        .filter((event) => event.payload.source === "phase_timing" && event.payload.edge === "end")
        .map((event) => [event.payload.phase, event.payload]),
    );
    expect(endByPhase.model_headers?.durationMs).toBeGreaterThanOrEqual(10);
    expect(endByPhase.model_first_byte?.durationMs).toBeGreaterThanOrEqual(10);
    expect(endByPhase.model_body?.durationMs).toBeGreaterThanOrEqual(10);
    expect(endByPhase.model_request?.durationMs).toBeGreaterThanOrEqual(30);
  });

  it("preserves arbitrary response bytes and records an empty body without a successful first byte", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const call = (body: object) =>
      fetch(`${h.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
        body: JSON.stringify(body),
      });

    const binary = await call({ model: M, binary: true });
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 255, 1, 128, 10]);

    const empty = await call({ model: M, noBody: true });
    expect(empty.status).toBe(204);
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
    const firstByteEnds = h.app.deskmates.ctx.events
      .list(runId)
      .filter(
        (event) => event.payload.phase === "model_first_byte" && event.payload.edge === "end",
      );
    expect(firstByteEnds.map((event) => event.payload.outcome)).toEqual(["ok", "cancelled"]);
  });

  it("aborts the upstream turn when the sidecar dies waiting for the model", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const client = new AbortController();
    const inflight = fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M, hang: true }),
      signal: client.signal,
    }).catch((err: Error) => err);

    // The turn is with the upstream and no byte has come back yet; now the sidecar is killed
    // (run timeout, container removed). Nothing is streaming, so nothing tears the fetch down on
    // its own: without the AbortController the upstream turn runs to completion, unread and paid
    // for, against a run that no longer exists.
    await waitFor(() => captured.length === 1, 2000, "upstream request");
    client.abort();
    expect(((await inflight) as Error).name).toBe("AbortError");

    await waitFor(() => hangingHungUp, 2000, "upstream hang-up");
    await waitFor(
      () =>
        h.app.deskmates.ctx.events
          .list(runId)
          .some(
            (event) =>
              event.payload.phase === "model_request" &&
              event.payload.edge === "end" &&
              event.payload.outcome === "cancelled",
          ),
      2000,
      "cancelled timing before headers",
    );
  });

  it("cancels the upstream body and closes timing spans when the sidecar dies after headers", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const client = new AbortController();
    const response = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M, hangBody: true }),
      signal: client.signal,
    });
    client.abort();
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => hangingHungUp, 2000, "upstream body hang-up");
    await waitFor(
      () =>
        h.app.deskmates.ctx.events
          .list(runId)
          .some(
            (event) =>
              event.payload.phase === "model_request" &&
              event.payload.edge === "end" &&
              event.payload.outcome === "cancelled",
          ),
      2000,
      "cancelled timing",
    );
  });

  it("refuses every other method and path, even with a valid token, without touching upstream", async () => {
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const auth = { authorization: `Bearer ${issued.token}` };
    const attempts = [
      fetch(`${h.baseUrl}/v1/models?limit=1`, { headers: auth }),
      fetch(`${h.baseUrl}/v1/models`, { method: "DELETE", headers: auth }),
      fetch(`${h.baseUrl}/v1/organizations/keys`, { method: "POST", headers: auth, body: "{}" }),
      fetch(`${h.baseUrl}/v1/messages/batches`, { method: "POST", headers: auth, body: "{}" }),
      fetch(`${h.baseUrl}/v1/messages`, { method: "GET", headers: auth }),
    ];
    const statuses = (await Promise.all(attempts)).map((r) => r.status);
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
    expect(captured).toHaveLength(0);
  });

  it("rejects missing, unknown, revoked and expired tokens with 401 and never reaches upstream", async () => {
    const runId = await seededRunId();
    const body = JSON.stringify({ model: M });
    const call = (auth?: string) =>
      fetch(`${h.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body,
      });

    expect((await call()).status).toBe(401);
    expect((await call("Bearer cbt_unknown")).status).toBe(401);
    // The upstream token itself is not a valid sidecar credential.
    expect((await call(`Bearer ${TEST_UPSTREAM_TOKEN}`)).status).toBe(401);

    const revoked = h.app.deskmates.ctx.tokens.issue(runId);
    h.app.deskmates.ctx.tokens.revokeForRun(runId);
    const r = await call(`Bearer ${revoked.token}`);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: "token_rejected" });

    // Expired: issue with a TTL already in the past by rewriting expires_at.
    const expired = h.app.deskmates.ctx.tokens.issue(runId);
    h.app.deskmates.ctx.db
      .prepare(
        "UPDATE run_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ? AND revoked_at IS NULL",
      )
      .run(runId);
    expect((await call(`Bearer ${expired.token}`)).status).toBe(401);

    expect(captured).toHaveLength(0);
  });

  it("answers 502 when the upstream is unreachable", async () => {
    await h.close();
    h = await startHarness({ modelBaseUrl: "http://127.0.0.1:1" });
    const runId = await seededRunId();
    const issued = h.app.deskmates.ctx.tokens.issue(runId);
    const res = await fetch(`${h.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ model: M }),
    });
    expect(res.status).toBe(502);
    const requestEnd = h.app.deskmates.ctx.events
      .list(runId)
      .find((event) => event.payload.phase === "model_request" && event.payload.edge === "end");
    expect(requestEnd?.payload.outcome).toBe("error");
  });
});
