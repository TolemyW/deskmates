// T2: the whole M0 plumbing with no model. A real Gateway, a real workspace container, the real
// `deskmates-sidecar` binary and the real Agent SDK, against a fake upstream that answers every
// `POST /v1/messages` with "pong". Proves: message -> run row -> scheduler -> exec ->
// sidecar -> SDK -> Gateway model proxy -> upstream, and back: events, usage, reply, terminal
// status. Also the credential path: the per-run token travels in the StartRunRequest (stdin) and
// the env file, never in the container spec nor in an exec's argv or env; the upstream sees only
// the Gateway's own token, in the Authorization header and nowhere else.
// Skips when the Docker daemon is unreachable (`colima start`).

import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type RecordedUpstreamRequest,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import {
  type RunView,
  type SseCollector,
  collectRunStatuses,
  describeStatuses,
  getRun,
  postMessage,
  replyOf,
  runEvents,
  threadMessages,
  waitForRun,
} from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const UPSTREAM_TOKEN = "fake-upstream-token-never-leaves-the-gateway-4c1d";
// Labels for the fake upstream, not model ids: the fake echoes whatever model it is asked for.
const FAKE_MODEL = "fake-upstream-model";
const FAKE_CHEAP_MODEL = "fake-upstream-model-cheap";

// The two routes the model proxy forwards, and the request headers it copies through
// (packages/gateway/src/model-proxy/model-proxy.ts). Anything else the SDK's CLI sends must be
// dropped before the upstream, so the proxy stays a model endpoint and not a general tunnel.
const PROXIED_PATHS = ["/v1/messages", "/v1/messages/count_tokens"];
const FORWARDED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "content-type",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
]);
const FORWARDED_HEADER_PREFIXES = ["x-stainless-"];
// Added by the proxy's own fetch, not copied from the sidecar's request.
const TRANSPORT_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "accept-language",
  "sec-fetch-mode",
]);

function unexpectedHeaders(r: RecordedUpstreamRequest): string[] {
  return Object.keys(r.headers).filter(
    (name) =>
      !TRANSPORT_HEADERS.has(name) &&
      !FORWARDED_HEADERS.has(name) &&
      !FORWARDED_HEADER_PREFIXES.some((p) => name.startsWith(p)),
  );
}

/**
 * Where a secret could hide in one upstream request: every header value and the raw body.
 * `authorization` is excluded because it is where the Gateway's own upstream token belongs.
 */
function leakSurface(r: RecordedUpstreamRequest): { where: string; text: string }[] {
  const out = Object.entries(r.headers)
    .filter(([name]) => name !== "authorization")
    .map(([name, value]) => ({ where: `header ${name}`, text: value }));
  out.push({ where: "raw body", text: r.rawBody });
  return out;
}

interface ExecWatcher {
  /** `GET /exec/{id}/json` bodies, by exec id, for every exec seen on the container. */
  readonly captured: Map<string, string>;
  stop(): Promise<void>;
}

/**
 * The daemon drops an exec instance from the container's `ExecIDs` as soon as the process exits,
 * and `GET /exec/{id}/json` then 404s, so the only way to see what an exec's argv and env held is
 * to look while it runs. Poll the container from the moment the stack is up until the run has
 * finished and keep every exec instance that appears.
 */
function watchExecs(s: Stack): ExecWatcher {
  const captured = new Map<string, string>();
  let polling = true;
  const loop = (async () => {
    while (polling) {
      try {
        const res = await s.docker.client.request(
          "GET",
          `/containers/${s.handle.providerRef}/json`,
        );
        const ids = (JSON.parse(res.body) as { ExecIDs?: string[] | null }).ExecIDs ?? [];
        for (const id of ids) {
          if (captured.has(id)) continue;
          const exec = await s.docker.client.request("GET", `/exec/${id}/json`);
          if (exec.status === 200) captured.set(id, exec.body);
        }
      } catch {
        // The container or an exec can vanish between the two calls; keep polling.
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  return {
    captured,
    stop: async () => {
      polling = false;
      await loop;
    },
  };
}

const dockerUp = await dockerAvailable();
if (!dockerUp) console.warn("[m0-stack.container.test] Docker daemon unreachable; skipping T2.");

describe.skipIf(!dockerUp)(
  "M0 stack (T2): Gateway + Docker workspace + deskmates-sidecar + Agent SDK, fake model upstream",
  () => {
    let upstream: FakeModelUpstream;
    let stack: Stack | undefined;
    let sse: SseCollector | undefined;
    let run: RunView | undefined;
    let final: RunView | undefined;
    let execWatcher: ExecWatcher | undefined;
    let wallClockMs = 0;

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({ reply: "pong", expectedToken: UPSTREAM_TOKEN });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: UPSTREAM_TOKEN,
        defaultModel: FAKE_MODEL,
        cheapModel: FAKE_CHEAP_MODEL,
        label: "stack",
      });
      sse = await collectRunStatuses(stack, stack.thread.id);
      execWatcher = watchExecs(stack);
    }, 25 * 60_000);

    afterAll(async () => {
      sse?.close();
      await execWatcher?.stop();
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it(
      "ping: queued -> running -> succeeded through the real Gateway, container, sidecar and SDK",
      async () => {
        const s = stack as Stack;
        const started = Date.now();
        const posted = await postMessage(s, "ping");
        run = posted.run;
        expect(run.status).toBe("queued");
        expect(run.lane).toBe("interactive");
        expect(run.triggerRef).toBe(posted.message.id);

        const completed = await waitForRun(s, run.id, 5 * 60_000, {
          onStatus: (status) =>
            console.log(
              `[m0-stack] run ${status} (+${Math.round((Date.now() - started) / 1000)}s)`,
            ),
        });
        final = completed;
        wallClockMs = Date.now() - started;
        console.log(`[m0-stack] run finished in ${Math.round(wallClockMs / 1000)}s`);
        if (completed.status !== "succeeded") {
          const events = await runEvents(s, run.id);
          const sidecar = s.provider
            .sidecarRuns()
            .find((entry) => entry.request.runId === completed.id)?.exec.result;
          console.error("[m0-stack] run error:", completed.error);
          console.error("[m0-stack] sidecar stderr:", sidecar?.stderr.slice(-4000));
          console.error("[m0-stack] events:", JSON.stringify(events, null, 2).slice(0, 8000));
          console.error(
            "[m0-stack] upstream requests:",
            upstream.requests.map((r) => `${r.method} ${r.url} auth=${r.headers.authorization}`),
          );
        }
        expect(completed.status, completed.error).toBe("succeeded");

        // SSE saw the whole status sequence in order; polling may have skipped `running`.
        await new Promise((r) => setTimeout(r, 200));
        expect(describeStatuses(sse?.statuses ?? [], run.id)).toEqual([
          "queued",
          "running",
          "succeeded",
        ]);
      },
      6 * 60_000,
    );

    it("the bot's reply lands in thread_messages, attributed to the run", async () => {
      const s = stack as Stack;
      const r = run as RunView;
      const messages = await threadMessages(s);
      expect(messages.map((m) => m.authorKind)).toEqual(["human", "bot"]);
      expect(replyOf(messages, r.id)).toBe("pong");
      expect(messages[1]?.authorId).toBe(s.bot.id);
      expect(messages[1]?.seq).toBe(2);
      expect((final as RunView).summary?.reply).toBe("pong");
    });

    it("run_usage has exactly one row, for the model the Gateway configured", async () => {
      const s = stack as Stack;
      const { usage } = await getRun(s, (run as RunView).id);
      expect(usage).toHaveLength(1);
      expect(usage[0]?.model).toBe(FAKE_MODEL);
      expect(usage[0]?.inputTokens).toBeGreaterThan(0);
      expect(usage[0]?.outputTokens).toBeGreaterThan(0);
      // The fake model is not in the price table, so the Gateway records the gap, not a cost.
      const events = await runEvents(s, (run as RunView).id);
      expect(usage[0]?.costUsd).toBeNull();
      expect(events.some((e) => e.kind === "pricing_missing")).toBe(true);
    });

    it("the ledger holds the sidecar's events for the run", async () => {
      const s = stack as Stack;
      const events = await runEvents(s, (run as RunView).id);
      const kinds = new Set(events.map((e) => e.kind));
      // The assistant's text is logged; no tool was called, so no tool_call is expected.
      expect(kinds.has("log")).toBe(true);
      expect(events.every((e) => e.runId === (run as RunView).id)).toBe(true);
      const seqs = events.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    });

    it("the SDK's CLI reached the upstream through the Gateway proxy with the Gateway's token", () => {
      // The proxy forwards two POST routes and nothing else, so everything the upstream saw must
      // be one of them; a request on any other route would mean the proxy widened.
      for (const r of upstream.requests) {
        const path = r.url.split("?", 1)[0] ?? r.url;
        expect(`${r.method} ${path}`, "route the proxy forwarded").toBe(`POST ${path}`);
        expect(PROXIED_PATHS, `upstream route ${r.method} ${path}`).toContain(path);
      }
      // The CLI also counts tokens through the proxy (`/v1/messages/count_tokens`, tools included,
      // never streamed): the route loop above covers those; the turn checks below are `messages`.
      const messages = upstream.requests.filter(
        (r) => (r.url.split("?", 1)[0] ?? r.url) === "/v1/messages",
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
      for (const r of messages) {
        expect(r.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
        expect(r.headers["x-api-key"]).toBeUndefined();
        expect(r.headers.cookie).toBeUndefined();
        // Only the proxy's header allowlist (plus what its own fetch adds) reached the upstream.
        expect(unexpectedHeaders(r), `headers the proxy should have dropped on ${r.url}`).toEqual(
          [],
        );
      }
      // The CLI first makes a side call with no tools (session title generation), then the turn.
      const withTools = messages.filter(
        (r) => Array.isArray(r.body?.tools) && (r.body.tools as unknown[]).length > 0,
      );
      expect(withTools.length, "a request carrying the tool list").toBeGreaterThanOrEqual(1);
      const main = withTools[withTools.length - 1];
      expect(main?.body?.model).toBe(FAKE_MODEL);
      expect(main?.body?.stream).toBe(true);
      // The system prompt the sidecar assembled: SOUL.md from the container's /home/<bot>.
      expect(JSON.stringify(main?.body?.system)).toContain(`You are ${(stack as Stack).bot.name}`);
      // Both MCP servers registered: the workspace's Playwright MCP (browser tools) and the
      // sidecar's in-process thread tools. A wrong bin name or a dead CDP leaves these out.
      const toolNames = (main?.body?.tools as { name: string }[]).map((t) => t.name);
      expect(toolNames).toContain("mcp__deskmates__thread_post");
      for (const t of ["browser_navigate", "browser_snapshot", "browser_click", "browser_type"]) {
        expect(toolNames, `browser MCP tool ${t}`).toContain(`mcp__browser__${t}`);
      }
      for (const r of messages) {
        const turns = Array.isArray(r.body?.messages) ? (r.body.messages as unknown[]) : [];
        const tools = Array.isArray(r.body?.tools) ? (r.body.tools as unknown[]) : [];
        console.log(
          `[m0-stack] upstream saw ${r.method} ${r.url} model=${String(r.body?.model)} ` +
            `stream=${String(r.body?.stream)} max_tokens=${String(r.body?.max_tokens)} ` +
            `turns=${turns.length} tools=${tools.length} ` +
            `system=${JSON.stringify(r.body?.system).slice(0, 160)}`,
        );
        console.log(
          `[m0-stack]   last turn: ${JSON.stringify(turns[turns.length - 1]).slice(0, 400)}`,
        );
      }
    });

    it("the run token travelled in StartRunRequest and the env file, never in the container spec or an exec", async () => {
      const s = stack as Stack;
      const r = run as RunView;
      // Bot creation may have started its automatically-cancelled welcome sidecar before the
      // shared acceptance harness regained control. This assertion is about the explicit ping.
      const runs = s.provider.sidecarRuns().filter((entry) => entry.request.runId === r.id);
      expect(runs).toHaveLength(1);
      const request = runs[0]?.request;
      expect(request?.runId).toBe(r.id);
      expect(request?.botName).toBe(s.bot.name);
      expect(request?.model).toBe(FAKE_MODEL);
      expect(request?.egressAllowlist).toEqual(s.workspace.egressAllowlist);
      const token = request?.modelAuthToken ?? "";
      expect(token.length).toBeGreaterThanOrEqual(16);
      expect(token).not.toBe(UPSTREAM_TOKEN);
      // Both go to the container as host.docker.internal, not a loopback address.
      expect(request?.modelBaseUrl).toBe(s.config.gatewayBaseUrl);
      expect(request?.gatewayBaseUrl).toBe(s.config.gatewayBaseUrl);
      expect(new URL(request?.modelBaseUrl ?? "").hostname).not.toMatch(
        /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/,
      );

      // The token travels on stdin only: nothing is written to the workspace env file (one file
      // per workspace would hand a concurrent run the wrong token) and the create spec never
      // carried it.
      expect(s.provider.injected).toEqual([]);
      expect(JSON.stringify(s.provider.specs)).not.toContain(token);
      expect(JSON.stringify(s.provider.specs)).not.toContain(UPSTREAM_TOKEN);

      // docker inspect of the container: neither token anywhere in it.
      const inspect = await s.docker.client.request(
        "GET",
        `/containers/${s.handle.providerRef}/json`,
      );
      expect(inspect.status).toBe(200);
      expect(inspect.body).not.toContain(token);
      expect(inspect.body).not.toContain(UPSTREAM_TOKEN);

      // The container spec is only half of it: `docker inspect` of an *exec* shows that exec's
      // argv and env, which is why the scheduler hands the StartRunRequest to the sidecar on
      // stdin instead. The watcher collected every exec the daemon reported while the run was
      // in flight; neither token may appear in any of their ProcessConfig, Cmd or Env. The
      // `deskmates-sidecar run` exec is the one that matters and the one long enough to be seen
      // every time.
      await execWatcher?.stop();
      const execs = [...(execWatcher?.captured ?? new Map<string, string>())];
      const entrypoints = execs.map(([, body]) => {
        const p = (JSON.parse(body) as { ProcessConfig?: { entrypoint?: unknown } }).ProcessConfig;
        return String(p?.entrypoint ?? "?");
      });
      console.log(
        `[m0-stack] inspected ${execs.length} exec instance(s) for the run token: ${entrypoints.join(", ")}`,
      );
      expect(
        entrypoints,
        "the sidecar exec among those seen while the run was in flight",
      ).toContain("deskmates-sidecar");
      for (const [execId, body] of execs) {
        expect(body, `run token in exec ${execId}`).not.toContain(token);
        expect(body, `upstream token in exec ${execId}`).not.toContain(UPSTREAM_TOKEN);
        const json = JSON.parse(body) as Record<string, unknown>;
        for (const field of ["ProcessConfig", "Cmd", "Env"]) {
          const text = JSON.stringify(json[field] ?? null);
          expect(text, `run token in exec ${execId} ${field}`).not.toContain(token);
          expect(text, `upstream token in exec ${execId} ${field}`).not.toContain(UPSTREAM_TOKEN);
        }
      }

      // The upstream never saw the run token either: the proxy swapped it. Not just the
      // Authorization header -- the run token must be absent from every header value and from
      // the raw request body, and the Gateway's upstream token must appear nowhere but
      // Authorization (an SDK that echoed a credential into the body would show up here).
      expect(upstream.requests.length).toBeGreaterThanOrEqual(1);
      for (const req of upstream.requests) {
        expect(req.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
        for (const { where, text } of leakSurface(req)) {
          expect(text, `run token in ${where} of ${req.method} ${req.url}`).not.toContain(token);
          expect(text, `upstream token in ${where} of ${req.method} ${req.url}`).not.toContain(
            UPSTREAM_TOKEN,
          );
        }
      }

      // The token was revoked when the run ended: the proxy rejects it now.
      const proxied = await fetch(`${s.gatewayUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(proxied.status).toBe(401);
    });

    it("the Gateway database on disk holds neither the upstream token nor the run token", () => {
      const s = stack as Stack;
      const token =
        s.provider.sidecarRuns().find((entry) => entry.request.runId === (run as RunView).id)
          ?.request.modelAuthToken ?? "";
      s.app.deskmates.ctx.db.pragma("wal_checkpoint(TRUNCATE)");
      const files = [s.dbPath, `${s.dbPath}-wal`].filter((f) => existsSync(f));
      expect(files.length).toBeGreaterThanOrEqual(1);
      for (const f of files) {
        const bytes = readFileSync(f, "latin1");
        expect(bytes, `${f} contains the upstream token`).not.toContain(UPSTREAM_TOKEN);
        expect(bytes, `${f} contains the run token`).not.toContain(token);
      }
    });
  },
);
