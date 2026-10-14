import { join } from "node:path";
import {
  CHANNEL_PLUGIN_API_VERSION,
  type ChannelConnectRequest,
  type ChannelConnectionStatus,
  type ChannelPlugin,
  type ChannelPluginHost,
  type ChannelPluginRuntime,
  type WorkspaceId,
} from "@deskmates/contracts";
import QRCode from "qrcode";
import { WebAuthStore } from "../whatsapp-web/auth-store.js";
import { createBaileysSocket } from "../whatsapp-web/baileys-socket.js";
import { WebSession, type WebStatus } from "../whatsapp-web/session.js";
import { WhatsAppAdapter } from "./adapter.js";
import {
  GRAPH_API_VERSION_DEFAULT,
  GRAPH_BASE_URL_DEFAULT,
  parseAllowedSenders,
} from "./config.js";
import type { ChannelGatewayClient, GatewayFrame, PostedMessage } from "./gateway-client.js";
import { sendText } from "./outbound.js";
import { SIGNATURE_HEADER, verifySignature } from "./signature.js";
import { FileStateStore } from "./state.js";

interface CommonConnection {
  request: ChannelConnectRequest;
  allowedSenders: ReadonlySet<string>;
  gateway: ChannelGatewayClient;
}

interface QrConnection extends CommonConnection {
  kind: "qr";
  store: WebAuthStore;
  session: WebSession;
  relay: WhatsAppAdapter | undefined;
}

interface CloudConnection extends CommonConnection {
  kind: "cloud";
  adapter: WhatsAppAdapter;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphBaseUrl: string;
  graphApiVersion: string;
}

type Connection = QrConnection | CloudConnection;

const text = (record: Readonly<Record<string, unknown>>, key: string, fallback = ""): string => {
  const value = record[key];
  return typeof value === "string" ? value.trim() : fallback;
};

function requireText(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = text(record, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function publicStatus(status: WebStatus): ChannelConnectionStatus {
  return {
    phase: status.phase,
    ...(status.error ? { message: status.error } : {}),
    ...(status.account ? { account: status.account } : {}),
    ...(status.qr ? { qr: status.qr } : {}),
    ...(status.qrExpiresAt ? { qrExpiresAt: status.qrExpiresAt } : {}),
    details: { reconnects: status.reconnects, inboundFailures: status.inboundFailures },
  };
}

class HostGateway implements ChannelGatewayClient {
  constructor(
    private readonly host: ChannelPluginHost,
    private readonly workspaceId: WorkspaceId,
    private readonly botId: ChannelConnectRequest["botId"],
  ) {}

  findThread(channel: string, externalKey: string) {
    return this.host.findThread(this.workspaceId, channel, externalKey);
  }
  createThread(input: {
    workspaceId: string;
    botIds: readonly string[];
    channel: string;
    externalKey: string;
    title: string;
  }) {
    return this.host.createThread({
      workspaceId: this.workspaceId,
      botId: this.botId,
      channel: input.channel,
      externalKey: input.externalKey,
      title: input.title,
    });
  }
  getThread(id: string) {
    return this.host.getThread(id);
  }
  postHumanMessage(
    threadId: string,
    body: string,
    authorId: string,
    externalId: string,
  ): Promise<PostedMessage> {
    return this.host.postHumanMessage({ threadId, body, authorId, externalId });
  }
  listMessages(threadId: string, afterSeq: number) {
    return this.host.listMessages(threadId, afterSeq);
  }
  getApproval(id: string) {
    return this.host.getApproval(id);
  }
  decideApproval(id: string, decision: "allow_once" | "deny", authorId: string, reason?: string) {
    return this.host.decideApproval({ id, decision, authorId, ...(reason ? { reason } : {}) });
  }
  subscribe(
    handlers: {
      onFrame: (frame: GatewayFrame) => void | Promise<void>;
      onOpen: () => void | Promise<void>;
    },
    signal: AbortSignal,
  ) {
    return this.host.subscribe(handlers, signal);
  }
}

class WhatsAppPluginRuntime implements ChannelPluginRuntime {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly host: ChannelPluginHost) {}

  connect(request: ChannelConnectRequest): Promise<ChannelConnectionStatus> {
    return this.open(request, false);
  }

  restore(request: ChannelConnectRequest): Promise<ChannelConnectionStatus> {
    return this.open(request, true);
  }

  async status(connectionId: string): Promise<ChannelConnectionStatus> {
    const connection = this.mustGet(connectionId);
    if (connection.kind === "qr") return publicStatus(connection.session.snapshot());
    return { phase: "connected", account: connection.phoneNumberId };
  }

  async command(
    connectionId: string,
    command: "reconnect" | "relink" | "test" | "disconnect",
    input: Readonly<Record<string, unknown>> = {},
  ): Promise<ChannelConnectionStatus> {
    const connection = this.mustGet(connectionId);
    if (command === "disconnect") {
      await this.close(connection, true);
      this.connections.delete(connectionId);
      return { phase: "disconnected" };
    }
    if (command === "relink") {
      if (connection.kind !== "qr") throw new Error("re-link is available only for QR connections");
      await connection.session.logout();
      await connection.session.connect();
      return publicStatus(connection.session.snapshot());
    }
    if (command === "reconnect") {
      if (connection.kind === "qr") {
        await connection.session.stop();
        await connection.session.connect();
        return publicStatus(connection.session.snapshot());
      }
      connection.adapter.start();
      return { phase: "connected", account: connection.phoneNumberId };
    }
    const to = requireText(input, "to").replace(/^\+/, "");
    const body = text(input, "text", "Hi from Deskmates");
    if (!connection.allowedSenders.has(to)) throw new Error("test recipient is not allowlisted");
    const result =
      connection.kind === "qr"
        ? await connection.session.send(to, body)
        : await sendText(
            {
              graphBaseUrl: connection.graphBaseUrl,
              graphApiVersion: connection.graphApiVersion,
              phoneNumberId: connection.phoneNumberId,
              accessToken: connection.accessToken,
              fetch: (url, init) => fetch(url, init),
              retries: 3,
            },
            to,
            body,
          );
    if (!result.ok) throw new Error("test message was refused by the channel transport");
    return this.status(connectionId);
  }

  async webhook(request: Parameters<ChannelPluginRuntime["webhook"]>[0]) {
    const connection = this.mustGet(request.connectionId);
    if (connection.kind !== "cloud") return { status: 404, body: "not a webhook connection" };
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET") {
      const valid =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === connection.verifyToken;
      const challenge = url.searchParams.get("hub.challenge");
      return valid && challenge !== null
        ? { status: 200, body: challenge }
        : { status: 403, body: "verification failed" };
    }
    const raw = Buffer.from(request.body);
    if (!verifySignature(raw, request.headers[SIGNATURE_HEADER], connection.appSecret)) {
      return { status: 401, body: "invalid signature" };
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return { status: 400, body: "body is not JSON" };
    }
    const result = await connection.adapter.handleWebhook(body);
    return { status: result.status, body: result.status === 200 ? "ok" : "retry later" };
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.close(connection, false)),
    );
    this.connections.clear();
  }

  private async open(
    request: ChannelConnectRequest,
    restoring: boolean,
  ): Promise<ChannelConnectionStatus> {
    if (this.connections.has(request.connectionId)) return this.status(request.connectionId);
    const allowedSenders = parseAllowedSenders(text(request.config, "allowedSenders"));
    const gateway = new HostGateway(this.host, request.workspaceId, request.botId);
    if (request.method === "cloud") {
      const phoneNumberId = requireText(request.config, "phoneNumberId");
      const accessToken = requireText(request.secrets, "accessToken");
      const appSecret = requireText(request.secrets, "appSecret");
      const verifyToken = requireText(request.secrets, "verifyToken");
      const graphBaseUrl = text(request.config, "graphBaseUrl", GRAPH_BASE_URL_DEFAULT).replace(
        /\/+$/,
        "",
      );
      const graphApiVersion = text(request.config, "graphApiVersion", GRAPH_API_VERSION_DEFAULT);
      const adapter = new WhatsAppAdapter({
        config: {
          phoneNumberId,
          allowedSenders,
          workspaceId: request.workspaceId,
          botIds: [request.botId],
          graphBaseUrl,
          graphApiVersion,
          accessToken,
          sendRetries: 3,
        },
        gateway,
        state: new FileStateStore(join(request.stateDirectory, "relay.json")),
        log: this.log(),
      });
      const connection: CloudConnection = {
        kind: "cloud",
        request,
        allowedSenders,
        gateway,
        adapter,
        phoneNumberId,
        accessToken,
        appSecret,
        verifyToken,
        graphBaseUrl,
        graphApiVersion,
      };
      this.connections.set(request.connectionId, connection);
      adapter.start();
      return { phase: "connected", account: phoneNumberId };
    }
    if (request.method !== "qr") throw new Error("unknown WhatsApp connection method");
    const store = new WebAuthStore(request.stateDirectory);
    const session = new WebSession({
      create: async (callbacks) =>
        createBaileysSocket(store, callbacks, text(request.secrets, "proxyUrl") || undefined),
      encodeQr: (qr) => QRCode.toDataURL(qr, { errorCorrectionLevel: "M", width: 320, margin: 4 }),
      isOutbound: (id) => store.isOutbound(id),
      reset: () => store.reset(),
      pause: async () => {
        await connection.relay?.stop();
        connection.relay = undefined;
      },
      onAccount: async (account) => {
        await connection.relay?.stop();
        connection.relay = new WhatsAppAdapter({
          config: {
            phoneNumberId: `web:${account}`,
            allowedSenders,
            workspaceId: request.workspaceId,
            botIds: [request.botId],
          },
          gateway,
          state: new FileStateStore(join(request.stateDirectory, `relay-${account}.json`)),
          send: (to, body) => session.send(to, body),
          log: this.log(),
        });
        connection.relay.start();
      },
      inbound: async (event) => {
        if (!connection.relay) throw new Error("relay unavailable");
        await connection.relay.handleInbound(event);
      },
    });
    const connection: QrConnection = {
      kind: "qr",
      request,
      allowedSenders,
      gateway,
      store,
      session,
      relay: undefined,
    };
    this.connections.set(request.connectionId, connection);
    if (!restoring || store.state.creds.registered) await session.connect();
    return publicStatus(session.snapshot());
  }

  private mustGet(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("channel connection is not running");
    return connection;
  }

  private async close(connection: Connection, logout: boolean): Promise<void> {
    if (connection.kind === "cloud") {
      await connection.adapter.stop();
      return;
    }
    if (logout) await connection.session.logout();
    else await connection.session.stop();
    connection.store.close();
  }

  private log() {
    return {
      info: (message: string, data?: Record<string, unknown>) =>
        this.host.log("info", message, data),
      warn: (message: string, data?: Record<string, unknown>) =>
        this.host.log("warn", message, data),
    };
  }
}

export const channelPlugin: ChannelPlugin = {
  manifest: {
    apiVersion: CHANNEL_PLUGIN_API_VERSION,
    id: "whatsapp",
    version: "1.0.0",
    displayName: "WhatsApp",
    description: "Connect one WhatsApp account to one default Bot.",
    capabilities: { directMessages: true, groups: false, testMessage: true },
    statusVocabulary: [
      "idle",
      "connecting",
      "qr",
      "connected",
      "reconnecting",
      "logged_out",
      "degraded",
      "error",
    ],
    methods: [
      {
        id: "qr",
        label: "QR linked device",
        description: "Scan a QR code from WhatsApp Linked devices.",
        fields: [
          {
            key: "allowedSenders",
            label: "Allowed phone numbers",
            kind: "phone-list",
            placeholder: "15550001111, 15550002222",
          },
          { key: "proxyUrl", label: "Proxy URL", kind: "password", secret: true },
        ],
      },
      {
        id: "cloud",
        label: "Business Cloud API",
        description: "Use a Meta Business phone number and signed webhooks.",
        fields: [
          { key: "phoneNumberId", label: "Phone number ID", kind: "text", required: true },
          { key: "allowedSenders", label: "Allowed phone numbers", kind: "phone-list" },
          {
            key: "graphApiVersion",
            label: "Graph API version",
            kind: "text",
            placeholder: "v23.0",
          },
          {
            key: "accessToken",
            label: "Access token",
            kind: "password",
            secret: true,
            required: true,
          },
          { key: "appSecret", label: "App secret", kind: "password", secret: true, required: true },
          {
            key: "verifyToken",
            label: "Verify token",
            kind: "password",
            secret: true,
            required: true,
          },
        ],
      },
    ],
  },
  create: async (host) => new WhatsAppPluginRuntime(host),
};
