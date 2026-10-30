// HTTP client for the sidecar → Gateway internal routes. Every call carries the run's short-lived
// token as `Authorization: Bearer`; the same token authenticates model calls (contracts).
//
// Routes, all under `{gatewayBaseUrl}/internal/runs/{runId}`:
//   POST /events        body: SidecarEvent[]            -> 2xx
//   POST /ended         body: RunEnded                  -> 2xx
//   POST /approvals     body: ApprovalRequest           -> 200 ApprovalResponse (decided at once)
//                                                       | 202 (pending; poll)
//   GET  /approvals/:id                                 -> 200 ApprovalResponse | 202 | 404 (pending)
//   POST /approvals/:id/decide  body: ApprovalDecideRequest -> 2xx
//   GET  /egress                                        -> 200 EgressAllowlistResponse
//   POST /browser-lock  body: BrowserLockRequest        -> 200 BrowserLockResponse
//   POST /desktop-lock  body: DesktopLockRequest        -> 200 DesktopLockResponse
//   POST /messages      body: PostMessageRequest        -> 2xx
//   GET  /memory/search?q=&scope=                       -> 200 { entries: MemorySearchHit[] }
//   POST /connectors/:c/describe | validate | submit, GET /connectors/:c/status/:r | receipt/:r
//        | validations/:v                                -> 200 | typed DeskmatesError body
//   GET /integrations/apps | connections, POST /integrations/search | guide | execute,
//   GET /integrations/actions/:actionId/tier             -> 200 | typed DeskmatesError body
//   GET /vault/entries | entries/:id, POST /vault/fill | request -> 200 references, typed outcome
//   POST /tasks/:taskId/deliver  body: {summary, artifacts, output?} -> 200 TaskDeliverResponse
//                                                        | typed DeskmatesError body
//   GET  /run-stats?windowDays=N                         -> 200 RunStatsReport (ADR-0050)
//   POST /assistant/bots | bots/:name | groups           -> 2xx AssistantBotResult |
//        AssistantGroupResult | typed DeskmatesError body (ADR-0051)
// The protocol file only fixes the message shapes and the `/internal/runs/{runId}/...` prefix;
// the path suffixes and status conventions above are what this client assumes of the Gateway.

import { randomUUID } from "node:crypto";
import {
  type AppPublishRequest,
  type AppPublishResponse,
  type ApprovalDecideRequest,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalResponse,
  type AsrOperationRequest,
  type AsrOperationResponse,
  type AssistantBotCreateRequest,
  type AssistantBotResult,
  type AssistantBotUpdateRequest,
  type AssistantGroupCreateRequest,
  type AssistantGroupResult,
  type BrowserLockRequest,
  type BrowserLockResponse,
  type BrowserOriginRequest,
  type BrowserOriginResponse,
  type ConnectorCapabilities,
  type ConnectorReceiptRecord,
  type ConnectorSubmitResponse,
  DeskmatesError,
  type DeskmatesErrorCode,
  type DesktopLockRequest,
  type DesktopLockResponse,
  type EgressAllowlistResponse,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type IntegrationActionTier,
  type IntegrationAppsResult,
  type IntegrationConnectionsResult,
  type IntegrationExecuteResult,
  type IntegrationGuideResult,
  type IntegrationSearchResult,
  type KnowledgeDocument,
  type KnowledgeHit,
  type KnowledgeProposal,
  type LookOperationRequest,
  type LookOperationResponse,
  type MemorySearchHit,
  type PhaseTimingSample,
  type PostMessageRequest,
  type PostedMessageRouting,
  type ReplyPreviewRequest,
  type RunEnded,
  type RunId,
  type RunStatsReport,
  type SessionStartedReport,
  type SidecarEvent,
  type SidecarEventsAck,
  type StoredConnectorValidation,
  type TaskCheckpointRequest,
  type TaskCheckpointResponse,
  type TaskDeliverRequest,
  type TaskDeliverResponse,
  type VaultFillUseRequest,
  type VaultListing,
  type VaultRequestUseRequest,
  type VaultToolEntry,
  type VaultUseResult,
  type WebSearchRequest,
  type WebSearchResponse,
  isDeskmatesErrorCode,
} from "@deskmates/contracts";

/** The Gateway's fill command waits 15 s and an HTTP use 20 s (ADR-0045); a little longer here. */
export const VAULT_USE_TIMEOUT_MS = 30_000;

/**
 * Per-request deadline. Without it a Gateway that accepts the connection and never answers hangs
 * the run forever: the approval poll loop, the ledger batch and the final `run_ended` post all sit
 * on one `fetch`. 10 s is far longer than any of these routes needs and far shorter than the
 * shortest short wait.
 */
export const GATEWAY_TIMEOUT_MS = 10_000;

/**
 * Deadline for a connector route: the Gateway calls the connector inside the request, with its
 * own 25 s deadline, so the sidecar waits a little longer and hears the typed error instead.
 */
export const CONNECTOR_TIMEOUT_MS = 30_000;

/** The Gateway waits up to 120 s for one look call (ADR-0040); the sidecar a little longer. */
export const LOOK_OPERATION_TIMEOUT_MS = 130_000;
/** The Gateway waits up to 300 s for one transcription (ADR-0040). */
export const ASR_OPERATION_TIMEOUT_MS = 310_000;
/** The Gateway waits up to 300 s for one image generation (ADR-0040 amendment B). */
export const IMAGE_OPERATION_TIMEOUT_MS = 310_000;
/** The Gateway waits up to 15 s for one search (ADR-0049 decision 3); the sidecar a little longer. */
export const WEB_SEARCH_CLIENT_TIMEOUT_MS = 20_000;

export interface GatewayClientOptions {
  /** Per-request timeout; tests shorten it. */
  timeoutMs?: number;
}

export class GatewayClient {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly fetchFn: typeof globalThis.fetch,
    gatewayBaseUrl: string,
    private readonly runId: RunId,
    private readonly token: string,
    opts: GatewayClientOptions = {},
  ) {
    this.base = `${gatewayBaseUrl.replace(/\/+$/, "")}/internal/runs/${encodeURIComponent(runId)}`;
    this.timeoutMs = opts.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  }

  async knowledgeSearch(query: string): Promise<KnowledgeHit[]> {
    const response = await this.send("GET", `/knowledge/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Knowledge search unavailable");
    return ((await response.json()) as { documents: KnowledgeHit[] }).documents;
  }
  /** `GET /memory/search`: this run's workspace only; the Gateway scopes it by the run token. */
  async memorySearch(query: string, scope?: string): Promise<MemorySearchHit[]> {
    const params = new URLSearchParams({ q: query });
    if (scope) params.set("scope", scope);
    const response = await this.send("GET", `/memory/search?${params.toString()}`);
    if (!response.ok) throw new Error("Memory search unavailable");
    return ((await response.json()) as { entries: MemorySearchHit[] }).entries;
  }
  async knowledgeRead(id: string): Promise<KnowledgeDocument> {
    const response = await this.send("GET", `/knowledge/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Published knowledge unavailable");
    return ((await response.json()) as { document: KnowledgeDocument }).document;
  }
  async knowledgePropose(title: string, body: string): Promise<KnowledgeProposal> {
    const response = await this.send("POST", "/knowledge/proposals", { title, body });
    if (!response.ok) throw new Error("Knowledge proposal was not recorded");
    return ((await response.json()) as { proposal: KnowledgeProposal }).proposal;
  }

  // Connector routes (ADR-0012). The Gateway is the only caller of a connector; the sidecar only
  // ever names it. A refusal comes back as the Gateway's typed error, so the tool can tell the
  // model which rule it broke (hash mismatch, stale validation, ...).
  async connectorDescribe(connector: string): Promise<ConnectorCapabilities> {
    const body = await this.connectorCall<{ capabilities: ConnectorCapabilities }>(
      "POST",
      connector,
      "/describe",
      {},
    );
    return body.capabilities;
  }
  async connectorValidate(
    connector: string,
    submission: unknown,
  ): Promise<StoredConnectorValidation> {
    const body = await this.connectorCall<{ validation: StoredConnectorValidation }>(
      "POST",
      connector,
      "/validate",
      { submission },
    );
    return body.validation;
  }
  async connectorSubmit(
    connector: string,
    req: { validationId: string; contentHash: string; idempotencyKey?: string },
  ): Promise<ConnectorSubmitResponse> {
    return this.connectorCall<ConnectorSubmitResponse>("POST", connector, "/submit", req);
  }
  async connectorStatus(connector: string, receiptId: string): Promise<ConnectorReceiptRecord> {
    const path = `/status/${encodeURIComponent(receiptId)}`;
    return (await this.connectorCall<{ receipt: ConnectorReceiptRecord }>("GET", connector, path))
      .receipt;
  }
  async connectorReceipt(connector: string, receiptId: string): Promise<ConnectorReceiptRecord> {
    const path = `/receipt/${encodeURIComponent(receiptId)}`;
    return (await this.connectorCall<{ receipt: ConnectorReceiptRecord }>("GET", connector, path))
      .receipt;
  }
  /** The Gateway's stored validation: what the PreToolUse hook tiers a submit by. */
  async connectorValidation(
    connector: string,
    validationId: string,
  ): Promise<StoredConnectorValidation> {
    const path = `/validations/${encodeURIComponent(validationId)}`;
    return (
      await this.connectorCall<{ validation: StoredConnectorValidation }>("GET", connector, path)
    ).validation;
  }

  // Integration routes (ADR-0013 item 5). The Gateway is the only caller of the integration
  // runtime; the sidecar never learns its URL or a token for it.
  async integrationApps(): Promise<IntegrationAppsResult> {
    return this.integrationCall("GET", "/apps");
  }
  async integrationConnections(service?: string): Promise<IntegrationConnectionsResult> {
    const q = service ? `?service=${encodeURIComponent(service)}` : "";
    return this.integrationCall("GET", `/connections${q}`);
  }
  async integrationSearch(body: {
    service: string;
    query?: string;
    limit?: number;
  }): Promise<IntegrationSearchResult> {
    return this.integrationCall("POST", "/search", body);
  }
  async integrationGuide(body: {
    actionId: string;
    connectionName?: string;
  }): Promise<IntegrationGuideResult> {
    return this.integrationCall("POST", "/guide", body);
  }
  async integrationExecute(body: {
    actionId: string;
    connectionName?: string;
    input: Record<string, unknown>;
  }): Promise<IntegrationExecuteResult> {
    return this.integrationCall("POST", "/execute", body);
  }
  /** What the PreToolUse hook tiers `integration_execute` by: the catalog, never the input. */
  async integrationTier(actionId: string, connectionName?: string): Promise<IntegrationActionTier> {
    const q = connectionName ? `?connectionName=${encodeURIComponent(connectionName)}` : "";
    return this.integrationCall("GET", `/actions/${encodeURIComponent(actionId)}/tier${q}`);
  }

  /** `run_stats` (ADR-0050): this run's bot in this run's workspace; the token is the scope. */
  async runStats(windowDays?: number): Promise<RunStatsReport> {
    const q = windowDays === undefined ? "" : `?windowDays=${windowDays}`;
    return this.gatewayCall("GET", `/run-stats${q}`, undefined, "sandbox_unavailable");
  }

  // Workspace default bot (ADR-0051): only a run of the default bot is answered.
  async assistantCreateBot(request: AssistantBotCreateRequest): Promise<AssistantBotResult> {
    return this.gatewayCall("POST", "/assistant/bots", request, "sandbox_unavailable");
  }

  async assistantUpdateBot(
    name: string,
    request: AssistantBotUpdateRequest,
  ): Promise<AssistantBotResult> {
    const path = `/assistant/bots/${encodeURIComponent(name)}`;
    return this.gatewayCall("POST", path, request, "sandbox_unavailable");
  }

  async assistantCreateGroup(request: AssistantGroupCreateRequest): Promise<AssistantGroupResult> {
    return this.gatewayCall("POST", "/assistant/groups", request, "sandbox_unavailable");
  }

  // Vault routes (ADR-0045). References and typed outcomes only: no route returns a value.
  async vaultList(): Promise<VaultListing> {
    return this.gatewayCall("GET", "/vault/entries", undefined, "sandbox_unavailable");
  }
  /** What the PreToolUse hook builds a credential release's action from: the entry, not the input. */
  async vaultEntry(entryId: string): Promise<VaultToolEntry & { enabled: boolean }> {
    return (
      await this.gatewayCall<{ entry: VaultToolEntry & { enabled: boolean } }>(
        "GET",
        `/vault/entries/${encodeURIComponent(entryId)}`,
        undefined,
        "sandbox_unavailable",
      )
    ).entry;
  }
  /** Never retried: a repeat with the same approval gets the recorded answer (decision 6). */
  async vaultFill(body: VaultFillUseRequest): Promise<VaultUseResult> {
    return this.gatewayCall(
      "POST",
      "/vault/fill",
      body,
      "sandbox_unavailable",
      VAULT_USE_TIMEOUT_MS,
    );
  }
  async vaultRequest(body: VaultRequestUseRequest): Promise<VaultUseResult> {
    return this.gatewayCall(
      "POST",
      "/vault/request",
      body,
      "sandbox_unavailable",
      VAULT_USE_TIMEOUT_MS,
    );
  }

  /**
   * `task_deliver` (ADR-0021 amendment 2). Not retried: the model sees a refusal and may call
   * again. A refusal comes back as the Gateway's typed error, schema errors in `details.errors`.
   */
  async deliverTask(req: TaskDeliverRequest): Promise<TaskDeliverResponse> {
    const { taskId, ...body } = req;
    return this.gatewayCall<TaskDeliverResponse>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/deliver`,
      body,
      // Only a non-Gateway answer lacks a typed code; the HTTP status is kept in `details`.
      "sandbox_unavailable",
    );
  }

  /** `app_publish` (ADR-0035 decision 1). The Gateway binds workspace, bot and run itself. */
  async publishApp(req: AppPublishRequest): Promise<AppPublishResponse> {
    return this.gatewayCall<AppPublishResponse>("POST", "/app-shares", req, "sandbox_unavailable");
  }

  /** `image_describe` (ADR-0040): one image or rendered page; the Gateway picks the service. */
  async look(req: LookOperationRequest): Promise<LookOperationResponse> {
    return this.gatewayCall<LookOperationResponse>(
      "POST",
      "/operations/look",
      req,
      "operation_unavailable",
      LOOK_OPERATION_TIMEOUT_MS,
    );
  }

  /** `audio_transcribe` (ADR-0040): one audio file. */
  async transcribe(req: AsrOperationRequest): Promise<AsrOperationResponse> {
    return this.gatewayCall<AsrOperationResponse>(
      "POST",
      "/operations/asr",
      req,
      "operation_unavailable",
      ASR_OPERATION_TIMEOUT_MS,
    );
  }

  /** `image_generate` (ADR-0040 amendment B): one text-to-image call. */
  async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    return this.gatewayCall<ImageGenerationResponse>(
      "POST",
      "/operations/image_generation",
      req,
      "operation_unavailable",
      IMAGE_OPERATION_TIMEOUT_MS,
    );
  }

  /** `web_search` (ADR-0049): one bounded query; the Gateway picks the service and filters. */
  async webSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
    return this.gatewayCall<WebSearchResponse>(
      "POST",
      "/search",
      req,
      "operation_unavailable",
      WEB_SEARCH_CLIENT_TIMEOUT_MS,
    );
  }

  /** `task_checkpoint` (ADR-0021 A3h). The Gateway binds run, attempt and bot itself. */
  async checkpointTask(req: TaskCheckpointRequest): Promise<TaskCheckpointResponse> {
    const { taskId, ...body } = req;
    return this.gatewayCall<TaskCheckpointResponse>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/checkpoints`,
      body,
      "sandbox_unavailable",
    );
  }

  private integrationCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return this.gatewayCall<T>(method, `/integrations${path}`, body, "integration_unavailable");
  }

  private connectorCall<T>(
    method: "GET" | "POST",
    connector: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.gatewayCall<T>(
      method,
      `/connectors/${encodeURIComponent(connector)}${path}`,
      body,
      "connector_unavailable",
    );
  }

  /** A call whose refusal comes back as the Gateway's typed error body. */
  private async gatewayCall<T>(
    method: "GET" | "POST",
    fullPath: string,
    body: unknown,
    unavailable: DeskmatesErrorCode,
    timeoutMs: number = CONNECTOR_TIMEOUT_MS,
  ): Promise<T> {
    const res = await this.send(method, fullPath, body, undefined, timeoutMs);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
      throw new DeskmatesError(
        // The Gateway answers with a `DeskmatesErrorCode`; anything else is reported as unavailable.
        typeof err.code === "string" ? (err.code as DeskmatesErrorCode) : unavailable,
        typeof err.message === "string" ? err.message : `HTTP ${res.status}`,
        err.details && typeof err.details === "object"
          ? (err.details as Record<string, unknown>)
          : { status: res.status },
      );
    }
    return parsed as T;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    callerSignal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.fetchFn(`${this.base}${path}`, init);
  }

  /**
   * A refusal carries the Gateway's stable `{code, message, details}` body (`api/errors.ts`), and
   * that body is what a tool can act on: a second decision on one approval reaches the model as
   * "approval ap-1 was already allow_once" rather than a bare "HTTP 409" it can only retry. A body
   * that is not a Deskmates error (a proxy's HTML page, a plain-text 503) keeps the status message.
   */
  private async expectOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const fallback = `gateway ${what} failed: HTTP ${res.status}`;
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const body = (parsed !== null && typeof parsed === "object" ? parsed : {}) as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (!isDeskmatesErrorCode(body.code)) throw new Error(fallback);
    const details =
      body.details !== null && typeof body.details === "object" && !Array.isArray(body.details)
        ? { ...(body.details as Record<string, unknown>), status: res.status }
        : { status: res.status };
    throw new DeskmatesError(
      body.code,
      typeof body.message === "string" && body.message !== "" ? body.message : fallback,
      details,
    );
  }

  /**
   * The Gateway's acknowledgement says whether it is draining (ADR-0029 decision 2); a body that
   * is not an acknowledgement (an older Gateway, a proxy) reads as "not draining".
   */
  async postEvents(events: readonly SidecarEvent[]): Promise<SidecarEventsAck | undefined> {
    if (events.length === 0) return undefined;
    const res = await this.send("POST", "/events", events);
    await this.expectOk(res, "events");
    const text = await res.text().catch(() => "");
    try {
      const body = JSON.parse(text) as Partial<SidecarEventsAck>;
      return typeof body.stored === "number"
        ? { stored: body.stored, ...(body.drain === true ? { drain: true as const } : {}) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** ADR-0029 decision 4: the SDK session this attempt runs on, kept off the ledger. */
  async reportSession(attempt: number, sdkSessionId: string): Promise<void> {
    const report: SessionStartedReport = {
      type: "session_started",
      runId: this.runId,
      attempt,
      sdkSessionId,
    };
    await this.expectOk(await this.send("POST", "/session", report), "session report");
  }

  async postTimings(samples: readonly PhaseTimingSample[], attempt: number): Promise<void> {
    if (samples.length === 0) return;
    const events = samples.map((sample) => ({
      type: "event" as const,
      runId: this.runId,
      attempt,
      kind: "log" as const,
      payload: sample,
      ts: sample.at,
    }));
    await this.expectOk(await this.send("POST", "/events", events), "phase timings");
  }

  /** ADR-0037 decision 7: one cumulative reply preview frame; not retried. */
  async postReplyPreview(preview: ReplyPreviewRequest): Promise<void> {
    await this.expectOk(await this.send("POST", "/reply-preview", preview), "reply preview");
  }

  async postEnded(ended: RunEnded): Promise<void> {
    await this.expectOk(await this.send("POST", "/ended", ended), "ended");
  }

  /**
   * Returns the decision when the Gateway answers at once, undefined while pending. Retried once:
   * this is the post that creates the approval row, so losing it to one transient failure would
   * deny an L2 call no human ever saw. `approvalId` is chosen by the sidecar, so the retry is
   * idempotent from the Gateway's side.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalResponse | undefined> {
    try {
      return await this.postApproval(req);
    } catch {
      return this.postApproval(req);
    }
  }

  private async postApproval(req: ApprovalRequest): Promise<ApprovalResponse | undefined> {
    const res = await this.send("POST", "/approvals", req);
    if (res.status === 202) return undefined;
    await this.expectOk(res, "approval request");
    return this.parseApproval(res);
  }

  /** Undefined while the Gateway has no decision yet. */
  async getApproval(approvalId: ApprovalId): Promise<ApprovalResponse | undefined> {
    const res = await this.send("GET", `/approvals/${encodeURIComponent(approvalId)}`);
    if (res.status === 202 || res.status === 404) return undefined;
    await this.expectOk(res, "approval poll");
    return this.parseApproval(res);
  }

  private async parseApproval(res: Response): Promise<ApprovalResponse | undefined> {
    const text = await res.text();
    if (text.trim() === "") return undefined;
    const body = JSON.parse(text) as Partial<ApprovalResponse>;
    if (body.type !== "approval_response" || body.decision === undefined) return undefined;
    return body as ApprovalResponse;
  }

  /**
   * A bot member of the thread decides a pending approval (ADR-0002 amendment 2, A2). Not
   * retried: unlike `requestApproval` this is not idempotent from the Gateway's side — a second
   * decision on the same approval is `409 invalid_transition` — and the model can call the tool
   * again. Throws with the status so the tool can hand the model a readable result.
   */
  async decideApproval(req: ApprovalDecideRequest): Promise<void> {
    const path = `/approvals/${encodeURIComponent(req.approvalId)}/decide`;
    await this.expectOk(await this.send("POST", path, req), "approval decide");
  }

  /**
   * The workspace's egress allowlist as it stands now. The hook asks before every navigation check
   * so an operator's edit reaches a run already in flight; a failure is not a wider list, it is the
   * last list the hook had (design v0.3 §3.10, deny by default).
   */
  async getBrowserRetention(): Promise<{ targetIds: string[] }> {
    const response = await this.send("GET", "/browser-retention");
    await this.expectOk(response, "browser retention");
    const value = (await response.json()) as { targetIds?: unknown };
    if (
      !Array.isArray(value.targetIds) ||
      value.targetIds.length > 20 ||
      !value.targetIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
    )
      throw new Error("Invalid browser retention candidates");
    return { targetIds: value.targetIds as string[] };
  }
  async browserRetentionClosed(targetIds: string[]): Promise<void> {
    await this.expectOk(
      await this.send("POST", "/browser-retention/closed", { targetIds }),
      "browser retention closed",
    );
  }

  async getEgressAllowlist(): Promise<EgressAllowlistResponse> {
    const res = await this.send("GET", "/egress");
    await this.expectOk(res, "egress allowlist");
    return (await res.json()) as EgressAllowlistResponse;
  }

  async browserLock(req: BrowserLockRequest): Promise<BrowserLockResponse> {
    const res = await this.send("POST", "/browser-lock", req);
    await this.expectOk(res, "browser lock");
    return (await res.json()) as BrowserLockResponse;
  }

  /** ADR-0048 amendment 1, A3: a desktop call's shared-screen lease, or the hook's probe. */
  async desktopLock(req: DesktopLockRequest): Promise<DesktopLockResponse> {
    const res = await this.send("POST", "/desktop-lock", req);
    await this.expectOk(res, "desktop lock");
    return (await res.json()) as DesktopLockResponse;
  }

  async browserOrigin(
    req: BrowserOriginRequest,
    signal?: AbortSignal,
  ): Promise<BrowserOriginResponse> {
    const res = await this.send("POST", "/browser-origin", req, signal);
    await this.expectOk(res, "browser origin");
    return (await res.json()) as BrowserOriginResponse;
  }

  /**
   * Returns the Gateway's routing facts about a `thread_post`, or nothing for `message_bot` and
   * for a Gateway that does not send them.
   */
  async postMessage(req: PostMessageRequest): Promise<PostedMessageRouting | undefined> {
    const res = await this.send("POST", "/messages", {
      ...req,
      requestId: req.requestId ?? randomUUID(),
    });
    await this.expectOk(res, "post message");
    const body = (await res.json().catch(() => undefined)) as
      | { routing?: PostedMessageRouting }
      | undefined;
    return body?.routing;
  }
}
