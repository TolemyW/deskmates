// The analytics relay's byte forwarding (ADR-0046 amendment 1 decision 14). Grafana listens on
// the host loopback in `auth.proxy` mode and signs in whoever `X-WEBAUTH-USER` names; the Gateway
// is the only client that may assert it, and it only ever asserts the root, `admin`. So the relay
// removes every identity, credential and forwarding header the browser sent, sets that one, and
// otherwise passes method, path, query, status, headers and bodies through as streams. It never
// parses a body and never reads the obs model: the Gateway stays a thin control plane.

import { type IncomingHttpHeaders, type OutgoingHttpHeaders, request } from "node:http";
import { Transform, type TransformCallback } from "node:stream";
import { CSRF_HEADER, DeskmatesError, TENANT_HEADER } from "@deskmates/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { cookieNames, parseCookies } from "../auth/cookies.js";

/** Where the web opens Analytics: `analyticsUrl` of `GET /api/config` (decision 16). */
export const ANALYTICS_PATH = "/analytics/";

/** The relay's routes; `ORIGIN_CHECKED_ROUTES` in `operator-auth.ts` names the same two. */
export const ANALYTICS_ROUTES = ["/analytics", "/analytics/*"] as const;

/** The methods Grafana's frontend uses; HEAD follows GET. Sorted. */
export const ANALYTICS_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

/** The header Grafana's `auth.proxy` reads, and the one identity the relay asserts. */
export const IDENTITY_HEADER = "x-webauth-user";
export const ANALYTICS_IDENTITY = "admin";

export interface AnalyticsBounds {
  /** From sending the request to Grafana's response headers. */
  headersMs: number;
  /** Inactivity on the upstream connection, in either direction, once connected. */
  idleMs: number;
  /** A request body larger than this is refused with 413. */
  bodyBytes: number;
}

export const ANALYTICS_BOUNDS: AnalyticsBounds = {
  headersMs: 30_000,
  idleMs: 60_000,
  bodyBytes: 16 * 1024 * 1024,
};

/** RFC 9110 section 7.6.1, plus the legacy `proxy-connection` and `keep-alive`. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request headers that never reach Grafana. `origin` was checked by the operator authentication
 * hook already and would name another host than Grafana's; the forwarding headers would let a
 * client assert an address Grafana's whitelist might read in place of the loopback peer.
 */
const REQUEST_DROPPED = new Set([
  "host",
  "authorization",
  "origin",
  "forwarded",
  "x-real-ip",
  CSRF_HEADER.toLowerCase(),
  TENANT_HEADER.toLowerCase(),
]);

const REQUEST_DROPPED_PREFIXES = ["x-webauth-", "x-forwarded-"];

/** Both cookie modes' names: neither the session nor the pre-login token is Grafana's. */
const GATEWAY_COOKIES = new Set(
  [cookieNames("secure"), cookieNames("insecure-dev")].flatMap((names) => [
    names.session,
    names.login,
  ]),
);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
}

/** The cookie header without the Gateway's own cookies; undefined when nothing is left. */
export function keptCookies(header: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(header) ? header.join("; ") : header;
  const kept = [...parseCookies(joined)]
    .filter(([name]) => !GATEWAY_COOKIES.has(name))
    .map(([name, value]) => `${name}=${value}`);
  return kept.length === 0 ? undefined : kept.join("; ");
}

/** What Grafana receives: the browser's headers less identity and hop-by-hop, plus `admin`. */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const listed = connectionTokens(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || listed.has(name) || REQUEST_DROPPED.has(name)) continue;
    if (REQUEST_DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (name === "cookie") {
      const cookie = keptCookies(value);
      if (cookie !== undefined) out.cookie = cookie;
      continue;
    }
    out[name] = value;
  }
  out.host = upstreamHost;
  out[IDENTITY_HEADER] = ANALYTICS_IDENTITY;
  return out;
}

/**
 * A `Location` that points at Grafana itself (any loopback name for its port: its `root_url`
 * says 127.0.0.1 even if the Gateway dials `localhost`) becomes its path, under the Gateway's
 * origin. A relative one, or one elsewhere, is left alone.
 */
export function rewriteLocation(location: string, upstream: URL): string {
  if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return location;
  let url: URL;
  try {
    url = new URL(location, upstream);
  } catch {
    return location;
  }
  const sameService =
    url.protocol === upstream.protocol &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port === upstream.port;
  return sameService ? `${url.pathname}${url.search}${url.hash}` : location;
}

/** What the browser receives: Grafana's headers less hop-by-hop, with `Location` rewritten. */
export function downstreamHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
): Record<string, string | string[]> {
  const listed = connectionTokens(incoming.connection);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] =
      name === "location" && typeof value === "string" ? rewriteLocation(value, upstream) : value;
  }
  return out;
}

/** Counts request bytes on their way to Grafana and fails past the cap. */
class BodyCap extends Transform {
  private seen = 0;
  exceeded = false;

  constructor(private readonly max: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.max) {
      this.exceeded = true;
      done(new Error("request body over the analytics cap"));
      return;
    }
    done(null, chunk);
  }
}

function tooLarge(max: number): DeskmatesError {
  return new DeskmatesError("payload_too_large", "the request body is too large for Analytics", {
    maxBytes: max,
  });
}

/** Neither the address nor the socket error leaves the Gateway (decision 14). */
function unavailable(reason: "unreachable" | "timeout"): DeskmatesError {
  return new DeskmatesError("analytics_unavailable", "Analytics is not answering", { reason });
}

/**
 * Forward one request to `upstream` (an `http` loopback origin, `grafanaUpstream`) and stream
 * the answer back. Rejects with `analytics_unavailable` or `payload_too_large` only before the
 * response headers are sent; after that, a failure ends the browser's response early.
 */
export function relayToGrafana(
  incoming: FastifyRequest,
  reply: FastifyReply,
  upstream: URL,
  bounds: AnalyticsBounds = ANALYTICS_BOUNDS,
): Promise<FastifyReply> {
  const declared = Number(incoming.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > bounds.bodyBytes)
    return Promise.reject(tooLarge(bounds.bodyBytes));
  return new Promise((resolve, reject) => {
    let answered = false;
    const outgoing = request({
      protocol: upstream.protocol,
      hostname: upstream.hostname.replace(/^\[|\]$/g, ""),
      port: upstream.port,
      method: incoming.method,
      // Grafana serves the same sub path (decision 11), so path and query pass unchanged.
      path: incoming.raw.url ?? "/",
      headers: upstreamRequestHeaders(incoming.headers, upstream.host),
    });
    const cap = new BodyCap(bounds.bodyBytes);
    const fail = (error: DeskmatesError) => {
      if (answered) return;
      answered = true;
      clearTimeout(headersTimer);
      outgoing.destroy();
      reject(error);
    };
    const headersTimer = setTimeout(() => fail(unavailable("timeout")), bounds.headersMs);
    outgoing.setTimeout(bounds.idleMs, () => {
      if (answered) outgoing.destroy(new Error("analytics upstream idle"));
      else fail(unavailable("timeout"));
    });
    outgoing.on("error", () =>
      fail(cap.exceeded ? tooLarge(bounds.bodyBytes) : unavailable("unreachable")),
    );
    cap.on("error", () => fail(tooLarge(bounds.bodyBytes)));
    outgoing.on("response", (response) => {
      if (answered) {
        response.destroy();
        return;
      }
      answered = true;
      clearTimeout(headersTimer);
      reply.code(response.statusCode ?? 502).headers(downstreamHeaders(response.headers, upstream));
      resolve(reply.send(response));
    });
    // A browser that goes away takes its upstream request with it.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) outgoing.destroy();
    });
    incoming.raw.pipe(cap).pipe(outgoing);
  });
}
