// One bounded host-side HTTP request with a Vault token (ADR-0045 decision 6). The definition
// fixes origin, method, route, parameters, header and effect; the model supplies parameter values
// only. The token is inserted as `Authorization: Bearer …` or one named header after every check,
// never into a URL or the workspace. The request passes the workspace egress list and an address
// check on every resolved address, is pinned to those addresses (no rebinding between check and
// connect), keeps normal TLS verification and follows no redirect. Private targets, ADR-0027's
// included, are refused: the host-side adapter has not shown equivalent enforcement for them.
//
// The answer carries the status, a content type and a bounded body; no response header is
// returned. A body that echoes the token in any form we know is withheld (decision 7).

import { lookup as dnsLookup } from "node:dns/promises";
import {
  VAULT_RESPONSE_MAX_BYTES,
  type VaultRequestDefinition,
  type VaultUseStatus,
  egressAllows,
} from "@deskmates/contracts";
import { pinnedDispatcher } from "../connectors/connector-proxy.js";
import { isPublicAddress } from "../net/public-address.js";

export const VAULT_HTTP_TIMEOUT_MS = 20_000;

export interface VaultHttpDeps {
  /** Tests pass a fake; production uses the global fetch with a pinned dispatcher. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lookup?: (host: string) => Promise<string[]>;
  addressAllowed?: (address: string) => boolean;
  timeoutMs?: number;
}

export interface VaultHttpCall {
  origin: string;
  definition: VaultRequestDefinition;
  params: Record<string, string | number | boolean>;
  token: string;
  egressAllowlist: readonly string[];
}

export interface VaultHttpOutcome {
  status: VaultUseStatus;
  /** Whether bytes may have reached the target; only then is a failure an unknown outcome. */
  sent: boolean;
  httpStatus?: number;
  contentType?: string;
  body?: string;
  bodyTruncated?: true;
}

/** The request URL and JSON body built from the definition and the checked parameters. */
export function buildVaultRequest(
  origin: string,
  definition: VaultRequestDefinition,
  params: Record<string, string | number | boolean>,
): { url: string; body?: string } {
  const path = definition.path.replace(/\{([^}]+)\}/g, (_m, name: string) =>
    encodeURIComponent(String(params[name] ?? "")),
  );
  // Each value stays inside its own segment: `encodeURIComponent` leaves `.` and `..` alone, and
  // a URL resolves them as dot segments, `/v1/items/..` to `/v1/` (decision 6).
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    throw new Error("request left its route");
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("request left its origin");
  if (url.pathname.split("/").length !== definition.path.split("/").length)
    throw new Error("request left its route");
  const body: Record<string, unknown> = {};
  for (const p of definition.params) {
    const value = params[p.name];
    if (value === undefined) continue;
    if (p.in === "query") url.searchParams.append(p.name, String(value));
    if (p.in === "body") body[p.name] = value;
  }
  return {
    url: url.toString(),
    ...(definition.params.some((p) => p.in === "body") ? { body: JSON.stringify(body) } : {}),
  };
}

/** The forms of the token a response could echo; any of them withholds the body (decision 7). */
export function tokenEchoes(token: string): string[] {
  const forms = new Set<string>([
    token,
    encodeURIComponent(token),
    JSON.stringify(token).slice(1, -1),
    Buffer.from(token, "utf8").toString("base64"),
    Buffer.from(token, "utf8").toString("base64url"),
  ]);
  return [...forms].filter((form) => form.length >= 4);
}

const TLS_CODES = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

function errorCode(err: unknown): string {
  let cursor: unknown = err;
  for (let i = 0; i < 4 && cursor && typeof cursor === "object"; i++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return "";
}

async function readBounded(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > VAULT_RESPONSE_MAX_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buffer = Buffer.concat(chunks).subarray(0, VAULT_RESPONSE_MAX_BYTES);
  return { text: buffer.toString("utf8"), truncated };
}

/** Executes the call once. Never retried here, never by the caller (decision 6). */
export async function vaultHttpRequest(
  deps: VaultHttpDeps,
  call: VaultHttpCall,
): Promise<VaultHttpOutcome> {
  const { url, body } = buildVaultRequest(call.origin, call.definition, call.params);
  const host = new URL(url).hostname;
  if (!egressAllows(host, call.egressAllowlist)) return { status: "egress_refused", sent: false };
  const lookup =
    deps.lookup ??
    (async (name: string) =>
      (await dnsLookup(name, { all: true, verbatim: true })).map((a) => a.address));
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return { status: "network_error", sent: false };
  }
  const allowed = deps.addressAllowed ?? isPublicAddress;
  if (addresses.length === 0 || !addresses.every(allowed))
    return { status: "address_refused", sent: false };

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Inserted last, after every check; the header name was validated when it was saved.
  if (call.definition.header.scheme === "bearer") headers.authorization = `Bearer ${call.token}`;
  else headers[call.definition.header.name.toLowerCase()] = call.token;

  const dispatcher = deps.fetch ? undefined : pinnedDispatcher(addresses);
  const send = deps.fetch ?? ((u: string, init: RequestInit) => globalThis.fetch(u, init));
  let res: Response;
  try {
    res = await send(url, {
      method: call.definition.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? VAULT_HTTP_TIMEOUT_MS),
      // undici and the DOM typings disagree on the dispatcher; the connector proxy casts alike.
      ...(dispatcher ? ({ dispatcher } as unknown as RequestInit) : {}),
    });
  } catch (err) {
    void dispatcher?.close();
    const code = errorCode(err);
    if (TLS_CODES.test(code)) return { status: "tls_failed", sent: false };
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN")
      return { status: "network_error", sent: false };
    // A timeout or a reset after connecting: the target may have acted on it (decision 6).
    return { status: call.definition.effect === "write" ? "unknown" : "network_error", sent: true };
  }
  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { status: "redirect_refused", sent: true, httpStatus: res.status };
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().slice(0, 100);
    const { text, truncated } = await readBounded(res);
    const status: VaultUseStatus =
      res.status >= 200 && res.status < 300
        ? "completed"
        : res.status === 401 || res.status === 403
          ? "auth_failed"
          : "http_error";
    const echoed = tokenEchoes(call.token).some((form) => text.includes(form));
    if (echoed)
      return {
        status: "result_withheld",
        sent: true,
        httpStatus: res.status,
        ...(contentType ? { contentType } : {}),
      };
    return {
      status,
      sent: true,
      httpStatus: res.status,
      ...(contentType ? { contentType } : {}),
      body: text,
      ...(truncated ? { bodyTruncated: true as const } : {}),
    };
  } catch {
    return { status: call.definition.effect === "write" ? "unknown" : "network_error", sent: true };
  } finally {
    void dispatcher?.close();
  }
}
