// The one HTTP transport every Gateway client in the web UI sends through (ADR-0022 P1, P4).
// It owns the base URL, the tenant selector header, the CSRF token on unsafe methods, JSON and
// Blob bodies, the typed `ApiError` and the "session rejected" signal. The session itself is the
// HttpOnly cookie the browser sends; nothing here sees or stores it. Feature API modules
// (`src/features/<feature>/api.ts`) build requests on top of this and never call `fetch`.

import { CSRF_HEADER, TENANT_HEADER } from "@deskmates/contracts";
import { ApiError } from "../api/types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HttpTransportOptions {
  /** Prefix for every path; empty for same-origin. */
  baseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`, looked up per call. */
  fetch?: typeof fetch;
  /**
   * The session's CSRF token, sent as `x-deskmates-csrf` on every unsafe method. A getter, because a
   * password change rotates it.
   */
  csrfToken?: () => string | undefined;
  /** Called on every 401 answer: a rejected session ends the authenticated UI. */
  onUnauthorized?: () => void;
  /**
   * The tenant this transport acts in, sent as `x-deskmates-tenant`. Fixed per transport: switching
   * tenant builds a new one.
   */
  tenantId?: string;
  /** The request `cache` mode; unset leaves the browser default. */
  cache?: RequestCache;
}

/** A request body: JSON-serialised, or raw bytes with their own content type. */
export type HttpBody = { json: unknown } | { blob: Blob; contentType: string };

export interface HttpRequestOptions {
  /** The `accept` header; defaults to `application/json`. */
  accept?: string;
  body?: HttpBody;
  /** Extra request headers, applied last. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** A CSRF token for this call instead of the getter's; still never sent on GET. */
  csrf?: string;
  /** A tenant for this call instead of the transport's. */
  tenantId?: string;
}

export interface HttpTransport {
  readonly baseUrl: string;
  readonly tenantId: string | undefined;
  /** Sends one request. A thrown `fetch` becomes an `ApiError` with code `network`, status 0. */
  send(method: HttpMethod, path: string, options?: HttpRequestOptions): Promise<Response>;
  /** The typed error for a non-OK answer; reads its body and signals a 401. */
  failure(method: HttpMethod, path: string, res: Response): Promise<ApiError>;
  /** Sends and parses a JSON answer; an empty or unparsable body resolves `undefined`. */
  request<T>(method: HttpMethod, path: string, options?: HttpRequestOptions): Promise<T>;
  /** `request` with an optional JSON body; `undefined` sends none. */
  json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  /** A GET for bytes: the OK `Response`, whose Blob and headers the caller reads. */
  download(path: string, options?: Omit<HttpRequestOptions, "body">): Promise<Response>;
}

export const BINARY_ACCEPT = "application/octet-stream, application/json";

/** `?a=1&b=2` from the defined, non-empty params; the empty string when there are none. */
export function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Drop `undefined` fields so optional inputs never serialise as `null`. */
export function stripUndefined<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function send(
    method: HttpMethod,
    path: string,
    request: HttpRequestOptions = {},
  ): Promise<Response> {
    const csrf = method === "GET" ? undefined : (request.csrf ?? options.csrfToken?.());
    const tenantId = request.tenantId ?? options.tenantId;
    const body = request.body;
    const headers: Record<string, string> = {
      accept: request.accept ?? "application/json",
      ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
      ...(body === undefined
        ? {}
        : { "content-type": "json" in body ? "application/json" : body.contentType }),
      ...request.headers,
    };
    const payload: BodyInit | undefined =
      body === undefined ? undefined : "json" in body ? JSON.stringify(body.json) : body.blob;
    try {
      return await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        credentials: "same-origin",
        ...(options.cache ? { cache: options.cache } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (err) {
      throw new ApiError("network", err instanceof Error ? err.message : String(err), 0);
    }
  }

  async function failure(method: HttpMethod, path: string, res: Response): Promise<ApiError> {
    const parsed = parseJson(await res.text());
    if (res.status === 401) options.onUnauthorized?.();
    const e = (parsed ?? {}) as { code?: ApiError["code"]; message?: string; details?: unknown };
    return new ApiError(
      e.code ?? "unknown",
      e.message ?? `${method} ${path} failed with ${res.status}`,
      res.status,
      (e.details as Record<string, unknown> | undefined) ?? {},
    );
  }

  async function request<T>(
    method: HttpMethod,
    path: string,
    init: HttpRequestOptions = {},
  ): Promise<T> {
    const res = await send(method, path, init);
    if (!res.ok) throw await failure(method, path, res);
    return parseJson(await res.text()) as T;
  }

  return {
    baseUrl,
    tenantId: options.tenantId,
    send,
    failure,
    request,
    json: (method, path, body) =>
      request(method, path, body === undefined ? {} : { body: { json: body } }),
    async download(path, init = {}) {
      const res = await send("GET", path, { accept: BINARY_ACCEPT, ...init });
      if (!res.ok) throw await failure("GET", path, res);
      return res;
    },
  };
}
