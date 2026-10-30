// The only file in the repository that knows the integration runtime's routes and tool names
// (ADR-0013 item 2). Everything else in the Gateway speaks in the shapes of `contracts`; replacing
// the runtime means replacing this file (and a new ADR).
//
// The runtime is OpenConnector v1.7.0 as `spikes/openconnector/` recorded it:
//   - admin API under `/api/*` and `/v1/providers/<service>/setup`, `Authorization: Bearer <admin
//     token>`. The whole list, `GET /v1/providers`, stops being an admin route the moment a
//     runtime token exists: v1.7.0 then wants a runtime token there and answers the admin token
//     with 401 (verified on the stable runtime, 2026-10-09), so the catalog is read through
//     `list_apps` with a Gateway-owned token (ADR-0013 amendment 3);
//   - the public `/oauth/callback`, bound to the `state` the runtime issued;
//   - `POST /mcp`, stateless Streamable HTTP, one JSON-RPC `tools/call` per request with a
//     runtime token, answered as JSON or as a one-event SSE body; the five meta-tools are
//     `list_apps`, `list_connections`, `search_actions`, `get_action_guide`, `execute_action`.
// Every call carries a deadline; a runtime that cannot be reached is `integration_unavailable`, an
// answer this file cannot read is `integration_protocol`.

import { DeskmatesError, isIntegrationOperationType } from "@deskmates/contracts";
import type { IntegrationActionInput, IntegrationOperationType } from "@deskmates/contracts";

/** Per-call deadline towards the runtime; shorter than the sidecar's own for these routes. */
export const RUNTIME_CALL_TIMEOUT_MS = 25_000;

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface RuntimeAdapterOptions {
  /** Base URL, including a mount prefix when the runtime's origin carries one. */
  url: string;
  adminToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** A connection as the runtime lists it. `virtual` ones are its no-auth providers. */
export interface RuntimeConnectionView {
  id: string;
  service: string;
  connectionName: string;
  authType: string;
  virtual: boolean;
  displayName?: string;
}

/** What a runtime token may do: exact connection ids and action patterns, sent whole. */
export interface RuntimeTokenPolicy {
  allowedActions: string[];
  allowedConnections: string[];
}

/** One `search_actions` entry, reduced to the fields the Gateway keeps. */
export interface RuntimeActionEntry {
  actionId: string;
  service: string;
  name: string;
  description: string;
  operationType: IntegrationOperationType;
  requiredScopes: string[];
  inputs: IntegrationActionInput[];
}

/** Full pinned catalog shape for operator-side acceptance preflight, never a sixth agent tool. */
export interface RuntimeActionDefinition {
  id: string;
  service: string;
  operationType: IntegrationOperationType;
  requiredScopes: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface RuntimeGuide {
  operationType: IntegrationOperationType;
  requiredScopes: string[];
  markdown: string;
}

/** A tool-level answer of `execute_action`: the action ran, or the runtime refused it. */
export interface RuntimeExecution {
  ok: boolean;
  data?: unknown;
  executionId?: string;
  error?: { code: string; message: string };
}

/** A refusal the runtime returned inside a tool result (`{ok:false, error}`), not a transport error. */
export class RuntimeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly executionId?: string,
  ) {
    super(message);
    this.name = "RuntimeToolError";
  }
}

/** One provider as the runtime lists it, from `list_apps` or `GET /v1/providers`. */
export interface RuntimeProviderListing {
  service: string;
  displayName: string;
  authTypes: string[];
}

/** The two listings share a row shape; unknown shapes fail as typed protocol errors. */
function parseProviderList(list: unknown): RuntimeProviderListing[] {
  if (!Array.isArray(list)) throw protocol("a provider list that is not an array");
  const out: RuntimeProviderListing[] = [];
  for (const item of list) {
    const p = record(item);
    const service =
      typeof p?.service === "string" ? p.service : typeof p?.id === "string" ? p.id : undefined;
    if (service === undefined) continue;
    const displayName =
      typeof p?.displayName === "string"
        ? p.displayName
        : typeof p?.name === "string"
          ? p.name
          : service;
    const auth = Array.isArray(p?.auth) ? p.auth : Array.isArray(p?.authTypes) ? p.authTypes : [];
    const authTypes = auth
      .map((a) => (typeof a === "string" ? a : record(a)?.type))
      .filter((t): t is string => typeof t === "string");
    out.push({ service, displayName, authTypes });
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function protocol(what: string, details: Record<string, unknown> = {}): DeskmatesError {
  return new DeskmatesError(
    "integration_protocol",
    `the integration runtime answered ${what}`,
    details,
  );
}

export class RuntimeAdapter {
  private readonly base: string;
  private nextId = 1;

  constructor(private readonly opts: RuntimeAdapterOptions) {
    this.base = opts.url.replace(/\/+$/, "");
  }

  // --- transport ---------------------------------------------------------------------------

  private async send(
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    try {
      return await this.opts.fetch(`${this.base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? RUNTIME_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      // The URL stays out of the error: it names the private network and this can reach a model.
      throw new DeskmatesError(
        "integration_unavailable",
        "the integration runtime could not be reached",
        {
          reason: err instanceof Error ? err.name : "error",
        },
      );
    }
  }

  private async readText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      throw new DeskmatesError(
        "integration_unavailable",
        "the integration runtime response was interrupted",
      );
    }
  }

  private async readJson(res: Response): Promise<unknown> {
    const text = await this.readText(res);
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw protocol("with a body that is not JSON", { status: res.status });
    }
  }

  /** An admin call: 2xx gives the JSON body; a runtime error becomes a typed Gateway error. */
  private async admin(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.send(method, path, this.opts.adminToken, body);
    if (res.ok) return await this.readJson(res);
    // An error status is mapped by its status: a reverse proxy's HTML 502 is the runtime being
    // unavailable, not a protocol break, so an unreadable error body is read as no body.
    const parsed = await this.readJson(res).catch((err: unknown) => {
      if (err instanceof DeskmatesError && err.code === "integration_protocol") return undefined;
      throw err;
    });
    const err = record(record(parsed)?.error);
    const code = typeof err?.code === "string" ? err.code : "error";
    const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403)
      throw new DeskmatesError(
        "integration_unavailable",
        "the integration runtime rejected the Gateway's admin token",
        { status: res.status },
      );
    if (res.status === 404) throw new DeskmatesError("not_found", message, { runtimeCode: code });
    if (res.status === 400) throw new DeskmatesError("validation", message, { runtimeCode: code });
    throw new DeskmatesError(
      "integration_unavailable",
      `the integration runtime answered HTTP ${res.status}`,
      {
        status: res.status,
        runtimeCode: code,
      },
    );
  }

  /**
   * One MCP `tools/call`. The payload is `structuredContent`, or the JSON text of the first
   * content block when a runtime omits it. `{ok:false, error}` is thrown as `RuntimeToolError` so
   * a caller decides what a refusal means; anything unreadable is `integration_protocol`.
   */
  private async tool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await this.send(
      "POST",
      "/mcp",
      token,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
    );
    if (res.status === 401 || res.status === 403)
      throw new DeskmatesError(
        "integration_unavailable",
        "the integration runtime rejected the workspace's runtime token",
        { status: res.status },
      );
    const text = await this.readText(res);
    if (!res.ok)
      throw new DeskmatesError(
        "integration_unavailable",
        `the integration runtime answered HTTP ${res.status}`,
        {
          status: res.status,
        },
      );
    const contentType = res.headers.get("content-type") ?? "";
    // v1.7.0 answers in a one-event SSE body even in JSON response mode (spike §2).
    const payload = contentType.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : text;
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(payload));
    } catch {
      throw protocol("an MCP message that is not JSON");
    }
    if (message?.jsonrpc !== "2.0" || message.id !== id)
      throw protocol("an MCP response for a different request");
    if (message?.error !== undefined) throw protocol("an MCP error", { tool: name });
    const result = record(message?.result);
    let structured = record(result?.structuredContent);
    if (structured === undefined) {
      const first = Array.isArray(result?.content) ? record(result.content[0]) : undefined;
      try {
        structured = typeof first?.text === "string" ? record(JSON.parse(first.text)) : undefined;
      } catch {
        structured = undefined;
      }
    }
    if (structured === undefined) throw protocol("a tool result without a payload", { tool: name });
    if (structured.ok === false) {
      const err = record(structured.error);
      throw new RuntimeToolError(
        typeof err?.code === "string" ? err.code : "error",
        typeof err?.message === "string" ? err.message : "refused",
        typeof structured.executionId === "string" ? structured.executionId : undefined,
      );
    }
    if (result?.isError === true) throw protocol("an MCP error without a refusal payload");
    return structured;
  }

  /**
   * Fetch a transit capability returned by a runtime action. Never follows redirects or sends
   * credentials. The caller must obtain this URL from that action, not from agent input.
   * Kept separate from execute: a failed transfer must never retry an external write.
   */
  async downloadTransit(downloadUrl: string, maxBytes = 1_048_576): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1_048_576)
      throw new DeskmatesError("validation", "invalid integration artifact size limit");
    const base = new URL(this.base);
    let url: URL;
    try {
      url = new URL(downloadUrl);
    } catch {
      throw protocol("an invalid transit URL");
    }
    const prefix = `${base.pathname.replace(/\/$/, "")}/api/files/`;
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      !/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(url.pathname.slice(prefix.length))
    )
      throw protocol("a transit URL outside its file store");
    const res = await this.send(
      "GET",
      url.pathname.slice(base.pathname.replace(/\/$/, "").length),
      undefined,
    );
    const reader = res.body?.getReader();
    try {
      if (!res.ok)
        throw new DeskmatesError(
          "integration_unavailable",
          "integration artifact download failed",
          {
            status: res.status,
          },
        );
      const length = Number(res.headers.get("content-length"));
      if (length > maxBytes)
        throw new DeskmatesError(
          "payload_too_large",
          "integration artifact exceeds the download limit",
        );
      if (!reader) throw protocol("a transit response without a body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes)
          throw new DeskmatesError(
            "payload_too_large",
            "integration artifact exceeds the download limit",
          );
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    } catch (err) {
      if (err instanceof DeskmatesError) throw err;
      throw new DeskmatesError(
        "integration_unavailable",
        "integration artifact transfer was interrupted",
      );
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }

  // --- admin: providers, connections, tokens -------------------------------------------------

  /** Full pinned definition for acceptance preflight; never exposed with the admin credential. */
  async actionDefinition(actionId: string): Promise<RuntimeActionDefinition> {
    const data = record(await this.admin("GET", `/api/actions/${encodeURIComponent(actionId)}`));
    if (
      data?.id !== actionId ||
      typeof data.service !== "string" ||
      !actionId.startsWith(`${data.service}.`) ||
      !isIntegrationOperationType(data.operationType) ||
      !Array.isArray(data.requiredScopes) ||
      data.requiredScopes.some((scope) => typeof scope !== "string") ||
      !record(data.inputSchema) ||
      !record(data.outputSchema)
    )
      throw protocol("an action definition without exact identity and schemas");
    return {
      id: actionId,
      service: data.service,
      operationType: data.operationType,
      requiredScopes: strings(data.requiredScopes),
      inputSchema: data.inputSchema as Record<string, unknown>,
      outputSchema: data.outputSchema as Record<string, unknown>,
    };
  }

  /**
   * The whole provider catalog through the MCP `list_apps` tool under a runtime token (ADR-0013
   * amendment 3). Unfiltered on purpose: this is the operator's catalog, read once per request
   * and never put in model context (about 700 KB on v1.7.0).
   */
  async listApps(token: string): Promise<RuntimeProviderListing[]> {
    const payload = await this.tool(token, "list_apps", {});
    return parseProviderList(payload.data);
  }

  /**
   * `GET /v1/providers` with the admin token. Answered only while the runtime has no runtime
   * token at all (v1.7.0 turns authentication on with the first one and then refuses the admin
   * token here), so this is the fallback for a runtime nobody has minted a token on yet.
   */
  async listProviders(): Promise<RuntimeProviderListing[]> {
    const body = await this.admin("GET", "/v1/providers");
    return parseProviderList(Array.isArray(body) ? body : record(body)?.data);
  }

  /** Auth types the runtime reports for a provider, or undefined when it has no such provider. */
  async providerAuthTypes(service: string): Promise<string[] | undefined> {
    try {
      const body = record(
        await this.admin("GET", `/v1/providers/${encodeURIComponent(service)}/setup`),
      );
      const auth = record(body?.data)?.auth;
      if (!Array.isArray(auth)) throw protocol("a provider setup without auth types");
      return auth.map((a) => record(a)?.type).filter((t): t is string => typeof t === "string");
    } catch (err) {
      if (err instanceof DeskmatesError && err.code === "not_found") return undefined;
      throw err;
    }
  }

  private connectionView(value: unknown): RuntimeConnectionView {
    const c = record(value);
    if (
      typeof c?.id !== "string" ||
      typeof c.service !== "string" ||
      typeof c.connectionName !== "string"
    )
      throw protocol("a connection without id, service and name");
    const displayName = record(c.profile)?.displayName;
    return {
      id: c.id,
      service: c.service,
      connectionName: c.connectionName,
      authType: typeof c.authType === "string" ? c.authType : "unknown",
      virtual: c.virtual === true || c.authType === "no_auth",
      ...(typeof displayName === "string" ? { displayName } : {}),
    };
  }

  /** Every connection the runtime holds (admin view). */
  async listAllConnections(): Promise<RuntimeConnectionView[]> {
    const body = await this.admin("GET", "/api/connections");
    const list = Array.isArray(body) ? body : record(body)?.data;
    if (!Array.isArray(list)) throw protocol("a connection list that is not an array");
    return list.map((c) => this.connectionView(c));
  }

  /** Create or replace an API-key connection; the runtime validates the key with the provider. */
  async putApiKeyConnection(
    service: string,
    connectionName: string,
    values: Record<string, string>,
  ): Promise<RuntimeConnectionView> {
    return this.connectionView(
      await this.admin("PUT", `/api/connections/${encodeURIComponent(service)}`, {
        authType: "api_key",
        connectionName,
        values,
      }),
    );
  }

  /** Remove a connection and its credential from the runtime; an absent one is not an error. */
  async deleteConnection(service: string, connectionName: string): Promise<void> {
    try {
      await this.admin("DELETE", `/api/connections/${encodeURIComponent(service)}`, {
        connectionName,
      });
    } catch (err) {
      if (err instanceof DeskmatesError && err.code === "not_found") return;
      throw err;
    }
  }

  private tokenBody(name: string, policy: RuntimeTokenPolicy): Record<string, unknown> {
    return {
      name,
      allowedActions: policy.allowedActions,
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: policy.allowedConnections,
    };
  }

  async createToken(
    name: string,
    policy: RuntimeTokenPolicy,
  ): Promise<{ id: string; token: string }> {
    const body = record(
      await this.admin("POST", "/api/runtime-tokens", this.tokenBody(name, policy)),
    );
    const id = record(body?.record)?.id;
    if (typeof body?.token !== "string" || typeof id !== "string")
      throw protocol("a runtime token without token and id");
    return { id, token: body.token };
  }

  /** The grant list is replaced, never merged: the runtime keeps only what this call sends. */
  async updateToken(id: string, name: string, policy: RuntimeTokenPolicy): Promise<void> {
    await this.admin(
      "PUT",
      `/api/runtime-tokens/${encodeURIComponent(id)}`,
      this.tokenBody(name, policy),
    );
  }

  async revokeToken(id: string): Promise<void> {
    try {
      await this.admin("DELETE", `/api/runtime-tokens/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof DeskmatesError && err.code === "not_found") return;
      throw err;
    }
  }

  // --- admin: OAuth ----------------------------------------------------------------------

  /** Give the runtime a provider's OAuth app, redirecting to the Gateway's callback (topology B). */
  async putOAuthApp(
    service: string,
    app: {
      clientId: string;
      clientSecret: string;
      requestedScopes?: string[];
      redirectUri: string;
    },
  ): Promise<{ expectedRedirectUri?: string }> {
    const body = record(
      await this.admin("PUT", `/api/oauth/configs/${encodeURIComponent(service)}`, {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri: app.redirectUri,
        ...(app.requestedScopes ? { requestedScopes: app.requestedScopes } : {}),
      }),
    );
    return typeof body?.expectedRedirectUri === "string"
      ? { expectedRedirectUri: body.expectedRedirectUri }
      : {};
  }

  async startOAuth(
    service: string,
    connectionName: string,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const body = record(
      await this.admin("POST", "/api/oauth/authorizations", { service, connectionName }),
    );
    if (typeof body?.authorizationUrl !== "string" || typeof body.state !== "string")
      throw protocol("an authorization without a URL and state");
    return { authorizationUrl: body.authorizationUrl, state: body.state };
  }

  /**
   * Forward the provider's redirect query (`code` and `state`, or `error`) to the runtime's
   * callback, which exchanges the code. 2xx and 3xx mean the grant completed.
   */
  async completeOAuth(query: URLSearchParams): Promise<{ ok: boolean; code?: string }> {
    const res = await this.send("GET", `/oauth/callback?${query.toString()}`, undefined);
    if (res.status >= 200 && res.status < 400) {
      await res.body?.cancel();
      return { ok: true };
    }
    const parsed = record(await this.readJson(res).catch(() => undefined));
    const code = record(parsed?.error)?.code;
    return { ok: false, code: typeof code === "string" ? code : `http_${res.status}` };
  }

  // --- the five meta-tools ----------------------------------------------------------------

  async listConnections(token: string, service?: string): Promise<RuntimeConnectionView[]> {
    const data = (await this.tool(token, "list_connections", service ? { service } : {})).data;
    if (!Array.isArray(data)) throw protocol("list_connections without a data array");
    return data.map((c) => this.connectionView(c));
  }

  async searchActions(
    token: string,
    args: { service: string; query?: string; limit: number },
  ): Promise<RuntimeActionEntry[]> {
    const data = (
      await this.tool(token, "search_actions", {
        service: args.service,
        limit: args.limit,
        ...(args.query ? { query: args.query } : {}),
      })
    ).data;
    if (!Array.isArray(data)) throw protocol("search_actions without a data array");
    return data.flatMap((entry) => {
      const e = record(entry);
      if (
        typeof e?.id !== "string" ||
        e.service !== args.service ||
        !e.id.startsWith(`${args.service}.`)
      )
        return [];
      const capability = record(e.capability);
      const operationType = e.operationType ?? capability?.operationType;
      // An action without a known classification is not offered: its tier would be a guess.
      if (!isIntegrationOperationType(operationType)) return [];
      const inputs = Array.isArray(e.inputSummary)
        ? e.inputSummary.flatMap((i) => {
            const r = record(i);
            if (typeof r?.name !== "string") return [];
            return [
              {
                name: r.name,
                required: r.required === true,
                type: typeof r.type === "string" ? r.type : "unknown",
                ...(typeof r.description === "string" ? { description: r.description } : {}),
              },
            ];
          })
        : [];
      return [
        {
          actionId: e.id,
          service: e.service,
          name: typeof e.name === "string" ? e.name : e.id.slice(e.service.length + 1),
          description: typeof e.description === "string" ? e.description : "",
          operationType,
          requiredScopes: strings(capability?.requiredScopes),
          inputs,
        },
      ];
    });
  }

  async actionGuide(
    token: string,
    actionId: string,
    connectionName: string,
  ): Promise<RuntimeGuide> {
    const data = record(
      (await this.tool(token, "get_action_guide", { actionId, connectionName })).data,
    );
    const capability = record(data?.capability);
    if (
      typeof data?.markdown !== "string" ||
      !isIntegrationOperationType(capability?.operationType)
    )
      throw protocol("a guide without markdown and operationType");
    return {
      operationType: capability.operationType,
      requiredScopes: strings(capability.requiredScopes),
      markdown: data.markdown,
    };
  }

  /** Always with an explicit connection name: the default connection is never used (Amendment 1). */
  async executeAction(
    token: string,
    actionId: string,
    connectionName: string,
    input: Record<string, unknown>,
  ): Promise<RuntimeExecution> {
    try {
      const out = await this.tool(token, "execute_action", { actionId, connectionName, input });
      return {
        ok: true,
        data: out.data,
        ...(typeof out.executionId === "string" ? { executionId: out.executionId } : {}),
      };
    } catch (err) {
      if (err instanceof RuntimeToolError)
        return {
          ok: false,
          error: { code: err.code, message: err.message },
          ...(err.executionId === undefined ? {} : { executionId: err.executionId }),
        };
      throw err;
    }
  }
}
