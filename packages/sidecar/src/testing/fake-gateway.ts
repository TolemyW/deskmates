// In-process stand-in for the Gateway's internal run routes, served through a `fetch` function.
// Records everything the sidecar posts so tests can assert on the ledger, approvals, lock
// requests, thread posts and the final RunEnded. Routes match gateway-client.ts.

import type {
  ApprovalDecideRequest,
  ApprovalRequest,
  ApprovalResponse,
  BrowserLockRequest,
  BrowserLockResponse,
  EgressAllowlistResponse,
  MemorySearchHit,
  PostMessageRequest,
  RunEnded,
  SidecarEvent,
} from "@deskmates/contracts";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Whether the client gave this request a deadline; every Gateway call must (review M3). */
  hasSignal: boolean;
}

export interface FakeGatewayOptions {
  /** Answer to a new approval request; `"pending"` makes the sidecar poll. */
  approvalResponder?: (req: ApprovalRequest) => ApprovalResponse | "pending";
  lockResponder?: (req: BrowserLockRequest) => BrowserLockResponse;
  /** Fault injection: answer the first N `POST /ended` with 503 before accepting one. */
  failEndedPosts?: number;
  /** Fault injection: answer the first N approval polls with 503 before answering properly. */
  failApprovalPolls?: number;
  /** Fault injection: answer the first N `POST /approvals` with 503. */
  failApprovalPosts?: number;
  /** Status for `POST /approvals/:id/decide`; 403 is the Gateway refusing a non-member bot. */
  approvalDecideStatus?: number;
  /**
   * The `{code, message, details}` body the Gateway's error handler sends with a refused decide.
   * Without it the route answers the plain text `refused`, as a proxy or a non-Gateway would.
   */
  approvalDecideError?: { code: string; message: string; details?: Record<string, unknown> };
  /**
   * What `GET /egress` serves, read on every call so a test can change the workspace's list
   * mid-run. The caller passes the run's own list to mean "nothing changed"; with no option at all
   * the route is not served and answers 404, which the hook treats like any other failure.
   */
  egressAllowlist?: () => readonly string[];
  /** Fault injection: status for `GET /egress`; the hook must then keep the list it had. */
  egressStatus?: number;
  /** `EgressAllowlistResponse.updatedAt`; defaults to a fixed timestamp. */
  egressUpdatedAt?: () => string;
  /** `EgressAllowlistResponse.grants` (ADR-0027 amendment 1); omitted when not given. */
  egressGrants?: () => NonNullable<EgressAllowlistResponse["grants"]>;
  /** What `GET /memory/search` answers; without it the route answers 404. */
  memorySearch?: (query: string, scope: string | undefined) => MemorySearchHit[];
}

export interface FakeGateway {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
  events: SidecarEvent[];
  approvals: ApprovalRequest[];
  /** Decisions a bot took with `approval_decide`. */
  decides: ApprovalDecideRequest[];
  locks: BrowserLockRequest[];
  messages: PostMessageRequest[];
  ended: RunEnded[];
  /**
   * Attempts per route, including the ones answered with an injected failure. `egressGets` is how
   * the tests prove a non-navigation tool call never asks the Gateway for the allowlist.
   */
  attempts: {
    endedPosts: number;
    approvalPolls: number;
    approvalPosts: number;
    egressGets: number;
  };
  /** Decide a pending approval; the next poll returns it. */
  decide(response: ApprovalResponse): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createFakeGateway(opts: FakeGatewayOptions = {}): FakeGateway {
  const decided = new Map<string, ApprovalResponse>();
  const gw: FakeGateway = {
    requests: [],
    events: [],
    approvals: [],
    decides: [],
    locks: [],
    messages: [],
    ended: [],
    attempts: { endedPosts: 0, approvalPolls: 0, approvalPosts: 0, egressGets: 0 },
    decide: (response) => {
      decided.set(response.approvalId, response);
    },
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {}))
        headers[k.toLowerCase()] = String(v);
      const body = typeof init?.body === "string" ? init.body : "";
      gw.requests.push({ method, url, headers, body, hasSignal: init?.signal != null });

      const path = new URL(url).pathname;
      const m = /^\/internal\/runs\/([^/]+)\/(.+)$/.exec(path);
      if (!m) return new Response("not found", { status: 404 });
      const rest = m[2] ?? "";

      if (method === "POST" && rest === "events") {
        gw.events.push(...(JSON.parse(body) as SidecarEvent[]));
        return json({ ok: true });
      }
      if (method === "POST" && rest === "ended") {
        gw.attempts.endedPosts += 1;
        if (gw.attempts.endedPosts <= (opts.failEndedPosts ?? 0)) {
          return new Response("service unavailable", { status: 503 });
        }
        gw.ended.push(JSON.parse(body) as RunEnded);
        return json({ ok: true });
      }
      if (method === "POST" && rest.startsWith("approvals/") && rest.endsWith("/decide")) {
        const status = opts.approvalDecideStatus ?? 200;
        if (status < 200 || status >= 300) {
          return opts.approvalDecideError
            ? json(opts.approvalDecideError, status)
            : new Response("refused", { status });
        }
        gw.decides.push(JSON.parse(body) as ApprovalDecideRequest);
        return json({ ok: true });
      }
      if (method === "POST" && rest === "approvals") {
        gw.attempts.approvalPosts += 1;
        if (gw.attempts.approvalPosts <= (opts.failApprovalPosts ?? 0)) {
          return new Response("service unavailable", { status: 503 });
        }
        const req = JSON.parse(body) as ApprovalRequest;
        gw.approvals.push(req);
        const answer = opts.approvalResponder?.(req) ?? {
          type: "approval_response",
          approvalId: req.approvalId,
          decision: "deny",
          reason: "M0: approvals are denied automatically",
        };
        if (answer === "pending") return new Response(null, { status: 202 });
        return json(answer);
      }
      if (method === "GET" && rest.startsWith("approvals/")) {
        gw.attempts.approvalPolls += 1;
        if (gw.attempts.approvalPolls <= (opts.failApprovalPolls ?? 0)) {
          return new Response("service unavailable", { status: 503 });
        }
        const id = decodeURIComponent(rest.slice("approvals/".length));
        const answer = decided.get(id);
        return answer ? json(answer) : new Response(null, { status: 202 });
      }
      if (method === "GET" && rest === "egress") {
        gw.attempts.egressGets += 1;
        const status = opts.egressStatus ?? 200;
        if (status < 200 || status >= 300) return new Response("egress unavailable", { status });
        if (opts.egressAllowlist === undefined) return new Response("not found", { status: 404 });
        const response: EgressAllowlistResponse = {
          type: "egress_allowlist",
          egressAllowlist: opts.egressAllowlist(),
          ...(opts.egressGrants === undefined ? {} : { grants: opts.egressGrants() }),
          updatedAt: opts.egressUpdatedAt?.() ?? "2026-09-22T09:00:00.000Z",
        };
        return json(response);
      }
      if (method === "POST" && rest === "browser-lock") {
        const req = JSON.parse(body) as BrowserLockRequest;
        gw.locks.push(req);
        const answer = opts.lockResponder?.(req) ?? {
          type: "browser_lock_result",
          runId: req.runId,
          granted: true,
        };
        return json(answer);
      }
      if (method === "GET" && rest === "memory/search") {
        if (!opts.memorySearch) return new Response("not found", { status: 404 });
        const params = new URL(url).searchParams;
        return json({
          entries: opts.memorySearch(params.get("q") ?? "", params.get("scope") ?? undefined),
        });
      }
      if (method === "POST" && rest === "messages") {
        gw.messages.push(JSON.parse(body) as PostMessageRequest);
        return json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return gw;
}
