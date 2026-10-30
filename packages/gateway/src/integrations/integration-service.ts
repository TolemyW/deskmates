// The integrations module (ADR-0013 and Amendment 1): what operators and runs may do with the
// integration runtime, with the workspace boundary applied before anything is forwarded.
//
// Operators adopt providers, give the runtime OAuth apps, and create or revoke a workspace's
// connections. Runs reach the runtime only through here: the run's workspace is resolved from its
// row, a connection is looked up in the Gateway's own table (item 3; the runtime has no tenant
// field), and the call is forwarded with that workspace's runtime token, whose grant list is
// rewritten whole on every connection change. Every run call is a `tool_call` / `tool_result` pair
// in the ledger with `source: "integration_proxy"` (item 7).

import {
  APP_NOT_ENABLED_FOR_BOT,
  type AdoptedIntegrationProvider,
  type BotIntegrationAppsScope,
  type CreateApiKeyConnectionRequest,
  DeskmatesError,
  type IntegrationActionOverride,
  type IntegrationActionSummary,
  type IntegrationActionTier,
  type IntegrationAppsResult,
  type IntegrationAuthKind,
  type IntegrationCatalog,
  type IntegrationCatalogEntry,
  type IntegrationConnection,
  type IntegrationConnectionPage,
  type IntegrationConnectionStatus,
  type IntegrationConnectionsResult,
  type IntegrationExecuteResult,
  type IntegrationGuideResult,
  type IntegrationOperation,
  type IntegrationSearchResult,
  type RunId,
  type SetIntegrationOverrideRequest,
  type StartOAuthConnectionRequest,
  type WorkspaceId,
  integrationServiceOf,
  isDeskmatesError,
  isIntegrationActionId,
  isIntegrationConnectionName,
  isIntegrationService,
  tierForAction,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import type { WorkspaceStore } from "../workspaces/workspaces.js";
import { appAllowed, frozenAppScope } from "./bot-app-scope.js";
import {
  type IntegrationStore,
  type PendingOAuthState,
  type StoredIntegrationConnection,
  publicConnection,
  runtimeConnectionName,
} from "./integration-store.js";
import {
  searchLimit,
  shapeApps,
  shapeConnections,
  shapeGuideMarkdown,
  shapeSearch,
} from "./result-shaping.js";
import {
  type RuntimeAdapter,
  type RuntimeProviderListing,
  type RuntimeTokenPolicy,
  RuntimeToolError,
} from "./runtime-adapter.js";

/**
 * The Gateway's own runtime token for the catalog (ADR-0013 amendment 3): the policy of the
 * runbook's bootstrap lock, so it can list apps and execute nothing. A grant list that is empty
 * would mean "every connection" to the runtime; the sentinel connection id keeps it inert.
 */
export const CATALOG_TOKEN_NAME = "deskmates-catalog";
export const CATALOG_TOKEN_POLICY: RuntimeTokenPolicy = {
  allowedActions: ["none.none"],
  allowedConnections: ["00000000-0000-0000-0000-000000000000"],
};

/** The runtime refused the bearer the Gateway sent: 401 or 403 from the adapter. */
function rejectedToken(err: unknown): boolean {
  if (!isDeskmatesError(err) || err.code !== "integration_unavailable") return false;
  const status = err.details.status;
  return status === 401 || status === 403;
}

/** How long an OAuth grant may take from start to callback; the runtime's own window is 10 minutes. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Largest search the Gateway asks the runtime for when it looks one action up. */
const CATALOG_LOOKUP_LIMIT = 50;

export interface IntegrationServiceDeps {
  store: IntegrationStore;
  /** Undefined when no runtime is configured: every call is then `integration_unavailable`. */
  adapter: RuntimeAdapter | undefined;
  /** `INTEGRATION_OAUTH_CALLBACK_URL`; OAuth is unavailable without it. */
  oauthCallbackUrl: string | undefined;
  secrets: SecretsStore;
  runs: RunStore;
  bots: BotStore;
  workspaces: WorkspaceStore;
  events: EventStore;
  clock?: () => Date;
}

export interface IntegrationStatus {
  configured: boolean;
  oauthAvailable: boolean;
  providers: AdoptedIntegrationProvider[];
}

export type OAuthCompletion =
  | { ok: true; connection: IntegrationConnection }
  | { ok: false; code: string; service: string };

interface RunScope {
  run: RunRecord;
  workspaceId: WorkspaceId;
  /** ADR-0055: the apps the run froze; undefined for a run from before it (every app). */
  apps: BotIntegrationAppsScope | undefined;
}

function authKindsOf(types: readonly string[]): IntegrationAuthKind[] {
  const kinds: IntegrationAuthKind[] = [];
  if (types.includes("oauth2")) kinds.push("oauth");
  if (types.includes("api_key")) kinds.push("api_key");
  return kinds;
}

function notAllowed(service: string, connectionName: string | undefined): DeskmatesError {
  // Never names another workspace or a runtime id: this message reaches a model.
  return new DeskmatesError(
    "integration_connection_not_allowed",
    connectionName === undefined
      ? `this workspace has no ${service} connection`
      : `${connectionName} is not a ${service} connection of this workspace`,
    { service, ...(connectionName === undefined ? {} : { connectionName }) },
  );
}

/** A refusal inside a runtime tool result, as a Gateway error. */
function fromToolError(err: unknown, service: string, connectionName?: string): unknown {
  if (!(err instanceof RuntimeToolError)) return err;
  if (err.code === "connection_not_allowed") return notAllowed(service, connectionName);
  if (err.code === "unknown_action")
    return new DeskmatesError("not_found", "no such action in the catalog", { service });
  return new DeskmatesError("integration_unavailable", "the integration runtime refused the call", {
    runtimeCode: err.code,
  });
}

export class IntegrationService {
  private readonly clock: () => Date;
  /** Catalog facts are pinned by the runtime's image digest, so one lookup per process suffices. */
  private readonly catalog = new Map<string, IntegrationActionSummary>();
  /** Grant rewrites per workspace, serialised so two changes cannot interleave their PUTs. */
  private readonly syncs = new Map<string, Promise<void>>();

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  get configured(): boolean {
    return this.deps.adapter !== undefined;
  }

  private runtime(): RuntimeAdapter {
    if (!this.deps.adapter)
      throw new DeskmatesError("integration_unavailable", "no integration runtime is configured");
    return this.deps.adapter;
  }

  status(): IntegrationStatus {
    return {
      configured: this.configured,
      oauthAvailable: this.configured && this.deps.oauthCallbackUrl !== undefined,
      providers: this.deps.store.listProviders(),
    };
  }

  /**
   * The runtime's whole provider list with the adopted ones marked, for the operator's catalog.
   * Without a runtime, or when its list cannot be read, the adopted providers alone are listed
   * and `complete` says so; the page still works, it just cannot offer the long tail.
   */
  async providerCatalog(): Promise<IntegrationCatalog> {
    const adopted = this.deps.store.listProviders();
    const adoptedOnly = (complete: boolean): IntegrationCatalog => ({
      configured: this.configured,
      complete,
      providers: adopted.map((p) => ({
        service: p.service,
        displayName: p.displayName,
        authKinds: p.authKinds,
        adopted: true,
      })),
    });
    if (!this.configured) return adoptedOnly(true);
    let listed: RuntimeProviderListing[];
    try {
      listed = await this.readProviderList();
    } catch {
      return adoptedOnly(false);
    }
    const byService = new Map(adopted.map((p) => [p.service, p]));
    const providers: IntegrationCatalogEntry[] = listed
      .filter((p) => isIntegrationService(p.service))
      .map((p) => {
        const own = byService.get(p.service);
        return {
          service: p.service,
          displayName: own?.displayName ?? p.displayName,
          authKinds: own?.authKinds ?? authKindsOf(p.authTypes),
          adopted: own !== undefined,
        };
      });
    const seen = new Set(providers.map((p) => p.service));
    for (const p of adopted) {
      if (!seen.has(p.service))
        providers.push({
          service: p.service,
          displayName: p.displayName,
          authKinds: p.authKinds,
          adopted: true,
        });
    }
    providers.sort(
      (a, b) => Number(b.adopted) - Number(a.adopted) || a.displayName.localeCompare(b.displayName),
    );
    return { configured: true, complete: true, providers };
  }

  /**
   * `list_apps` under the Gateway's catalog token; a token the runtime no longer knows (its data
   * was reset, an operator revoked it) is minted again once. The admin list is the fallback for a
   * runtime that has no runtime token yet, the only state in which v1.7.0 still answers it.
   */
  private async readProviderList(): Promise<RuntimeProviderListing[]> {
    const runtime = this.runtime();
    let failure: unknown;
    try {
      return await runtime.listApps(await this.catalogToken());
    } catch (err) {
      failure = err;
      if (rejectedToken(err)) {
        try {
          return await runtime.listApps(await this.catalogToken(true));
        } catch (again) {
          failure = again;
        }
      }
    }
    try {
      return await runtime.listProviders();
    } catch {
      throw failure;
    }
  }

  private catalogMint: Promise<string> | undefined;

  /** The stored catalog token, or a freshly minted one (`fresh`, or none stored yet). */
  private catalogToken(fresh = false): Promise<string> {
    const existing = this.deps.store.catalogToken();
    if (existing && !fresh) return Promise.resolve(this.deps.secrets.get(existing.secretId));
    if (this.catalogMint) return this.catalogMint;
    const mint = (async (): Promise<string> => {
      if (!this.deps.secrets.enabled)
        throw new DeskmatesError(
          "validation",
          "GATEWAY_SECRETS_KEY must be set before the Gateway can hold a catalog token",
        );
      const runtime = this.runtime();
      const created = await runtime.createToken(CATALOG_TOKEN_NAME, CATALOG_TOKEN_POLICY);
      const secretId = this.deps.secrets.put("gateway", "integration-catalog", created.token);
      this.deps.store.setCatalogToken(created.id, secretId);
      if (existing) {
        await runtime.revokeToken(existing.runtimeTokenId).catch(() => undefined);
        this.deps.secrets.delete(existing.secretId);
      }
      return created.token;
    })();
    this.catalogMint = mint;
    return mint.finally(() => {
      if (this.catalogMint === mint) this.catalogMint = undefined;
    });
  }

  /** Live connections of adopted providers; zero whenever no runtime is configured. */
  usableConnectionCount(workspaceId: WorkspaceId): number {
    if (!this.configured) return 0;
    return this.deps.store.usableConnections(workspaceId).length;
  }

  // --- operator: providers -----------------------------------------------------------------

  async adopt(service: unknown, displayName?: unknown): Promise<AdoptedIntegrationProvider> {
    if (!isIntegrationService(service))
      throw new DeskmatesError("validation", "service must be a runtime service id", { service });
    if (displayName !== undefined && typeof displayName !== "string")
      throw new DeskmatesError("validation", "displayName must be a string");
    const types = await this.runtime().providerAuthTypes(service);
    if (types === undefined)
      throw new DeskmatesError("not_found", `the runtime has no provider ${service}`, { service });
    const provider = this.deps.store.adopt(
      service,
      displayName?.trim() || service,
      authKindsOf(types),
    );
    await this.syncAll();
    return provider;
  }

  async unadopt(service: string): Promise<void> {
    if (!this.deps.store.unadopt(service))
      throw new DeskmatesError("not_found", `provider ${service} is not adopted`, { service });
    // Its connections stay recorded but lose their grants: they are no longer usable (item 8).
    await this.syncAll();
  }

  async setOAuthApp(
    service: string,
    body: Record<string, unknown>,
  ): Promise<{ redirectUri: string }> {
    const provider = this.mustBeAdopted(service);
    if (!provider.authKinds.includes("oauth"))
      throw new DeskmatesError("validation", `${service} has no OAuth flow`, { service });
    const redirectUri = this.callbackUrl();
    const { clientId, clientSecret, requestedScopes } = body;
    if (
      typeof clientId !== "string" ||
      clientId === "" ||
      typeof clientSecret !== "string" ||
      clientSecret === ""
    )
      throw new DeskmatesError("validation", "clientId and clientSecret are required");
    if (
      requestedScopes !== undefined &&
      !(Array.isArray(requestedScopes) && requestedScopes.every((s) => typeof s === "string"))
    )
      throw new DeskmatesError("validation", "requestedScopes must be a string array");
    // The client secret goes to the runtime's encrypted store only; nothing here keeps it.
    await this.runtime().putOAuthApp(service, {
      clientId,
      clientSecret,
      redirectUri,
      ...(requestedScopes === undefined ? {} : { requestedScopes: requestedScopes as string[] }),
    });
    return { redirectUri };
  }

  private mustBeAdopted(service: string): AdoptedIntegrationProvider {
    const provider = this.deps.store.provider(service);
    if (!provider)
      throw new DeskmatesError("integration_not_adopted", `${service} is not an adopted provider`, {
        service,
      });
    return provider;
  }

  private callbackUrl(): string {
    if (this.deps.oauthCallbackUrl === undefined)
      throw new DeskmatesError(
        "integration_unavailable",
        "INTEGRATION_OAUTH_CALLBACK_URL is not set, so no OAuth grant can complete",
      );
    return this.deps.oauthCallbackUrl;
  }

  // --- operator: connections ---------------------------------------------------------------

  listConnections(workspaceId: WorkspaceId): IntegrationConnection[] {
    this.deps.workspaces.mustGet(workspaceId);
    return this.deps.store.listConnections(workspaceId).map(publicConnection);
  }

  /** One page of a workspace's connections and its live counts per service (#113). */
  connectionPage(
    workspaceId: WorkspaceId,
    status: IntegrationConnectionStatus | undefined,
    offset: number,
    limit: number,
  ): IntegrationConnectionPage {
    this.deps.workspaces.mustGet(workspaceId);
    const page = this.deps.store.connectionPage(workspaceId, status, offset, limit);
    return {
      connections: page.connections.map(publicConnection),
      offset,
      limit,
      total: page.total,
      liveByService: this.deps.store.liveConnectionCounts(workspaceId),
    };
  }

  private checkNewConnection(
    workspaceId: WorkspaceId,
    service: unknown,
    name: unknown,
    kind: IntegrationAuthKind,
  ) {
    this.runtime();
    this.deps.workspaces.mustGet(workspaceId);
    if (!isIntegrationService(service))
      throw new DeskmatesError("validation", "service must be a runtime service id");
    const provider = this.mustBeAdopted(service);
    if (!provider.authKinds.includes(kind))
      throw new DeskmatesError("validation", `${service} does not take ${kind} connections`, {
        service,
      });
    if (!isIntegrationConnectionName(name))
      throw new DeskmatesError(
        "validation",
        "connectionName must be 1 to 32 of a-z, 0-9, _ and -, starting with a letter or digit",
      );
    if (this.deps.store.liveConnectionNamed(workspaceId, service, name))
      throw new DeskmatesError("validation", `${service} connection ${name} already exists`, {
        service,
        connectionName: name,
      });
    return { service, name, runtimeName: runtimeConnectionName(workspaceId, name) };
  }

  async createApiKeyConnection(
    workspaceId: WorkspaceId,
    req: Partial<CreateApiKeyConnectionRequest>,
    actor = "operator",
  ): Promise<IntegrationConnection> {
    const { service, name, runtimeName } = this.checkNewConnection(
      workspaceId,
      req.service,
      req.connectionName,
      "api_key",
    );
    if (typeof req.apiKey !== "string" || req.apiKey === "" || req.apiKey.length > 8192)
      throw new DeskmatesError("validation", "apiKey is required");
    const extra = req.values ?? {};
    if (
      typeof extra !== "object" ||
      Array.isArray(extra) ||
      !Object.values(extra).every((v) => typeof v === "string")
    )
      throw new DeskmatesError("validation", "values must map names to strings");
    // The key is passed through once and kept by the runtime only (item 4).
    const view = await this.runtime().putApiKeyConnection(service, runtimeName, {
      ...extra,
      apiKey: req.apiKey,
    });
    const connection = this.deps.store.insertConnection({
      workspaceId,
      service,
      connectionName: name,
      runtimeConnectionName: runtimeName,
      runtimeConnectionId: view.id,
      authKind: "api_key",
      actor,
    });
    await this.sync(workspaceId);
    return publicConnection(connection);
  }

  async startOAuth(
    workspaceId: WorkspaceId,
    req: Partial<StartOAuthConnectionRequest>,
    /** The browser session starting the grant; the callback must come back to it. */
    sessionId?: string,
  ): Promise<{ authorizationUrl: string }> {
    const callback = this.callbackUrl();
    const { service, name, runtimeName } = this.checkNewConnection(
      workspaceId,
      req.service,
      req.connectionName,
      "oauth",
    );
    const started = await this.runtime().startOAuth(service, runtimeName);
    // A grant that redirects anywhere else never reaches the callback that records it.
    let redirect: string | null = null;
    try {
      redirect = new URL(started.authorizationUrl).searchParams.get("redirect_uri");
    } catch {
      redirect = null;
    }
    if (redirect !== callback)
      throw new DeskmatesError(
        "validation",
        `the ${service} OAuth app does not redirect to this Gateway's callback; set it with PUT /api/integrations/providers/${service}/oauth-app`,
        { service },
      );
    this.deps.store.recordOAuthState(
      started.state,
      {
        workspaceId,
        service,
        connectionName: name,
        runtimeConnectionName: runtimeName,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
      OAUTH_STATE_TTL_SECONDS,
      this.clock(),
    );
    return { authorizationUrl: started.authorizationUrl };
  }

  /**
   * The provider redirected the operator's browser here. The `state` is the only credential: an
   * unknown, used or expired one is refused before anything is forwarded. Otherwise `code` and
   * `state` go to the runtime, which exchanges the code; the new connection is then recorded for
   * the workspace the state was issued for, with nothing but ids and names (item 4).
   */
  async completeOAuth(
    query: URLSearchParams,
    /**
     * Whether the browser presenting the callback may finish this grant (ADR-0022 INT-01). Asked
     * after the state is spent, so a refused callback cannot be retried with the same state.
     */
    authorize: (pending: PendingOAuthState) => boolean = () => true,
  ): Promise<OAuthCompletion> {
    const state = query.get("state");
    const pending = state ? this.deps.store.consumeOAuthState(state, this.clock()) : undefined;
    if (!pending)
      throw new DeskmatesError("token_rejected", "unknown, used or expired OAuth state");
    if (!authorize(pending))
      throw new DeskmatesError("token_rejected", "this OAuth grant belongs to another sign-in");
    const runtime = this.runtime();
    const done = await runtime.completeOAuth(query);
    if (!done.ok) return { ok: false, code: done.code ?? "error", service: pending.service };
    const view = (await runtime.listAllConnections()).find(
      (c) => c.service === pending.service && c.connectionName === pending.runtimeConnectionName,
    );
    if (!view)
      throw new DeskmatesError(
        "integration_protocol",
        "the runtime completed a grant it does not list",
        {
          service: pending.service,
        },
      );
    if (
      this.deps.store.liveConnectionNamed(
        pending.workspaceId,
        pending.service,
        pending.connectionName,
      )
    )
      throw new DeskmatesError("validation", "that connection name was taken while the grant ran", {
        service: pending.service,
        connectionName: pending.connectionName,
      });
    const connection = this.deps.store.insertConnection({
      workspaceId: pending.workspaceId,
      service: pending.service,
      connectionName: pending.connectionName,
      runtimeConnectionName: pending.runtimeConnectionName,
      runtimeConnectionId: view.id,
      authKind: "oauth",
      // The callback carries no session; the person who started the flow is not known here.
      actor: "oauth_callback",
    });
    await this.sync(pending.workspaceId);
    return { ok: true, connection: publicConnection(connection) };
  }

  /**
   * Revoke: the grant goes first, so no run can use the connection once this returns, then the
   * credential leaves the runtime. Repeating it retries the credential removal.
   */
  async revokeConnection(
    workspaceId: WorkspaceId,
    connectionId: string,
    actor = "operator",
  ): Promise<IntegrationConnection> {
    const runtime = this.runtime();
    const existing = this.deps.store.connection(connectionId);
    if (!existing || existing.workspaceId !== workspaceId)
      throw new DeskmatesError("not_found", `integration connection ${connectionId} not found`, {
        connectionId,
      });
    const revoked = this.deps.store.revokeConnection(connectionId, actor);
    await this.sync(workspaceId);
    // Runtime names are deterministic per (workspace, name) and a revoked name may be reused; a
    // repeated revoke of the old row must not remove the live connection's credential.
    const reused = this.deps.store.liveConnectionNamed(
      workspaceId,
      revoked.service,
      revoked.connectionName,
    );
    if (reused?.runtimeConnectionName !== revoked.runtimeConnectionName)
      await runtime.deleteConnection(revoked.service, revoked.runtimeConnectionName);
    return publicConnection(revoked);
  }

  /**
   * ADR-0026 permanent deletion: revoke the workspace grant first, then remove every credential
   * the external runtime still holds. Gateway rows are deleted later by the lifecycle transaction;
   * a runtime failure therefore leaves the Trash item recoverable and makes the delete retryable.
   */
  async permanentlyDeleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.syncs.get(workspaceId)?.catch(() => undefined);
    const token = this.deps.store.workspaceToken(workspaceId);
    const connections = this.deps.store.listConnections(workspaceId);
    if (!token && connections.length === 0) return;
    const runtime = this.runtime();
    if (token) await runtime.revokeToken(token.runtimeTokenId);
    for (const connection of connections) {
      await runtime.deleteConnection(connection.service, connection.runtimeConnectionName);
    }
  }

  // --- operator: tier overrides ------------------------------------------------------------

  listOverrides(): IntegrationActionOverride[] {
    return this.deps.store.listOverrides();
  }

  async setOverride(
    actionId: string,
    req: SetIntegrationOverrideRequest,
  ): Promise<IntegrationActionOverride> {
    if (!isIntegrationActionId(actionId))
      throw new DeskmatesError("validation", "actionId must be <service>.<name>");
    for (const key of ["lowerableToL1", "neverLowerable"] as const) {
      if (req[key] !== undefined && typeof req[key] !== "boolean")
        throw new DeskmatesError("validation", `${key} must be a boolean`);
    }
    const current = this.deps.store.override(actionId);
    const next = {
      lowerableToL1: req.lowerableToL1 ?? current.lowerableToL1,
      neverLowerable: req.neverLowerable ?? current.neverLowerable,
    };
    if (next.lowerableToL1 && next.neverLowerable)
      throw new DeskmatesError("validation", `${actionId} is marked never lowerable`, { actionId });
    if (next.lowerableToL1) {
      // Only a catalog `write` may be lowered; the check needs the catalog, so a lowering is refused
      // while the runtime cannot say what the action is (item 6: destructive cannot be lowered).
      const action = await this.catalogActionForOperator(actionId);
      if (action.operationType !== "write")
        throw new DeskmatesError(
          "validation",
          `${actionId} is ${action.operationType}; only a write may be lowered to L1`,
          {
            actionId,
            operationType: action.operationType,
          },
        );
    }
    return this.deps.store.setOverride(actionId, next);
  }

  /** Catalog facts for an operator decision, through any workspace token that exists. */
  private async catalogActionForOperator(actionId: string): Promise<IntegrationActionSummary> {
    const cached = this.catalog.get(actionId);
    if (cached) return cached;
    const workspaceId = this.deps.store.workspacesWithTokens()[0];
    if (workspaceId === undefined)
      throw new DeskmatesError(
        "integration_unavailable",
        "the catalog cannot be read before any workspace has a connection",
      );
    return this.catalogAction(await this.tokenFor(workspaceId), actionId);
  }

  // --- the per-workspace runtime token ----------------------------------------------------

  private tokenName(workspaceId: WorkspaceId): string {
    return `deskmates-workspace-${workspaceId}`;
  }

  /** Serialise and run one rewrite of the workspace's grant. */
  sync(workspaceId: WorkspaceId): Promise<void> {
    const previous = this.syncs.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncNow(workspaceId));
    this.syncs.set(workspaceId, next);
    return next.finally(() => {
      if (this.syncs.get(workspaceId) === next) this.syncs.delete(workspaceId);
    });
  }

  private async syncAll(): Promise<void> {
    const ids = new Set([
      ...this.deps.store.workspacesWithTokens(),
      ...this.deps.store.workspacesWithConnections(),
    ]);
    for (const id of ids) await this.sync(id);
  }

  /**
   * The grant is sent whole: exactly the workspace's usable connections and their providers'
   * actions. An empty grant list means "every connection" to the runtime, so a workspace left
   * with none has its token revoked instead (spike §4).
   */
  private async syncNow(workspaceId: WorkspaceId): Promise<void> {
    const runtime = this.runtime();
    const usable = this.deps.store.usableConnections(workspaceId);
    const existing = this.deps.store.workspaceToken(workspaceId);
    if (usable.length === 0) {
      if (existing) {
        await runtime.revokeToken(existing.runtimeTokenId);
        this.deps.store.deleteWorkspaceToken(workspaceId);
        this.deps.secrets.delete(existing.secretId);
      }
      return;
    }
    const policy = {
      allowedConnections: usable.map((c) => c.runtimeConnectionId),
      allowedActions: [...new Set(usable.map((c) => `${c.service}.*`))],
    };
    if (existing) {
      await runtime.updateToken(existing.runtimeTokenId, this.tokenName(workspaceId), policy);
      this.deps.store.touchWorkspaceToken(workspaceId);
      return;
    }
    const created = await runtime.createToken(this.tokenName(workspaceId), policy);
    const secretId = this.deps.secrets.put("workspace", workspaceId, created.token);
    this.deps.store.setWorkspaceToken(workspaceId, created.id, secretId);
  }

  private async tokenFor(workspaceId: WorkspaceId): Promise<string> {
    let ref = this.deps.store.workspaceToken(workspaceId);
    if (!ref) {
      await this.sync(workspaceId);
      ref = this.deps.store.workspaceToken(workspaceId);
    }
    if (!ref)
      throw new DeskmatesError(
        "integration_connection_not_allowed",
        "this workspace has no integration connection",
      );
    return this.deps.secrets.get(ref.secretId);
  }

  // --- run routes --------------------------------------------------------------------------

  private scope(runId: RunId): RunScope {
    this.runtime();
    const run = this.deps.runs.mustGet(runId);
    return {
      run,
      workspaceId: this.deps.bots.mustGet(run.botId).workspaceId,
      apps: frozenAppScope(run.config),
    };
  }

  /** The workspace's usable connections of the apps this run may use (ADR-0055 decision 4). */
  private usableFor(s: RunScope): StoredIntegrationConnection[] {
    return this.deps.store
      .usableConnections(s.workspaceId)
      .filter((c) => appAllowed(s.apps, c.service));
  }

  /** Decision 4: a service the run may not use is refused before the runtime is asked. */
  private mustBeAllowed(s: RunScope, service: string): void {
    if (appAllowed(s.apps, service)) return;
    throw new DeskmatesError(
      "forbidden",
      `${service} is not enabled for this bot; an Owner or Admin can turn it on in the bot's settings, or ask a teammate that may use it`,
      { reason: APP_NOT_ENABLED_FOR_BOT, service },
    );
  }

  /** How many usable connections a run limited to `apps` would see; the tools need one. */
  usableConnectionCountFor(workspaceId: WorkspaceId, apps: BotIntegrationAppsScope): number {
    return this.deps.store.usableConnections(workspaceId).filter((c) => appAllowed(apps, c.service))
      .length;
  }

  /**
   * The connection a run names, in its own workspace. Absent, the workspace's only connection of
   * the service is used; the default connection of the runtime never is (Amendment 1).
   */
  private resolveConnection(
    workspaceId: WorkspaceId,
    service: string,
    connectionName: unknown,
  ): StoredIntegrationConnection {
    const usable = this.deps.store
      .usableConnections(workspaceId)
      .filter((c) => c.service === service);
    if (connectionName === undefined || connectionName === null || connectionName === "") {
      const [only, ...more] = usable;
      if (only === undefined) throw notAllowed(service, undefined);
      if (more.length > 0)
        throw new DeskmatesError(
          "validation",
          `name one of this workspace's ${service} connections: ${usable.map((c) => c.connectionName).join(", ")}`,
          { service },
        );
      return only;
    }
    if (typeof connectionName !== "string")
      throw new DeskmatesError("validation", "connectionName must be a string");
    const own = usable.find((c) => c.connectionName === connectionName);
    if (!own) throw notAllowed(service, connectionName);
    return own;
  }

  private serviceOfAction(actionId: unknown): { actionId: string; service: string } {
    if (!isIntegrationActionId(actionId))
      throw new DeskmatesError("validation", "actionId must be <service>.<name>", { actionId });
    const service = integrationServiceOf(actionId) as string;
    this.mustBeAdopted(service);
    return { actionId, service };
  }

  private async catalogAction(token: string, actionId: string): Promise<IntegrationActionSummary> {
    const cached = this.catalog.get(actionId);
    if (cached) return cached;
    const service = integrationServiceOf(actionId) as string;
    let entries: Awaited<ReturnType<RuntimeAdapter["searchActions"]>>;
    try {
      entries = await this.runtime().searchActions(token, {
        service,
        query: actionId,
        limit: CATALOG_LOOKUP_LIMIT,
      });
    } catch (err) {
      throw fromToolError(err, service);
    }
    const found = entries.find((e) => e.actionId === actionId && e.service === service);
    if (!found)
      throw new DeskmatesError("not_found", `no action ${actionId} in the catalog`, { actionId });
    const summary: IntegrationActionSummary = {
      actionId: found.actionId,
      service: found.service,
      name: found.name,
      description: found.description,
      operationType: found.operationType,
      requiredScopes: found.requiredScopes,
    };
    this.catalog.set(actionId, summary);
    return summary;
  }

  /** Wraps one run call in its `tool_call` / `tool_result` ledger pair (item 7). */
  private async attributed<T>(
    s: RunScope,
    op: IntegrationOperation,
    ids: Record<string, unknown>,
    fn: () => Promise<T>,
    resultIds: (result: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    const base = this.recordCall(s, op, ids);
    try {
      const result = await fn();
      const extra = resultIds(result);
      this.deps.events.append({
        runId: s.run.id,
        kind: "tool_result",
        payload: { ...base, ...extra, isError: extra.isError === true, result },
      });
      return result;
    } catch (err) {
      this.recordFailure(s, base, err);
      throw err;
    }
  }

  private recordCall(
    s: RunScope,
    op: IntegrationOperation,
    ids: Record<string, unknown>,
  ): Record<string, unknown> {
    const base = {
      source: "integration_proxy",
      toolName: `mcp__deskmates__integration_${op}`,
      operation: op,
      botId: s.run.botId,
      ...ids,
    };
    this.deps.events.append({ runId: s.run.id, kind: "tool_call", payload: base });
    return base;
  }

  private recordFailure(s: RunScope, base: Record<string, unknown>, err: unknown): void {
    this.deps.events.append({
      runId: s.run.id,
      kind: "tool_result",
      payload: {
        ...base,
        isError: true,
        error: isDeskmatesError(err)
          ? { code: err.code, message: err.message, details: err.details }
          : { code: "internal", message: "integration call failed" },
      },
    });
  }

  /**
   * `resolveConnection` for a tool call: a refusal is still a call, so it is attributed as a
   * `tool_call` / `tool_result` pair before it is thrown (item 7).
   */
  private runConnection(
    s: RunScope,
    op: IntegrationOperation,
    actionId: string,
    service: string,
    requested: unknown,
  ): StoredIntegrationConnection {
    try {
      this.mustBeAllowed(s, service);
      return this.resolveConnection(s.workspaceId, service, requested);
    } catch (err) {
      const ids = {
        service,
        actionId,
        ...(typeof requested === "string" ? { connectionName: requested } : {}),
      };
      this.recordFailure(s, this.recordCall(s, op, ids), err);
      throw err;
    }
  }

  apps(runId: RunId): Promise<IntegrationAppsResult> {
    const s = this.scope(runId);
    return this.attributed(s, "apps", {}, async () =>
      shapeApps(
        this.deps.store.listProviders().filter((p) => appAllowed(s.apps, p.service)),
        this.usableFor(s),
      ),
    );
  }

  connections(runId: RunId, service?: string): Promise<IntegrationConnectionsResult> {
    const s = this.scope(runId);
    if (service !== undefined && !isIntegrationService(service))
      throw new DeskmatesError("validation", "service must be a runtime service id");
    return this.attributed(s, "connections", service ? { service } : {}, async () => {
      if (service !== undefined) this.mustBeAllowed(s, service);
      const own = this.usableFor(s);
      if (own.length === 0) return { connections: [] };
      const token = await this.tokenFor(s.workspaceId);
      let listed: Awaited<ReturnType<RuntimeAdapter["listConnections"]>>;
      try {
        listed = await this.runtime().listConnections(token, service);
      } catch (err) {
        throw fromToolError(err, service ?? "any");
      }
      return shapeConnections(listed, own);
    });
  }

  search(runId: RunId, body: Record<string, unknown>): Promise<IntegrationSearchResult> {
    const s = this.scope(runId);
    const service = body.service;
    // Amendment 1: a search always names a service; the runtime ranks across providers badly.
    if (!isIntegrationService(service))
      throw new DeskmatesError("validation", "service is required", { field: "service" });
    this.mustBeAdopted(service);
    this.mustBeAllowed(s, service);
    if (body.query !== undefined && typeof body.query !== "string")
      throw new DeskmatesError("validation", "query must be a string");
    const limit = searchLimit(body.limit);
    const query = typeof body.query === "string" ? body.query.slice(0, 200) : undefined;
    return this.attributed(s, "search", { service }, async () => {
      const token = await this.tokenFor(s.workspaceId);
      let entries: Awaited<ReturnType<RuntimeAdapter["searchActions"]>>;
      try {
        entries = await this.runtime().searchActions(token, {
          service,
          limit,
          ...(query ? { query } : {}),
        });
      } catch (err) {
        throw fromToolError(err, service);
      }
      const adopted = new Set(this.deps.store.listProviders().map((p) => p.service));
      return shapeSearch(service, entries, adopted, limit);
    });
  }

  async guide(runId: RunId, body: Record<string, unknown>): Promise<IntegrationGuideResult> {
    const s = this.scope(runId);
    const { actionId, service } = this.serviceOfAction(body.actionId);
    const connection = this.runConnection(s, "guide", actionId, service, body.connectionName);
    return this.attributed(
      s,
      "guide",
      { service, actionId, connectionName: connection.connectionName },
      async () => {
        const token = await this.tokenFor(s.workspaceId);
        try {
          const g = await this.runtime().actionGuide(
            token,
            actionId,
            connection.runtimeConnectionName,
          );
          return {
            actionId,
            service,
            connectionName: connection.connectionName,
            operationType: g.operationType,
            requiredScopes: g.requiredScopes,
            guide: shapeGuideMarkdown(g.markdown, connection),
          };
        } catch (err) {
          throw fromToolError(err, service, connection.connectionName);
        }
      },
      (r) => ({ operationType: r.operationType }),
    );
  }

  /** What the PreToolUse hook tiers `integration_execute` by (item 6). Not a tool call. */
  async tier(
    runId: RunId,
    actionIdRaw: string,
    connectionName: unknown,
  ): Promise<IntegrationActionTier> {
    const s = this.scope(runId);
    const { actionId, service } = this.serviceOfAction(actionIdRaw);
    this.mustBeAllowed(s, service);
    const connection = this.resolveConnection(s.workspaceId, service, connectionName);
    const action = await this.catalogAction(await this.tokenFor(s.workspaceId), actionId);
    const override = this.deps.store.override(actionId);
    return {
      ...action,
      connectionName: connection.connectionName,
      override,
      tier: tierForAction(action.operationType, override),
    };
  }

  async execute(runId: RunId, body: Record<string, unknown>): Promise<IntegrationExecuteResult> {
    const s = this.scope(runId);
    const { actionId, service } = this.serviceOfAction(body.actionId);
    const input = body.input ?? {};
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new DeskmatesError("validation", "input must be an object", { field: "input" });
    // The workspace check happens here, before the runtime is asked anything (item 3).
    const connection = this.runConnection(s, "execute", actionId, service, body.connectionName);
    const token = await this.tokenFor(s.workspaceId);
    const action = await this.catalogAction(token, actionId);
    return this.attributed(
      s,
      "execute",
      {
        service,
        actionId,
        connectionName: connection.connectionName,
        operationType: action.operationType,
      },
      async () => {
        const out = await this.runtime().executeAction(
          token,
          actionId,
          connection.runtimeConnectionName,
          input as Record<string, unknown>,
        );
        if (!out.ok && out.error?.code === "connection_not_allowed")
          throw notAllowed(service, connection.connectionName);
        return {
          ok: out.ok,
          actionId,
          service,
          connectionName: connection.connectionName,
          operationType: action.operationType,
          ...(out.executionId === undefined ? {} : { executionId: out.executionId }),
          ...(out.ok ? { data: out.data } : {}),
          ...(out.error ? { error: out.error } : {}),
        };
      },
      (r) => ({
        ...(r.executionId === undefined ? {} : { executionId: r.executionId }),
        isError: !r.ok,
      }),
    );
  }
}
