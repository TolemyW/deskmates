// Integrations (ADR-0013), receipted connectors (ADR-0012) and chat channels (ADR-0017, with
// ADR-0047's connection-addressed routes). No response carries a credential.

import type {
  AdoptedIntegrationProvider,
  BotId,
  ChannelCommand,
  ChannelConnection,
  ChannelMenuRequest,
  ChannelMenuResult,
  ChannelPluginManifest,
  ChannelPluginManifestV2,
  ChannelSenderBlock,
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
  channelCommandMenu(
    workspaceId: WorkspaceId,
    connectionId: string,
    input: ChannelMenuRequest,
  ): Promise<ChannelMenuResult>;
  adoptIntegrationProvider(
    service: string,
    displayName?: string,
  ): Promise<AdoptedIntegrationProvider>;
  /** ADR-0047 decision 13: add a person to an ABI-2 connection's blocklist. */
  blockChannelSender(
    workspaceId: WorkspaceId,
    connectionId: string,
    input: { senderId: string; note?: string },
  ): Promise<ChannelSenderBlock>;
  commandChannel(
    workspaceId: WorkspaceId,
    pluginId: string,
    command: ChannelCommand,
    input?: Record<string, string>,
  ): Promise<ChannelConnection | undefined>;
  /** A lifecycle command for one connection by id; `relink` carries `{ config }` on ABI 2. */
  commandChannelConnection(
    workspaceId: WorkspaceId,
    connectionId: string,
    command: ChannelCommand,
    input?: Record<string, unknown>,
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
      manifest: ChannelPluginManifest | ChannelPluginManifestV2;
      state: "available" | "degraded";
      message?: string;
    }[];
    failures: { id: string; message: string }[];
  }>;
  /** The runtime's provider catalog with the adopted ones marked (ADR-0013). */
  getIntegrationCatalog(): Promise<IntegrationCatalog>;
  getIntegrations(): Promise<IntegrationsStatus>;
  listChannelConnections(workspaceId: WorkspaceId): Promise<ChannelConnection[]>;
  listChannelSenderBlocks(
    workspaceId: WorkspaceId,
    connectionId: string,
  ): Promise<ChannelSenderBlock[]>;
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
  /** ADR-0047 decision 8: bind an ABI-2 connection to another Bot of its workspace. */
  rebindChannelConnection(
    workspaceId: WorkspaceId,
    connectionId: string,
    botId: BotId,
  ): Promise<ChannelConnection>;
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
  unblockChannelSender(
    workspaceId: WorkspaceId,
    connectionId: string,
    senderId: string,
  ): Promise<boolean>;
}

export function createIntegrationsApi(t: HttpTransport): IntegrationsApi {
  const connections = (workspaceId: WorkspaceId) =>
    `/api/integrations/workspaces/${encodeURIComponent(workspaceId)}/connections`;
  const channels = (workspaceId: WorkspaceId) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/channels`;
  const connection = (workspaceId: WorkspaceId, connectionId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/channel-connections/${encodeURIComponent(connectionId)}`;
  return {
    async channelCommandMenu(workspaceId, connectionId, input) {
      return t.json("POST", `${connection(workspaceId, connectionId)}/command-menu`, input);
    },
    async adoptIntegrationProvider(service, displayName) {
      const r = await t.json<{ provider: AdoptedIntegrationProvider }>(
        "POST",
        "/api/integrations/providers",
        stripUndefined({ service, displayName }),
      );
      return r.provider;
    },
    async blockChannelSender(workspaceId, connectionId, input) {
      const r = await t.json<{ block: ChannelSenderBlock }>(
        "POST",
        `${connection(workspaceId, connectionId)}/blocks`,
        stripUndefined(input),
      );
      return r.block;
    },
    async commandChannelConnection(workspaceId, connectionId, command, input) {
      const r = await t.json<{ connection: ChannelConnection | null }>(
        "POST",
        `${connection(workspaceId, connectionId)}/commands/${encodeURIComponent(command)}`,
        input ?? {},
      );
      return r.connection ?? undefined;
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
    async listChannelSenderBlocks(workspaceId, connectionId) {
      const r = await t.json<{ blocks: ChannelSenderBlock[] }>(
        "GET",
        `${connection(workspaceId, connectionId)}/blocks`,
      );
      return r.blocks;
    },
    async rebindChannelConnection(workspaceId, connectionId, botId) {
      const r = await t.json<{ connection: ChannelConnection }>(
        "POST",
        `${connection(workspaceId, connectionId)}/rebind`,
        { botId },
      );
      return r.connection;
    },
    async unblockChannelSender(workspaceId, connectionId, senderId) {
      const r = await t.json<{ removed: boolean }>(
        "DELETE",
        `${connection(workspaceId, connectionId)}/blocks/${encodeURIComponent(senderId)}`,
      );
      return r.removed;
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
