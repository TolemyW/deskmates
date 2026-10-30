import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BotId,
  CHANNEL_IDENTITY_LABEL_MAX,
  CHANNEL_PHASE_ARCHIVED,
  CHANNEL_PLUGIN_API_VERSION_2,
  type ChannelCloseReason,
  type ChannelCommand,
  type ChannelConnectRequest,
  type ChannelConnection,
  type ChannelConnectionMethod,
  type ChannelConnectionStatus,
  type ChannelIdentity,
  type ChannelMenuResult,
  type ChannelOpenReason,
  type ChannelOpenRequest,
  type ChannelPlugin,
  type ChannelPluginManifest,
  type ChannelPluginManifestV2,
  type ChannelPluginRuntime,
  type ChannelPluginRuntimeV2,
  type ChannelPluginV2,
  type ChannelSenderBlock,
  DeskmatesError,
  type RunId,
  type ThreadId,
  type WorkspaceId,
  channelManifestV2Problems,
  channelSenderAdmission,
  isChannelIdentityKey,
  isDeskmatesError,
  isTerminal,
  parseChannelMenuRequest,
} from "@deskmates/contracts";
import type { ApprovalStore } from "../approvals/approvals.js";
import type { ApprovalBroker } from "../approvals/broker.js";
import { scrubText } from "../approvals/secret-shaped.js";
import type { BotStore } from "../bots/bots.js";
import type { GatewayDb } from "../db/open.js";
import type { EventBus } from "../events/bus.js";
import type { ChannelImageStore } from "../files/channel-image-upload.js";
import type { RunStore } from "../ledger/runs.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import type { Ownership } from "../tenancy/ownership.js";
import type { TenantQuotas } from "../tenancy/quotas.js";
import type { MessageStore } from "../threads/messages.js";
import type { ThreadRouter } from "../threads/router.js";
import type { ThreadStore } from "../threads/threads.js";
import type { WorkspaceStore } from "../workspaces/workspaces.js";
import {
  ChannelStore,
  type StoredChannelConnection,
  publicChannelConnection,
} from "./channel-store.js";
import { ConnectionHosts } from "./connection-host.js";
import { OutboundReceipts } from "./outbound-receipts.js";
import { createPluginHostV1 } from "./plugin-host-v1.js";
import type { AnyChannelPlugin, ChannelPluginLoadFailure } from "./plugin-loader.js";
import { SenderBlocks, parseSenderId } from "./sender-blocks.js";

interface ManagerDeps {
  db: GatewayDb;
  secrets: SecretsStore;
  workspaces: WorkspaceStore;
  bots: BotStore;
  threads: ThreadStore;
  messages: MessageStore;
  router: ThreadRouter;
  approvals: ApprovalStore;
  broker: ApprovalBroker;
  runs: RunStore;
  ownership: Ownership;
  quotas: TenantQuotas;
  bus: EventBus;
  stateRoot: string;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

/** Services that exist only once the Gateway's scheduler and context do (`index.ts`). */
export interface ChannelManagerAttachments {
  kick(): void;
  cancelRun(runId: RunId, cancelledBy: string): void;
  storeImage?: ChannelImageStore;
}

export interface ChannelCatalogEntry {
  manifest: ChannelPluginManifest | ChannelPluginManifestV2;
  state: "available" | "degraded";
  message?: string;
}

/** What a rebind or disconnect fence closed (ADR-0047 decision 8), for the audit record. */
export interface ChannelFenceSummary {
  runsCancelled: number;
  outboundCancelled: number;
}

type Entry =
  | { abi: 1; plugin: ChannelPlugin; runtime: ChannelPluginRuntime }
  | {
      abi: 2;
      plugin: ChannelPluginV2;
      runtime?: Promise<ChannelPluginRuntimeV2>;
      failure?: string;
    };

const FENCE_ACTOR = "system:channel_binding";
/** What the Integrations card shows for a connection of a workspace in Trash (ADR-0026). */
const ARCHIVED_STATUS: ChannelConnectionStatus = {
  phase: CHANNEL_PHASE_ARCHIVED,
  message: "Stopped while the workspace is in Trash. Restoring the workspace resumes it.",
};
const LEGACY_COMMANDS = new Set<ChannelCommand>(["reconnect", "relink", "test", "disconnect"]);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeskmatesError("validation", "channel configuration must be an object");
  }
  return value as Record<string, unknown>;
}

/** Split an operator's input into plain config and secrets by the method's declared fields. */
function parseFields(
  method: ChannelConnectionMethod,
  input: unknown,
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const supplied = asObject(input ?? {});
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const allowed = new Set(method.fields.map((field) => field.key));
  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) throw new DeskmatesError("validation", `unknown channel field ${key}`);
  }
  for (const field of method.fields) {
    const value = supplied[field.key];
    if (field.required && (typeof value !== "string" || value.trim() === "")) {
      throw new DeskmatesError("validation", `${field.label} is required`);
    }
    if (value === undefined || value === "") continue;
    if (typeof value !== "string")
      throw new DeskmatesError("validation", `${field.label} must be text`);
    if (field.secret) secrets[field.key] = value;
    else config[field.key] = value;
  }
  return { config, secrets };
}

export class ChannelManager {
  private readonly entries = new Map<string, Entry>();
  private failures: ChannelPluginLoadFailure[] = [];
  private attached: ChannelManagerAttachments = { kick: () => {}, cancelRun: () => {} };
  private readonly store: ChannelStore;
  private readonly blocks: SenderBlocks;
  private readonly receipts: OutboundReceipts;
  private readonly hosts: ConnectionHosts;

  constructor(private readonly deps: ManagerDeps) {
    this.store = new ChannelStore(deps.db);
    this.blocks = new SenderBlocks(deps.db);
    this.receipts = new OutboundReceipts(deps.db);
    this.hosts = new ConnectionHosts({
      ...deps,
      store: this.store,
      blocks: this.blocks,
      receipts: this.receipts,
      kick: () => this.attached.kick(),
      storeImage: () => this.attached.storeImage,
    });
  }

  attach(attachments: ChannelManagerAttachments): void {
    this.attached = attachments;
  }

  /** Kept for callers that only schedule; `attach` supersedes it. */
  setKick(kick: () => void): void {
    this.attached = { ...this.attached, kick };
  }

  async initialize(
    loaded: Map<string, AnyChannelPlugin>,
    failures: readonly ChannelPluginLoadFailure[] = [],
  ): Promise<void> {
    this.failures = [...failures];
    for (const [id, plugin] of loaded) {
      if (plugin.manifest.apiVersion === CHANNEL_PLUGIN_API_VERSION_2) {
        const problems = channelManifestV2Problems(plugin.manifest);
        if (problems.length > 0) {
          this.failures.push({ id, message: `invalid ABI-2 manifest: ${problems.join("; ")}` });
          continue;
        }
        // ADR-0047 decision 15: the runtime and its provider dependencies load on first use.
        this.entries.set(id, { abi: 2, plugin: plugin as ChannelPluginV2 });
        continue;
      }
      try {
        const legacy = plugin as ChannelPlugin;
        const runtime = await legacy.create(
          createPluginHostV1(id, {
            ...this.deps,
            store: this.store,
            kick: () => this.attached.kick(),
          }),
        );
        this.entries.set(id, { abi: 1, plugin: legacy, runtime });
      } catch (error) {
        this.failures.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const connection of this.store.list()) {
      // A workspace in Trash keeps its connections stopped across a Gateway restart (P6).
      if (this.archived(connection.workspaceId)) this.store.status(connection.id, ARCHIVED_STATUS);
      else await this.restore(connection);
    }
  }

  catalog(): { plugins: ChannelCatalogEntry[]; failures: ChannelPluginLoadFailure[] } {
    return {
      plugins: [...this.entries.values()].map((entry) =>
        entry.abi === 2 && entry.failure
          ? { manifest: entry.plugin.manifest, state: "degraded" as const, message: entry.failure }
          : { manifest: entry.plugin.manifest, state: "available" as const },
      ),
      failures: [...this.failures],
    };
  }

  /** Whether an ABI-2 plugin's runtime was created; tests prove the lazy load with it. */
  runtimeLoaded(pluginId: string): boolean {
    const entry = this.entries.get(pluginId);
    return entry?.abi === 2 && entry.runtime !== undefined;
  }

  async list(workspaceId: WorkspaceId): Promise<ChannelConnection[]> {
    const out: ChannelConnection[] = [];
    const archived = this.archived(workspaceId);
    for (const connection of this.store.list(workspaceId)) {
      if (archived) {
        out.push({ ...publicChannelConnection(connection), status: ARCHIVED_STATUS });
        continue;
      }
      let status = connection.status;
      try {
        const live = await this.liveStatus(connection);
        if (live) {
          status = live;
          this.store.status(connection.id, status);
        }
      } catch (error) {
        status = { phase: "degraded", message: this.safeError(error) };
      }
      out.push({ ...publicChannelConnection(connection), status });
    }
    return out;
  }

  async connect(
    workspaceId: WorkspaceId,
    pluginId: string,
    input: unknown,
  ): Promise<ChannelConnection> {
    this.deps.workspaces.mustGet(workspaceId);
    const body = asObject(input);
    const entry = this.entries.get(pluginId);
    if (!entry) throw new DeskmatesError("not_found", `channel plugin ${pluginId} is unavailable`);
    const methodId = typeof body.method === "string" ? body.method : "";
    const method = entry.plugin.manifest.methods.find((candidate) => candidate.id === methodId);
    if (!method) throw new DeskmatesError("validation", "unknown channel connection method");
    const botId = body.botId as BotId;
    const bot = this.deps.bots.mustGet(botId);
    if (bot.workspaceId !== workspaceId)
      throw new DeskmatesError("validation", "default bot belongs to another workspace");
    const { config, secrets } = parseFields(method, body.config);
    if (entry.abi === 2)
      return this.connectV2(entry, workspaceId, methodId, botId, config, secrets);
    const secretId = this.putSecrets(workspaceId, secrets);
    let stored: StoredChannelConnection;
    try {
      stored = this.store.create({
        workspaceId,
        pluginId,
        pluginVersion: entry.plugin.manifest.version,
        method: methodId,
        botId,
        config,
        ...(secretId ? { secretId } : {}),
      });
    } catch (error) {
      if (secretId) this.deps.secrets.delete(secretId);
      throw error;
    }
    const request = await this.legacyRequest(stored);
    try {
      const status = await entry.runtime.connect(request);
      stored = this.store.status(stored.id, status);
      return { ...publicChannelConnection(stored), status };
    } catch (error) {
      const status = { phase: "degraded", message: this.safeError(error) };
      stored = this.store.status(stored.id, status);
      return { ...publicChannelConnection(stored), status };
    }
  }

  /** The plugin-addressed command route: the workspace's only connection of that plugin. */
  async command(
    workspaceId: WorkspaceId,
    pluginId: string,
    command: ChannelCommand,
    input?: unknown,
  ): Promise<ChannelConnection | undefined> {
    const connection = this.store.forPlugin(workspaceId, pluginId);
    if (!connection) throw new DeskmatesError("not_found", "channel connection not found");
    return this.connectionCommand(workspaceId, connection.id, command, input);
  }

  async commandMenu(
    workspaceId: WorkspaceId,
    connectionId: string,
    input: unknown,
  ): Promise<ChannelMenuResult> {
    const request = parseChannelMenuRequest(input);
    const connection = this.store.mustGetInWorkspace(workspaceId, connectionId);
    this.refuseArchived(workspaceId);
    const entry = this.entries.get(connection.pluginId);
    if (entry?.abi !== 2 || !entry.plugin.manifest.commandMenu)
      throw new DeskmatesError("invalid_transition", "this channel offers no command menu");
    const runtime = await this.runtimeV2(entry);
    if (!runtime.commandMenu)
      throw new DeskmatesError("invalid_transition", "command menu is unavailable");
    return runtime.commandMenu(connection.id, request);
  }

  async connectionCommand(
    workspaceId: WorkspaceId,
    connectionId: string,
    command: ChannelCommand,
    input?: unknown,
  ): Promise<ChannelConnection | undefined> {
    if (!LEGACY_COMMANDS.has(command))
      throw new DeskmatesError("validation", "unknown channel command");
    const connection = this.store.mustGetInWorkspace(workspaceId, connectionId);
    this.refuseArchived(workspaceId);
    const entry = this.entries.get(connection.pluginId);
    if (!entry || (entry.abi === 2) !== (connection.apiVersion === 2))
      throw new DeskmatesError("invalid_transition", "channel plugin is degraded");
    if (entry.abi === 2) return this.commandV2(entry, connection, command, input);
    const status = await entry.runtime.command(
      connection.id,
      command,
      input === undefined ? undefined : asObject(input),
    );
    if (command !== "disconnect") {
      const saved = this.store.status(connection.id, status);
      return { ...publicChannelConnection(saved), status };
    }
    this.store.delete(connection.id);
    if (connection.secretId) this.deps.secrets.delete(connection.secretId);
    await rm(this.stateDirectory(connection), { recursive: true, force: true });
    return undefined;
  }

  /**
   * Bind an ABI-2 connection to another Bot of its workspace (ADR-0047 decision 8): the fence
   * first, then the old generation's runs, approvals and unsent outbound, then the new host.
   */
  async rebind(
    workspaceId: WorkspaceId,
    connectionId: string,
    botId: unknown,
  ): Promise<{
    connection: ChannelConnection;
    before: { botId: BotId; bindingGeneration: number };
    fence: ChannelFenceSummary;
  }> {
    const connection = this.store.mustGetInWorkspace(workspaceId, connectionId);
    this.refuseArchived(workspaceId);
    const entry = this.entries.get(connection.pluginId);
    if (connection.apiVersion !== 2 || entry?.abi !== 2)
      throw new DeskmatesError(
        "invalid_transition",
        "this channel keeps one Bot per connection; disconnect it and connect again",
      );
    if (typeof botId !== "string") throw new DeskmatesError("validation", "botId is required");
    const bot = this.deps.bots.mustGet(botId as BotId);
    if (bot.workspaceId !== workspaceId)
      throw new DeskmatesError("validation", "the Bot belongs to another workspace");
    if (bot.id === connection.botId)
      throw new DeskmatesError("invalid_transition", "the connection is already bound to this Bot");
    const before = { botId: connection.botId, bindingGeneration: connection.bindingGeneration };
    const fenced = this.store.rebind(connection.id, bot.id, connection.bindingGeneration);
    this.hosts.revoke(connection.id);
    const runtime = await this.runtimeV2(entry);
    await this.closeQuietly(runtime, connection.id, "rebind");
    const fence = this.retire(fenced, "binding_changed", {
      stopRuns: true,
      beforeGeneration: fenced.bindingGeneration,
    });
    const status = await this.openV2(runtime, fenced, "rebind");
    return {
      connection: { ...publicChannelConnection(this.store.get(fenced.id) ?? fenced), status },
      before,
      fence,
    };
  }

  async listBlocks(workspaceId: WorkspaceId, connectionId: string): Promise<ChannelSenderBlock[]> {
    const connection = this.blockable(workspaceId, connectionId, false);
    return this.blocks.list(connection.id);
  }

  block(
    workspaceId: WorkspaceId,
    connectionId: string,
    input: unknown,
    actor: string,
  ): { block: ChannelSenderBlock; created: boolean } {
    const connection = this.blockable(workspaceId, connectionId);
    const body = asObject(input);
    const senderId = parseSenderId(body.senderId);
    return this.blocks.add({
      workspaceId,
      connectionId: connection.id,
      senderId,
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      createdBy: actor,
    });
  }

  unblock(workspaceId: WorkspaceId, connectionId: string, senderId: string): boolean {
    const connection = this.blockable(workspaceId, connectionId);
    return this.blocks.remove(connection.id, parseSenderId(senderId));
  }

  async webhook(
    workspaceId: WorkspaceId,
    pluginId: string,
    request: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string | undefined>;
      body: Uint8Array;
    },
    connectionId?: string,
  ) {
    const connection =
      connectionId === undefined
        ? this.store.forPlugin(workspaceId, pluginId)
        : this.store.get(connectionId);
    if (!connection || connection.workspaceId !== workspaceId || connection.pluginId !== pluginId)
      throw new DeskmatesError("not_found", "channel connection not found");
    // A stopped connection admits nothing; the provider may redeliver after a restore.
    if (this.archived(workspaceId)) return { status: 503, body: "channel stopped" };
    const entry = this.entries.get(pluginId);
    if (!entry) return { status: 503, body: "channel unavailable" };
    if (entry.abi === 1) return entry.runtime.webhook({ connectionId: connection.id, ...request });
    if (!entry.runtime) return { status: 503, body: "channel unavailable" };
    return (await entry.runtime).webhook({ connectionId: connection.id, ...request });
  }

  /**
   * A workspace moved to Trash (ADR-0017 amendment 1 P6, ADR-0026 decision 2): every connection
   * of it stops. Its host goes stale first, so the plugin can admit no inbound and send nothing;
   * then the provider session is closed with `archive`, which keeps the link, the private state
   * directory and the secret records. Outbound the archive left unsent is recorded `cancelled`, so
   * a restore does not deliver it later (decision 3: restore does not replay). Idempotent.
   *
   * An ABI-1 runtime has no per-connection stop: its plugin-wide host stops reaching the
   * workspace (`ChannelStore.workspacesOf`) and the runtime itself keeps running.
   */
  async archiveWorkspace(workspaceId: WorkspaceId): Promise<void> {
    for (const connection of this.store.list(workspaceId)) {
      this.hosts.revoke(connection.id);
      const entry = this.entries.get(connection.pluginId);
      if (entry?.abi === 2 && entry.runtime) {
        try {
          await this.closeQuietly(await entry.runtime, connection.id, "archive");
        } catch (error) {
          // The runtime failed to load; nothing of this connection is live.
          this.safeError(error);
        }
      }
      if (connection.apiVersion === 2)
        this.retire(connection, "workspace_archived", { stopRuns: false });
      this.store.status(connection.id, ARCHIVED_STATUS);
    }
  }

  /**
   * A workspace restored from Trash: each connection opens again through its normal lifecycle
   * (`open` with reason `restore`; an ABI-1 runtime's `restore`), with the same binding and
   * credential generation, the same secrets and state directory, so nothing is relinked. Missed
   * provider messages are not replayed by the Gateway.
   */
  async restoreWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (this.archived(workspaceId)) return;
    for (const connection of this.store.list(workspaceId)) await this.restore(connection);
  }

  /**
   * Before a workspace's rows are purged (ADR-0047 decision 14, ADR-0017 amendment 1 P6): close
   * each of its live connections as a disconnect does, so a QR link is logged out and no provider
   * session outlives the workspace, and remove its channel state directories. The rows and
   * secret records go with the workspace row.
   */
  async permanentlyDeleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    for (const connection of this.store.list(workspaceId)) {
      this.hosts.revoke(connection.id);
      const entry = this.entries.get(connection.pluginId);
      try {
        if (entry?.abi === 2 && entry.runtime)
          await (await entry.runtime).close(connection.id, "disconnect");
        else if (entry?.abi === 1) await entry.runtime.command(connection.id, "disconnect");
      } catch (error) {
        this.safeError(error);
      }
    }
    await rm(resolve(this.deps.stateRoot, workspaceId), { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        if (entry.abi === 1) return entry.runtime.stop();
        if (entry.runtime) return (await entry.runtime).stop();
      }),
    );
  }

  // ABI 2 ----------------------------------------------------------------------------------

  private runtimeV2(entry: Extract<Entry, { abi: 2 }>): Promise<ChannelPluginRuntimeV2> {
    if (!entry.runtime) {
      const id = entry.plugin.manifest.id;
      entry.runtime = entry.plugin
        .create({
          log: (level, message, data) =>
            this.deps.log(level, message, { ...(data ?? {}), pluginId: id }),
        })
        .catch((error: unknown) => {
          entry.failure = error instanceof Error ? error.message : String(error);
          throw new DeskmatesError("invalid_transition", "channel plugin is degraded");
        });
    }
    return entry.runtime;
  }

  private async verify(
    runtime: ChannelPluginRuntimeV2,
    pluginId: string,
    workspaceId: WorkspaceId,
    method: string,
    config: Readonly<Record<string, unknown>>,
    secrets: Readonly<Record<string, string>>,
  ): Promise<ChannelIdentity> {
    let identity: ChannelIdentity;
    try {
      identity = await runtime.verify({ workspaceId, method, config, secrets });
    } catch (error) {
      throw new DeskmatesError(
        "validation",
        "The provider did not accept these credentials. Check them and try again.",
        { reason: "channel_verify_failed", error: this.safeError(error) },
      );
    }
    if (!isChannelIdentityKey(identity?.identityKey, pluginId))
      throw new DeskmatesError("validation", "the channel plugin returned no valid identity", {
        reason: "channel_identity_invalid",
      });
    const label =
      typeof identity.label === "string" && identity.label.trim()
        ? identity.label.trim().slice(0, CHANNEL_IDENTITY_LABEL_MAX)
        : identity.identityKey;
    return { identityKey: identity.identityKey, label };
  }

  private async connectV2(
    entry: Extract<Entry, { abi: 2 }>,
    workspaceId: WorkspaceId,
    method: string,
    botId: BotId,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<ChannelConnection> {
    const manifest = entry.plugin.manifest;
    if (!manifest.multipleConnections && this.store.forPluginAll(workspaceId, manifest.id).length)
      throw new DeskmatesError(
        "invalid_transition",
        "disconnect the existing channel before changing its method",
        { pluginId: manifest.id },
      );
    const runtime = await this.runtimeV2(entry);
    // A `link` method learns its identity only when the person links; the plugin claims it then
    // through the host, under the same uniqueness rule (ADR-0047 amendment 1).
    const linked = manifest.methods.find((item) => item.id === method)?.identity === "link";
    const identity = linked
      ? undefined
      : await this.verify(runtime, manifest.id, workspaceId, method, config, secrets);
    // Refused before any secret or row exists (ADR-0047 decision 7).
    if (identity && this.store.byIdentity(manifest.id, identity.identityKey))
      throw new DeskmatesError(
        "channel_identity_in_use",
        "This account is already connected to an Agent in this installation. Disconnect it there first, or connect a different account.",
        { pluginId: manifest.id },
      );
    const secretId = this.putSecrets(workspaceId, secrets);
    let stored: StoredChannelConnection;
    try {
      stored = this.store.create({
        workspaceId,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        method,
        botId,
        config,
        ...(identity ? { identity } : { pendingIdentity: true }),
        multipleConnections: manifest.multipleConnections,
        ...(secretId ? { secretId } : {}),
      });
    } catch (error) {
      if (secretId) this.deps.secrets.delete(secretId);
      throw error;
    }
    const status = await this.openV2(runtime, stored, "connect");
    return { ...publicChannelConnection(this.store.get(stored.id) ?? stored), status };
  }

  private async commandV2(
    entry: Extract<Entry, { abi: 2 }>,
    connection: StoredChannelConnection,
    command: ChannelCommand,
    input: unknown,
  ): Promise<ChannelConnection | undefined> {
    const runtime = await this.runtimeV2(entry);
    if (command === "disconnect") {
      this.hosts.revoke(connection.id);
      await this.closeQuietly(runtime, connection.id, "disconnect");
      // Nothing more can be relayed; the conversations' runs and approvals stay as they are.
      this.retire(connection, "disconnected", { stopRuns: false });
      this.store.delete(connection.id);
      if (connection.secretId) this.deps.secrets.delete(connection.secretId);
      await rm(this.stateDirectory(connection), { recursive: true, force: true });
      return undefined;
    }
    if (command === "test") {
      if (entry.plugin.manifest.capabilities.testMessage !== "available")
        throw new DeskmatesError("invalid_transition", "this channel offers no test message");
      const status = await runtime.test(connection.id, input === undefined ? {} : asObject(input));
      const saved = this.store.status(connection.id, status);
      return { ...publicChannelConnection(saved), status };
    }
    if (command === "relink") return this.relinkV2(entry, runtime, connection, input);
    this.hosts.revoke(connection.id);
    await this.closeQuietly(runtime, connection.id, "reconnect");
    const status = await this.openV2(runtime, connection, "reconnect");
    return { ...publicChannelConnection(this.store.get(connection.id) ?? connection), status };
  }

  /**
   * A credential change for the same identity (ADR-0047 decision 8): verified before anything
   * changes, refused with `channel_identity_mismatch` when it names another account; the binding
   * generation stays and the credential generation increments.
   */
  private async relinkV2(
    entry: Extract<Entry, { abi: 2 }>,
    runtime: ChannelPluginRuntimeV2,
    connection: StoredChannelConnection,
    input: unknown,
  ): Promise<ChannelConnection> {
    const method = entry.plugin.manifest.methods.find((item) => item.id === connection.method);
    if (!method) throw new DeskmatesError("validation", "unknown channel connection method");
    const body = asObject(input ?? {});
    const { config: supplied, secrets: suppliedSecrets } = parseFields(method, body.config);
    const config = { ...connection.config, ...supplied };
    // A relink replaces the credentials it is given and keeps the others (a QR relink gives none).
    const secrets = { ...(await this.legacyRequest(connection)).secrets, ...suppliedSecrets };
    // A `link` method has nothing to verify yet: the plugin claims the identity after the new
    // link, and a different account is refused then with the same error.
    const identity =
      method.identity === "link"
        ? { identityKey: connection.identityKey ?? "", label: connection.identityLabel ?? "" }
        : await this.verify(
            runtime,
            connection.pluginId,
            connection.workspaceId,
            connection.method,
            config,
            secrets,
          );
    if (identity.identityKey !== connection.identityKey)
      throw new DeskmatesError(
        "channel_identity_mismatch",
        "These credentials belong to a different account. Connect it as a new connection instead.",
        { connectionId: connection.id },
      );
    const secretId = this.putSecrets(connection.workspaceId, secrets);
    this.hosts.revoke(connection.id);
    const relinked = this.store.relink(connection.id, secretId);
    if (connection.secretId && connection.secretId !== secretId)
      this.deps.secrets.delete(connection.secretId);
    await this.closeQuietly(runtime, connection.id, "relink");
    const status = await this.openV2(runtime, relinked, "relink");
    return { ...publicChannelConnection(this.store.get(connection.id) ?? relinked), status };
  }

  private async openV2(
    runtime: ChannelPluginRuntimeV2,
    connection: StoredChannelConnection,
    reason: ChannelOpenReason,
  ): Promise<ChannelConnectionStatus> {
    try {
      const request = await this.openRequest(connection, reason);
      const entry = this.entries.get(connection.pluginId);
      const admission =
        entry?.abi === 2 ? channelSenderAdmission(entry.plugin.manifest) : undefined;
      const status = await runtime.open(request, this.hosts.issue(connection, admission));
      this.store.status(connection.id, status);
      return status;
    } catch (error) {
      const status = { phase: "degraded", message: this.safeError(error) };
      this.store.status(connection.id, status);
      return status;
    }
  }

  private async closeQuietly(
    runtime: ChannelPluginRuntimeV2,
    connectionId: string,
    reason: ChannelCloseReason,
  ): Promise<void> {
    try {
      await runtime.close(connectionId, reason);
    } catch (error) {
      this.safeError(error);
    }
  }

  /**
   * The fence's Gateway half: in the connection's threads (below `beforeGeneration` when given,
   * every one otherwise) record every unsent outbound message `cancelled` and, for a rebind,
   * close pending approvals with `reason` and cancel live runs. History, sessions and threads
   * stay.
   */
  private retire(
    connection: StoredChannelConnection,
    reason: string,
    options: { stopRuns: boolean; beforeGeneration?: number },
  ): ChannelFenceSummary {
    const { beforeGeneration } = options;
    const threads = (
      this.deps.db
        .prepare(
          `SELECT id, binding_generation FROM threads WHERE channel_connection_id = ?
             AND (? IS NULL OR binding_generation < ?)`,
        )
        .all(connection.id, beforeGeneration ?? null, beforeGeneration ?? null) as {
        id: string;
        binding_generation: number;
      }[]
    ).map((row) => ({ id: row.id, bindingGeneration: row.binding_generation }));
    let runsCancelled = 0;
    for (const { id: threadId } of options.stopRuns ? threads : []) {
      for (const run of this.deps.runs.list({ threadId: threadId as ThreadId })) {
        if (isTerminal(run.status)) continue;
        this.deps.broker.closeForRun(run.id, FENCE_ACTOR, reason);
        try {
          this.attached.cancelRun(run.id, FENCE_ACTOR);
          runsCancelled += 1;
        } catch (error) {
          if (!isDeskmatesError(error) || error.code !== "invalid_transition") throw error;
        }
      }
    }
    const outboundCancelled = this.receipts.cancelUnsent(
      {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        credentialGeneration: connection.credentialGeneration,
      },
      connection.pluginId,
      threads,
      reason,
    );
    this.deps.log("info", "channel connection fenced", {
      connectionId: connection.id,
      reason,
      threads: threads.length,
      runsCancelled,
      outboundCancelled,
    });
    return { runsCancelled, outboundCancelled };
  }

  private blockable(
    workspaceId: WorkspaceId,
    connectionId: string,
    write = true,
  ): StoredChannelConnection {
    const connection = this.store.mustGetInWorkspace(workspaceId, connectionId);
    if (write) this.refuseArchived(workspaceId);
    const entry = this.entries.get(connection.pluginId);
    const allowlisted =
      entry?.abi === 2 && channelSenderAdmission(entry.plugin.manifest).mode === "allowlist";
    if (connection.apiVersion !== 2 || allowlisted)
      throw new DeskmatesError(
        "invalid_transition",
        "this channel admits senders by its own allowlist (ADR-0047 amendment 1 A2)",
      );
    return connection;
  }

  private async openRequest(
    connection: StoredChannelConnection,
    reason: ChannelOpenReason,
  ): Promise<ChannelOpenRequest> {
    const legacy = await this.legacyRequest(connection);
    return {
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      botId: connection.botId,
      identityKey: connection.identityKey ?? "",
      bindingGeneration: connection.bindingGeneration,
      credentialGeneration: connection.credentialGeneration,
      reason,
      method: connection.method,
      config: connection.config,
      secrets: legacy.secrets,
      stateDirectory: legacy.stateDirectory,
    };
  }

  // Shared ---------------------------------------------------------------------------------

  /** Whether the workspace is in Trash (an existing row the active-only lookup does not see). */
  private archived(workspaceId: WorkspaceId): boolean {
    return this.deps.workspaces.get(workspaceId) === undefined;
  }

  /** A trashed workspace is read-only (ADR-0026 decision 1): no lifecycle command reopens it. */
  private refuseArchived(workspaceId: WorkspaceId): void {
    if (this.archived(workspaceId))
      throw new DeskmatesError(
        "invalid_transition",
        "This workspace is in Trash; its channel connections are stopped. Restore it first.",
        { reason: "workspace_archived" },
      );
  }

  private async liveStatus(
    connection: StoredChannelConnection,
  ): Promise<ChannelConnectionStatus | undefined> {
    const entry = this.entries.get(connection.pluginId);
    if (!entry) return undefined;
    if (entry.abi === 1) return entry.runtime.status(connection.id);
    if (!entry.runtime) return undefined;
    return (await entry.runtime).status(connection.id);
  }

  private async restore(connection: StoredChannelConnection): Promise<void> {
    const entry = this.entries.get(connection.pluginId);
    const abiMatches = entry && (entry.abi === 2) === (connection.apiVersion === 2);
    if (!entry || !abiMatches || entry.plugin.manifest.version !== connection.pluginVersion) {
      this.store.status(connection.id, {
        phase: "degraded",
        message: !entry
          ? "release plugin unavailable"
          : "connection needs a compatible plugin version",
      });
      return;
    }
    if (entry.abi === 2) {
      try {
        await this.openV2(await this.runtimeV2(entry), connection, "restore");
      } catch (error) {
        this.store.status(connection.id, { phase: "degraded", message: this.safeError(error) });
      }
      return;
    }
    try {
      const status = await entry.runtime.restore(await this.legacyRequest(connection));
      this.store.status(connection.id, status);
    } catch (error) {
      this.store.status(connection.id, { phase: "degraded", message: this.safeError(error) });
    }
  }

  private putSecrets(
    workspaceId: WorkspaceId,
    secrets: Record<string, string>,
  ): string | undefined {
    if (Object.keys(secrets).length === 0) return undefined;
    return this.deps.secrets.put("workspace", workspaceId, JSON.stringify(secrets));
  }

  private async legacyRequest(connection: StoredChannelConnection): Promise<ChannelConnectRequest> {
    const stateDirectory = this.stateDirectory(connection);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const secrets = connection.secretId
      ? (JSON.parse(this.deps.secrets.get(connection.secretId)) as Record<string, string>)
      : {};
    return {
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      botId: connection.botId,
      method: connection.method,
      config: connection.config,
      secrets,
      stateDirectory,
    };
  }

  private stateDirectory(connection: StoredChannelConnection): string {
    return resolve(this.deps.stateRoot, connection.workspaceId, connection.pluginId, connection.id);
  }

  private safeError(error: unknown): string {
    this.deps.log("warn", "channel operation failed", channelErrorLogFields(error));
    return "Channel operation failed. Check the Gateway log and try again.";
  }
}

const LOGGED_MESSAGE_CHARS = 500;

/**
 * What the Gateway log keeps of a failed channel operation: the error's name, its code when it
 * has one, and its message with secret-shaped text redacted and bounded. The operator is told to
 * check this log, so it must say more than `Error`; a provider error may carry a token in a URL
 * or header, which the scrub removes.
 */
export function channelErrorLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: "unknown" };
  const code = (error as { code?: unknown }).code;
  return {
    error: error.name,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    message: scrubText(error.message).text.slice(0, LOGGED_MESSAGE_CHARS),
  };
}
