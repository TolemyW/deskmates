// Test-only: the shared harness for each feature's wire golden (`src/features/<f>/api.golden.test.ts`).
// A golden calls every method of one API module with representative arguments against a recording
// `fetch` and pins the exact request (method, URL, headers, body, credentials, abort signal) and how
// the answer, a 401 and an error body surface. Each feature owns its sample calls and its
// `__golden__/api.golden.txt` (JSON; `.txt` so the formatter leaves it byte-exact), so changing one
// feature's endpoints never touches another feature's golden. Never imported by production code.

import type { ApprovalId, BotId, RunId, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { ApiError } from "../api/types.js";
import { type HttpTransport, createHttpTransport } from "./http-transport.js";

// Ids with a reserved character pin `encodeURIComponent` on every path segment.
export const WS = "ws/1" as WorkspaceId;
export const BOT = "bot/1" as BotId;
export const BOT2 = "bot_2" as BotId;
export const THR = "thr/1" as ThreadId;
export const RUN = "run/1" as RunId;
export const APR = "apr/1" as ApprovalId;

/** Every response envelope key the clients unwrap, each mapped to a recognisable marker. */
const ENVELOPE: Record<string, string> = Object.fromEntries(
  [
    "alert",
    "alerts",
    "approval",
    "approvals",
    "bot",
    "bots",
    "connection",
    "connections",
    "connector",
    "connectors",
    "document",
    "documents",
    "entries",
    "entry",
    "events",
    "handoffs",
    "memory",
    "messages",
    "pin",
    "proposal",
    "proposals",
    "provider",
    "rule",
    "rules",
    "runs",
    "skill",
    "soul",
    "task",
    "tasks",
    "threads",
    "versions",
    "workspace",
    "workspaces",
  ].map((k) => [k, `<${k}>`]),
);

/** One representative call per method; the mapped type fails to compile when a method is missing. */
export type GoldenCases<A> = { [K in keyof A]: (api: A, signal: AbortSignal) => unknown };

export interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
  signal: boolean;
}

export type GoldenReply = "ok" | "error" | "unauthorized" | "network" | "html" | "badRange";

export function recordingFetch(reply: GoldenReply): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A plain copy, not `new Headers`: jsdom's Headers drops `range` as a forbidden header.
    const headers = Object.entries((init?.headers ?? {}) as Record<string, string>).map(
      ([k, v]) => [k.toLowerCase(), v] as const,
    );
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries([...headers].sort(([a], [b]) => a.localeCompare(b))),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      credentials: init?.credentials,
      cache: init?.cache,
      signal: init?.signal !== undefined,
    });
    switch (reply) {
      case "network":
        throw new TypeError("Failed to fetch");
      case "unauthorized":
        // No message: the client's fallback names the method and path it failed on.
        return new Response(JSON.stringify({ code: "unauthorized" }), {
          status: 401,
        });
      case "error":
        return new Response(
          JSON.stringify({ code: "conflict", message: "Changed", details: { version: 9 } }),
          { status: 409 },
        );
      case "html":
        return new Response("<html>bad gateway</html>", { status: 502 });
      case "badRange":
        return new Response("abcd", { status: 206, headers: { "content-range": "bytes */10" } });
      case "ok":
        return new Response(JSON.stringify(ENVELOPE), {
          status: init?.method === "POST" ? 201 : 200,
          headers: { "content-type": "application/json", "content-range": "bytes 0-3/10" },
        });
    }
  };
  return { fetch: impl as typeof fetch, calls };
}

function isBlob(value: unknown): value is Blob {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Blob).text === "function" &&
    typeof (value as Blob).size === "number"
  );
}

/** A JSON-stable picture of a result or an error. */
export async function surface(value: unknown): Promise<unknown> {
  // Duck-typed: the Response's Blob is Node's, not jsdom's global `Blob`.
  if (isBlob(value)) return { blob: await value.text(), size: value.size };
  if (value instanceof ApiError) {
    return {
      error: value.name,
      code: value.code,
      message: value.message,
      status: value.status,
      details: value.details,
    };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await surface(v);
    return out;
  }
  return value === undefined ? "<undefined>" : value;
}

/** Runs one call against a transport with a base URL, tenant, CSRF token and 401 counter. */
export async function exerciseCase<A>(
  create: (t: HttpTransport) => A,
  call: (api: A, signal: AbortSignal) => unknown,
  reply: GoldenReply,
): Promise<{ calls: RecordedRequest[]; outcome: Record<string, unknown>; unauthorized: number }> {
  const { fetch, calls } = recordingFetch(reply);
  let unauthorized = 0;
  const api = create(
    createHttpTransport({
      baseUrl: "https://gw.test",
      fetch,
      csrfToken: () => "csrf-1",
      tenantId: "tn/1",
      onUnauthorized: () => {
        unauthorized += 1;
      },
    }),
  );
  let outcome: Record<string, unknown>;
  try {
    outcome = { resolved: await surface(await call(api, new AbortController().signal)) };
  } catch (err) {
    outcome = { rejected: await surface(err) };
  }
  return { calls, outcome, unauthorized };
}

/** The golden text for one API module: every case's request, answer, 401 and error surface. */
export async function wireGolden<A>(
  create: (t: HttpTransport) => A,
  cases: GoldenCases<A>,
): Promise<string> {
  const golden: Record<string, unknown> = {};
  for (const name of (Object.keys(cases) as (keyof A & string)[]).sort()) {
    const call = cases[name];
    const ok = await exerciseCase(create, call, "ok");
    const entry: Record<string, unknown> = {
      requests: ok.calls,
      ok: ok.outcome,
    };
    if (ok.calls.length > 0) {
      const unauthorized = await exerciseCase(create, call, "unauthorized");
      entry.unauthorized = { ...unauthorized.outcome, notified: unauthorized.unauthorized };
      const error = await exerciseCase(create, call, "error");
      entry.error = { ...error.outcome, notified: error.unauthorized };
    }
    golden[name] = entry;
  }
  return `${JSON.stringify(golden, null, 2)}\n`;
}
