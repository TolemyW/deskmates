// Integrations (ADR-0013), receipted connectors (ADR-0012) and chat channels (ADR-0017). No
// response carries a credential.

import type {
  AdoptedIntegrationProvider,
  BotId,
  ChannelCommand,
  ChannelConnection,
  ChannelPluginManifest,
  ConnectorPage,
  ConnectorRegistration,
  CreateApiKeyConnectionRequest,
  IntegrationCatalog,
  IntegrationConnection,
  IntegrationConnectionPage,
  IntegrationConnectionStatus,
  RegisterConnectorRequest,
  StartOAuthConnectionRequest,
  StartOAuthConnectionResponse,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

/** `GET /api/integrations`: whether a runtime is configured, OAuth is usable, and adopted providers. */
export interface IntegrationsStatus {
  configured: boolean;
  oauthAvailable: boolean;
  providers: AdoptedIntegrationProvider[];
}

export interface IntegrationsApi {
  adoptIntegrationProvider(
    service: string,
    displayName?: string,
  ): Promise<AdoptedIntegrationProvider>;
  commandChannel(
    workspaceId: WorkspaceId,
    pluginId: string,
    command: ChannelCommand,
    input?: Record<string, string>,
  ): Promise<ChannelConnection | undefined>;
  connectChannel(
    workspaceId: WorkspaceId,
    pluginId: string,
    input: { method: string; botId: BotId; config: Record<string, string> },
  ): Promise<ChannelConnection>;
  createApiKeyConnection(
    workspaceId: WorkspaceId,
    input: CreateApiKeyConnectionRequest,
  ): Promise<IntegrationConnection>;
  getChannelCatalog(): Promise<{
    plugins: {
      manifest: ChannelPluginManifest;
      state: "available" | "degraded";
      message?: string;
    }[];
    failures: { id: string; message: string }[];
  }>;
  /** The runtime's provider catalog with the adopted ones marked (ADR-0013). */
  getIntegrationCatalog(): Promise<IntegrationCatalog>;
  getIntegrations(): Promise<IntegrationsStatus>;
  listChannelConnections(workspaceId: WorkspaceId): Promise<ChannelConnection[]>;
  /**
   * One page of a workspace's receipted connectors (ADR-0012), oldest first, with the total
   * (#113). Without a position the Gateway answers its first page.
   */
  listConnectors(
    workspaceId: WorkspaceId,
    page?: { offset?: number; limit?: number },
  ): Promise<ConnectorPage>;
  /** One page of a workspace's connections and its live counts per service (#113). */
  listIntegrationConnections(
    workspaceId: WorkspaceId,
    filters?: { status?: IntegrationConnectionStatus; offset?: number; limit?: number },
  ): Promise<IntegrationConnectionPage>;
  registerConnector(input: RegisterConnectorRequest): Promise<ConnectorRegistration>;
  revokeIntegrationConnection(
    workspaceId: WorkspaceId,
    connectionId: string,
  ): Promise<IntegrationConnection>;
  startOAuthConnection(
    workspaceId: WorkspaceId,
    input: StartOAuthConnectionRequest,
  ): Promise<StartOAuthConnectionResponse>;
  unadoptIntegrationProvider(service: string): Promise<void>;
}

export function createIntegrationsApi(t: HttpTransport): IntegrationsApi {
  const connections = (workspaceId: WorkspaceId) =>
    `/api/integrations/workspaces/${encodeURIComponent(workspaceId)}/connections`;
  const channels = (workspaceId: WorkspaceId) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/channels`;
  return {
    async adoptIntegrationProvider(service, displayName) {
      const r = await t.json<{ provider: AdoptedIntegrationProvider }>(
        "POST",
        "/api/integrations/providers",
        stripUndefined({ service, displayName }),
      );
      return r.provider;
    },
    async commandChannel(workspaceId, pluginId, command, input) {
      const r = await t.json<{ connection: ChannelConnection | null }>(
        "POST",
        `${channels(workspaceId)}/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(command)}`,
        input ?? {},
      );
      return r.connection ?? undefined;
    },
    async connectChannel(workspaceId, pluginId, input) {
      const r = await t.json<{ connection: ChannelConnection }>(
        "POST",
        `${channels(workspaceId)}/${encodeURIComponent(pluginId)}/connect`,
        input,
      );
      return r.connection;
    },
    async createApiKeyConnection(workspaceId, input) {
      const r = await t.json<{ connection: IntegrationConnection }>(
        "POST",
        `${connections(workspaceId)}/api-key`,
        stripUndefined(input),
      );
      return r.connection;
    },
    getChannelCatalog() {
      return t.json("GET", "/api/channels");
    },
    getIntegrationCatalog() {
      return t.json("GET", "/api/integrations/catalog");
    },
    getIntegrations() {
      return t.json("GET", "/api/integrations");
    },
    async listChannelConnections(workspaceId) {
      const r = await t.json<{ connections: ChannelConnection[] }>("GET", channels(workspaceId));
      return r.connections;
    },
    listConnectors(workspaceId, page = {}) {
      return t.json("GET", `/api/connectors${query({ workspaceId, ...page })}`);
    },
    listIntegrationConnections(workspaceId, filters = {}) {
      return t.json("GET", `${connections(workspaceId)}${query({ ...filters })}`);
    },
    async registerConnector(input) {
      const r = await t.json<{ connector: ConnectorRegistration }>(
        "POST",
        "/api/connectors",
        stripUndefined(input),
      );
      return r.connector;
    },
    async revokeIntegrationConnection(workspaceId, connectionId) {
      const r = await t.json<{ connection: IntegrationConnection }>(
        "DELETE",
        `${connections(workspaceId)}/${encodeURIComponent(connectionId)}`,
      );
      return r.connection;
    },
    startOAuthConnection(workspaceId, input) {
      return t.json("POST", `${connections(workspaceId)}/oauth/start`, input);
    },
    async unadoptIntegrationProvider(service) {
      await t.json("DELETE", `/api/integrations/providers/${encodeURIComponent(service)}`);
    },
  };
}
