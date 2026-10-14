import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ApprovalId,
  type BotId,
  type ChannelCommand,
  type ChannelConnectRequest,
  type ChannelConnection,
  type ChannelConnectionStatus,
  type ChannelPlugin,
  type ChannelPluginHost,
  type ChannelPluginManifest,
  type ChannelPluginRuntime,
  DeskmatesError,
  type ThreadId,
  type WorkspaceId,
  decidedByHuman,
} from "@deskmates/contracts";
import type { ApprovalStore } from "../approvals/approvals.js";
import type { ApprovalBroker } from "../approvals/broker.js";
import type { BotStore } from "../bots/bots.js";
import type { EventBus } from "../events/bus.js";
import type { SecretsStore } from "../secrets/secrets-store.js";
import type { Ownership } from "../tenancy/ownership.js";
import type { TenantQuotas } from "../tenancy/quotas.js";
import type { MessageStore } from "../threads/messages.js";
import type { ThreadRouter } from "../threads/router.js";
import type { ThreadStore } from "../threads/threads.js";
import type { WorkspaceStore } from "../workspaces/workspaces.js";
import {
  type ChannelStore,
  type StoredChannelConnection,
  publicChannelConnection,
} from "./channel-store.js";
import type { ChannelPluginLoadFailure } from "./plugin-loader.js";

interface ManagerDeps {
  store: ChannelStore;
  secrets: SecretsStore;
  workspaces: WorkspaceStore;
  bots: BotStore;
  threads: ThreadStore;
  messages: MessageStore;
  router: ThreadRouter;
  approvals: ApprovalStore;
  broker: ApprovalBroker;
  ownership: Ownership;
  quotas: TenantQuotas;
  bus: EventBus;
  stateRoot: string;
  log(level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface ChannelCatalogEntry {
  manifest: ChannelPluginManifest;
  state: "available" | "degraded";
  message?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeskmatesError("validation", "channel configuration must be an object");
  }
  return value as Record<string, unknown>;
}

export class ChannelManager {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly runtimes = new Map<string, ChannelPluginRuntime>();
  private failures: ChannelPluginLoadFailure[] = [];
  private kick: () => void = () => {};

  constructor(private readonly deps: ManagerDeps) {}

  setKick(kick: () => void): void {
    this.kick = kick;
  }

  async initialize(
    loaded: Map<string, ChannelPlugin>,
    failures: readonly ChannelPluginLoadFailure[] = [],
  ): Promise<void> {
    this.failures = [...failures];
    for (const [id, plugin] of loaded) {
      try {
        const runtime = await plugin.create(this.host());
        this.plugins.set(id, plugin);
        this.runtimes.set(id, runtime);
      } catch (error) {
        this.failures.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const connection of this.deps.store.list()) await this.restore(connection);
  }

  catalog(): { plugins: ChannelCatalogEntry[]; failures: ChannelPluginLoadFailure[] } {
    return {
      plugins: [...this.plugins.values()].map((plugin) => ({
        manifest: plugin.manifest,
        state: "available" as const,
      })),
      failures: [...this.failures],
    };
  }

  async list(workspaceId: WorkspaceId): Promise<ChannelConnection[]> {
    const out: ChannelConnection[] = [];
    for (const connection of this.deps.store.list(workspaceId)) {
      const runtime = this.runtimes.get(connection.pluginId);
      let status = connection.status;
      if (runtime) {
        try {
          status = await runtime.status(connection.id);
          this.deps.store.status(connection.id, status);
        } catch (error) {
          status = { phase: "degraded", message: this.safeError(error) };
        }
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
    const plugin = this.plugins.get(pluginId);
    const runtime = this.runtimes.get(pluginId);
    if (!plugin || !runtime)
      throw new DeskmatesError("not_found", `channel plugin ${pluginId} is unavailable`);
    const methodId = typeof body.method === "string" ? body.method : "";
    const method = plugin.manifest.methods.find((candidate) => candidate.id === methodId);
    if (!method) throw new DeskmatesError("validation", "unknown channel connection method");
    const botId = body.botId as BotId;
    const bot = this.deps.bots.mustGet(botId);
    if (bot.workspaceId !== workspaceId)
      throw new DeskmatesError("validation", "default bot belongs to another workspace");
    const supplied = asObject(body.config ?? {});
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
    let secretId: string | undefined;
    if (Object.keys(secrets).length > 0) {
      secretId = this.deps.secrets.put("workspace", workspaceId, JSON.stringify(secrets));
    }
    let stored: StoredChannelConnection;
    try {
      stored = this.deps.store.create({
        workspaceId,
        pluginId,
        pluginVersion: plugin.manifest.version,
        method: methodId,
        botId,
        config,
        ...(secretId ? { secretId } : {}),
      });
    } catch (error) {
      if (secretId) this.deps.secrets.delete(secretId);
      throw error;
    }
    const request = await this.request(stored);
    try {
      const status = await runtime.connect(request);
      stored = this.deps.store.status(stored.id, status);
      return { ...publicChannelConnection(stored), status };
    } catch (error) {
      const status = { phase: "degraded", message: this.safeError(error) };
      stored = this.deps.store.status(stored.id, status);
      return { ...publicChannelConnection(stored), status };
    }
  }

  async command(
    workspaceId: WorkspaceId,
    pluginId: string,
    command: ChannelCommand,
    input?: unknown,
  ): Promise<ChannelConnection | undefined> {
    const connection = this.deps.store.forPlugin(workspaceId, pluginId);
    if (!connection) throw new DeskmatesError("not_found", "channel connection not found");
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) throw new DeskmatesError("invalid_transition", "channel plugin is degraded");
    const status = await runtime.command(
      connection.id,
      command,
      input === undefined ? undefined : asObject(input),
    );
    if (command !== "disconnect") {
      const saved = this.deps.store.status(connection.id, status);
      return { ...publicChannelConnection(saved), status };
    }
    this.deps.store.delete(connection.id);
    if (connection.secretId) this.deps.secrets.delete(connection.secretId);
    await rm(this.stateDirectory(connection), { recursive: true, force: true });
    return undefined;
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
  ) {
    const connection = this.deps.store.forPlugin(workspaceId, pluginId);
    if (!connection) throw new DeskmatesError("not_found", "channel connection not found");
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) return { status: 503, body: "channel unavailable" };
    return runtime.webhook({ connectionId: connection.id, ...request });
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop()));
  }

  private async restore(connection: StoredChannelConnection): Promise<void> {
    const plugin = this.plugins.get(connection.pluginId);
    const runtime = this.runtimes.get(connection.pluginId);
    if (!plugin || !runtime || plugin.manifest.version !== connection.pluginVersion) {
      this.deps.store.status(connection.id, {
        phase: "degraded",
        message: !plugin
          ? "release plugin unavailable"
          : "connection needs a compatible plugin version",
      });
      return;
    }
    try {
      const status = await runtime.restore(await this.request(connection));
      this.deps.store.status(connection.id, status);
    } catch (error) {
      this.deps.store.status(connection.id, { phase: "degraded", message: this.safeError(error) });
    }
  }

  private async request(connection: StoredChannelConnection): Promise<ChannelConnectRequest> {
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
    this.deps.log("warn", "channel operation failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return "Channel operation failed. Check the Gateway log and try again.";
  }

  private host(): ChannelPluginHost {
    return {
      findThread: async (workspaceId, channel, externalKey) =>
        this.deps.threads.findByExternalKey(workspaceId, channel, externalKey),
      createThread: async (input) => {
        const existing = this.deps.threads.findByExternalKey(
          input.workspaceId,
          input.channel,
          input.externalKey,
        );
        if (existing) return existing;
        const created = this.deps.threads.create({
          workspaceId: input.workspaceId,
          botIds: [input.botId],
          channel: input.channel,
          externalKey: input.externalKey,
          title: input.title,
        });
        this.deps.bus.publish({ type: "thread_members", threadId: created.id });
        return created;
      },
      getThread: async (id) => ({
        thread: this.deps.threads.mustGet(id as ThreadId),
        members: this.deps.threads.members(id as ThreadId),
      }),
      postHumanMessage: async (input) => {
        const threadId = input.threadId as ThreadId;
        const thread = this.deps.threads.mustGet(threadId);
        const tenantId = this.deps.ownership.tenantOf("workspace", thread.workspaceId);
        if (tenantId) this.deps.quotas.assertQueueRoom(tenantId);
        const result = this.deps.router.postHuman({
          threadId,
          body: input.body,
          authorId: input.authorId,
          externalId: input.externalId,
        });
        if (!result.duplicate) {
          this.deps.bus.publish({ type: "thread_message", threadId, message: result.message });
          for (const run of result.runs)
            this.deps.bus.publish({ type: "run_status", threadId, run });
          this.kick();
        }
        return result;
      },
      listMessages: async (threadId, afterSeq) =>
        this.deps.messages.list(threadId as ThreadId, afterSeq),
      getApproval: async (id) => this.deps.approvals.get(id as ApprovalId),
      decideApproval: async (input) => {
        const result = this.deps.broker.decide(
          input.id as ApprovalId,
          input.decision,
          decidedByHuman(input.authorId),
          input.reason,
        );
        this.kick();
        return result.approval;
      },
      subscribe: async (handlers, signal) => {
        await handlers.onOpen();
        const unsubscribe = this.deps.bus.subscribe((event) => {
          void handlers.onFrame(event);
        });
        if (signal.aborted) unsubscribe();
        else
          await new Promise<void>((done) =>
            signal.addEventListener(
              "abort",
              () => {
                unsubscribe();
                done();
              },
              { once: true },
            ),
          );
      },
      log: this.deps.log,
    };
  }
}
