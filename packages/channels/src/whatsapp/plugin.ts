// The release-bundled WhatsApp channel plugin on ChannelPlugin ABI 2 (ADR-0047 amendment 1). One
// connection per workspace (`multipleConnections: false`, ADR-0017 amendment 1 P4) with one
// default Bot, private chats only, two methods: a QR linked device (ADR-0019), whose identity is
// claimed after the scan, and the Business Cloud API (ADR-0017), verified against the Graph API.
// Senders are admitted by default and kept out by the connection's blocklist, which the Gateway
// holds and enforces (ADR-0017 amendment 3, ADR-0047 decision 13 and amendment 1 A3).

import { join } from "node:path";
import {
  CHANNEL_PLUGIN_API_VERSION_2,
  type ChannelCloseReason,
  type ChannelConnectionHost,
  type ChannelConnectionStatus,
  type ChannelIdentity,
  type ChannelOpenRequest,
  type ChannelPluginContextV2,
  type ChannelPluginRuntimeV2,
  type ChannelPluginV2,
  type ChannelVerifyRequest,
  type ChannelWebhookRequest,
  type ChannelWebhookResponse,
  isPendingChannelIdentityKey,
} from "@deskmates/contracts";
import QRCode from "qrcode";
import { WebAuthStore } from "../whatsapp-web/auth-store.js";
import { createBaileysSocket } from "../whatsapp-web/baileys-socket.js";
import {
  ACCOUNT_REFUSED_ERROR,
  type SocketCallbacks,
  WebSession,
  type WebSocketHandle,
  type WebStatus,
} from "../whatsapp-web/session.js";
import { GRAPH_API_VERSION_DEFAULT, GRAPH_BASE_URL_DEFAULT } from "./config.js";
import { WhatsAppConnectionRelay, isStaleHost } from "./connection-relay.js";
import { cloudIdentityKey, linkedIdentity, verifyCloudNumber } from "./identity.js";
import { sendText } from "./outbound.js";
import { SIGNATURE_HEADER, verifySignature, verifyTokenMatches } from "./signature.js";
import { FileStateStore } from "./state.js";

interface CommonConnection {
  request: ChannelOpenRequest;
  host: ChannelConnectionHost;
}

interface QrConnection extends CommonConnection {
  kind: "qr";
  store: WebAuthStore;
  session: WebSession;
  relay: WhatsAppConnectionRelay | undefined;
}

interface CloudConnection extends CommonConnection {
  kind: "cloud";
  relay: WhatsAppConnectionRelay | undefined;
  /** Why the connection is not serving, when its identity claim was refused. */
  refused?: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphBaseUrl: string;
  graphApiVersion: string;
}

type Connection = QrConnection | CloudConnection;

/** What the runtime reaches outside the process; tests replace both. */
export interface WhatsAppRuntimeDeps {
  fetch: typeof fetch;
  createSocket(
    store: WebAuthStore,
    callbacks: SocketCallbacks,
    proxyUrl: string | undefined,
  ): Promise<WebSocketHandle>;
  encodeQr(qr: string): Promise<string>;
  relayRetry?: { initialMs: number; maxMs: number };
}

const DEFAULT_DEPS: WhatsAppRuntimeDeps = {
  fetch: (url, init) => fetch(url, init),
  createSocket: createBaileysSocket,
  encodeQr: (qr) => QRCode.toDataURL(qr, { errorCorrectionLevel: "M", width: 320, margin: 4 }),
};

const text = (record: Readonly<Record<string, unknown>>, key: string, fallback = ""): string => {
  const value = record[key];
  return typeof value === "string" ? value.trim() : fallback;
};

function requireText(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = text(record, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function graphTarget(config: Readonly<Record<string, unknown>>) {
  return {
    graphBaseUrl: text(config, "graphBaseUrl", GRAPH_BASE_URL_DEFAULT).replace(/\/+$/, ""),
    graphApiVersion: text(config, "graphApiVersion", GRAPH_API_VERSION_DEFAULT),
  };
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

/** The operator-facing words for a refused identity claim (ADR-0047 decision 7). */
function refusalMessage(error: unknown): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (code === "channel_identity_in_use")
    return "This WhatsApp number is already connected to an Agent in this installation. Disconnect it there first.";
  if (code === "channel_identity_mismatch")
    return "This WhatsApp number differs from the one connected here. Disconnect, then connect it as a new connection.";
  return "Could not record this WhatsApp number. Check the Gateway log and try again.";
}

function accountRefused(message: string): Error {
  const error = new Error(message);
  error.name = ACCOUNT_REFUSED_ERROR;
  return error;
}

export class WhatsAppPluginRuntime implements ChannelPluginRuntimeV2 {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly context: ChannelPluginContextV2,
    private readonly deps: WhatsAppRuntimeDeps = DEFAULT_DEPS,
  ) {}

  /** Cloud API only: the QR method's identity is claimed after the scan (`identity: "link"`). */
  async verify(request: ChannelVerifyRequest): Promise<ChannelIdentity> {
    if (request.method !== "cloud") throw new Error("this method is verified when it links");
    return verifyCloudNumber({
      fetch: this.deps.fetch,
      ...graphTarget(request.config),
      phoneNumberId: requireText(request.config, "phoneNumberId"),
      accessToken: requireText(request.secrets, "accessToken"),
    });
  }

  async open(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    const previous = this.connections.get(request.connectionId);
    if (previous) await this.shutdown(previous, false);
    if (request.method === "cloud") return this.openCloud(request, host);
    if (request.method !== "qr") throw new Error("unknown WhatsApp connection method");
    return this.openQr(request, host);
  }

  async close(connectionId: string, reason: ChannelCloseReason): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    // Disconnect is final, and a QR relink starts from a fresh link, as ABI 1's relink did. An
    // archive keeps the link and its state for a restore (ADR-0017 amendment 1 P6).
    await this.shutdown(connection, reason === "disconnect" || reason === "relink");
  }

  async status(connectionId: string): Promise<ChannelConnectionStatus> {
    const connection = this.mustGet(connectionId);
    if (connection.kind === "qr") return publicStatus(connection.session.snapshot());
    if (connection.refused) return { phase: "error", message: connection.refused };
    return { phase: "connected", account: connection.phoneNumberId };
  }

  async test(
    connectionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ChannelConnectionStatus> {
    const connection = this.mustGet(connectionId);
    const to = requireText(input, "to").replace(/^\+/, "");
    const body = text(input, "text", "Hi from Deskmates");
    // ADR-0017 amendment 3 S4: any number the connection does not block.
    if (!(await connection.host.admits?.(to))) throw new Error("test recipient is blocked");
    const result =
      connection.kind === "qr"
        ? await connection.session.send(to, body)
        : await sendText(
            {
              graphBaseUrl: connection.graphBaseUrl,
              graphApiVersion: connection.graphApiVersion,
              phoneNumberId: connection.phoneNumberId,
              accessToken: connection.accessToken,
              fetch: this.deps.fetch,
              retries: 3,
            },
            to,
            body,
          );
    if (!result.ok) throw new Error("test message was refused by the channel transport");
    return this.status(connectionId);
  }

  async webhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    const connection = this.mustGet(request.connectionId);
    if (connection.kind !== "cloud") return { status: 404, body: "not a webhook connection" };
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET") {
      const valid =
        url.searchParams.get("hub.mode") === "subscribe" &&
        verifyTokenMatches(url.searchParams.get("hub.verify_token"), connection.verifyToken);
      const challenge = url.searchParams.get("hub.challenge");
      return valid && challenge !== null
        ? { status: 200, body: challenge }
        : { status: 403, body: "verification failed" };
    }
    const raw = Buffer.from(request.body);
    if (!verifySignature(raw, request.headers[SIGNATURE_HEADER], connection.appSecret)) {
      return { status: 401, body: "invalid signature" };
    }
    if (!connection.relay) return { status: 503, body: "retry later" };
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return { status: 400, body: "body is not JSON" };
    }
    const result = await connection.relay.handleWebhook(body);
    return { status: result.status, body: result.status === 200 ? "ok" : "retry later" };
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.shutdown(connection, false)),
    );
    this.connections.clear();
  }

  private async openCloud(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    const phoneNumberId = requireText(request.config, "phoneNumberId");
    const connection: CloudConnection = {
      kind: "cloud",
      request,
      host,
      relay: undefined,
      phoneNumberId,
      accessToken: requireText(request.secrets, "accessToken"),
      appSecret: requireText(request.secrets, "appSecret"),
      verifyToken: requireText(request.secrets, "verifyToken"),
      ...graphTarget(request.config),
    };
    this.connections.set(request.connectionId, connection);
    // A connection moved from ABI 1 holds a pending key: claim the number it has been serving.
    // A new connection was verified against the Graph API before it was stored.
    if (isPendingChannelIdentityKey(request.identityKey)) {
      try {
        await host.claimIdentity?.({
          identityKey: cloudIdentityKey(phoneNumberId),
          label: phoneNumberId,
        });
      } catch (error) {
        if (isStaleHost(error)) throw error;
        connection.refused = refusalMessage(error);
        return this.status(request.connectionId);
      }
    }
    connection.relay = new WhatsAppConnectionRelay({
      host,
      number: phoneNumberId,
      state: new FileStateStore(join(request.stateDirectory, "relay.json")),
      send: (to, body) =>
        sendText(
          {
            graphBaseUrl: connection.graphBaseUrl,
            graphApiVersion: connection.graphApiVersion,
            phoneNumberId,
            accessToken: connection.accessToken,
            fetch: this.deps.fetch,
            retries: 3,
          },
          to,
          body,
        ),
      log: this.log(host),
      ...(this.deps.relayRetry ? { relayRetry: this.deps.relayRetry } : {}),
    });
    connection.relay.start();
    return { phase: "connected", account: phoneNumberId };
  }

  private async openQr(
    request: ChannelOpenRequest,
    host: ChannelConnectionHost,
  ): Promise<ChannelConnectionStatus> {
    const store = new WebAuthStore(request.stateDirectory);
    const session = new WebSession({
      create: async (callbacks) =>
        this.deps.createSocket(store, callbacks, text(request.secrets, "proxyUrl") || undefined),
      encodeQr: (qr) => this.deps.encodeQr(qr),
      isOutbound: (id) => store.isOutbound(id),
      reset: () => store.reset(),
      pause: async () => {
        await connection.relay?.stop();
        connection.relay = undefined;
      },
      onAccount: async (account) => {
        await connection.relay?.stop();
        connection.relay = undefined;
        try {
          // The identity is known only now (ADR-0047 amendment 1); another connection's number,
          // or a different number than this connection's, is refused before anything is relayed.
          await host.claimIdentity?.(linkedIdentity(account));
        } catch (error) {
          throw accountRefused(refusalMessage(error));
        }
        connection.relay = new WhatsAppConnectionRelay({
          host,
          number: `web:${account}`,
          state: new FileStateStore(join(request.stateDirectory, `relay-${account}.json`)),
          send: (to, body) => session.send(to, body),
          log: this.log(host),
          ...(this.deps.relayRetry ? { relayRetry: this.deps.relayRetry } : {}),
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
      host,
      store,
      session,
      relay: undefined,
    };
    this.connections.set(request.connectionId, connection);
    // After a Gateway restart an unlinked session waits for an operator; every other open links.
    if (request.reason !== "restore" || store.state.creds.registered) await session.connect();
    return publicStatus(session.snapshot());
  }

  private mustGet(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("channel connection is not running");
    return connection;
  }

  private async shutdown(connection: Connection, logout: boolean): Promise<void> {
    if (connection.kind === "cloud") {
      await connection.relay?.stop();
      return;
    }
    if (logout) await connection.session.logout();
    else await connection.session.stop();
    connection.store.close();
  }

  private log(host: ChannelConnectionHost) {
    return {
      info: (message: string, data?: Record<string, unknown>) => host.log("info", message, data),
      warn: (message: string, data?: Record<string, unknown>) => host.log("warn", message, data),
    };
  }
}

export const channelPlugin: ChannelPluginV2 = {
  manifest: {
    apiVersion: CHANNEL_PLUGIN_API_VERSION_2,
    id: "whatsapp",
    version: "2.0.0",
    displayName: "WhatsApp",
    description: "Connect one WhatsApp account to one default Bot.",
    // ADR-0017 amendment 1 P4: one connection per workspace.
    multipleConnections: false,
    // ADR-0017 amendment 3: allow by default; the connection's blocklist keeps a person out.
    senderAdmission: { mode: "blocklist" },
    capabilities: {
      directMessages: "available",
      groups: "unavailable",
      // Unchanged from ABI 1: only text reaches the Bot, other messages get the text-only notice.
      inboundImages: "disabled",
      inboundOtherMedia: "disabled",
      outboundReply: "available",
      proactiveMessages: "unavailable",
      streaming: "unavailable",
      approvals: "available",
      testMessage: "available",
    },
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
        identity: "link",
        // ADR-0047 amendment 2: the steps a person follows on the phone.
        setup: {
          steps: [
            {
              id: "number",
              text: "Pick the WhatsApp account that should answer. Messages to its number reach the chosen bot, so use a number meant for this rather than a personal one.",
            },
            {
              id: "phone",
              text: "On that phone, open WhatsApp, then Linked devices (in Settings on iPhone, in the ⋮ menu on Android), and choose Link a device.",
            },
            {
              id: "scan",
              text: "Press Connect here and scan the QR code that appears. The phone stays the account's main device and must keep its internet connection.",
            },
          ],
        },
        open: { label: "Open in WhatsApp", url: "https://wa.me/{handle}" },
        fields: [
          {
            key: "proxyUrl",
            label: "Proxy URL",
            kind: "password",
            secret: true,
            help: "Only when this server must reach WhatsApp through a proxy. Leave it empty otherwise.",
          },
        ],
      },
      {
        id: "cloud",
        label: "Business Cloud API",
        description: "Use a Meta Business phone number and signed webhooks.",
        // ADR-0047 amendment 2: the steps a person follows at Meta.
        setup: {
          steps: [
            {
              id: "app",
              text: "In Meta for Developers, create a Business app and add the WhatsApp product.",
              link: {
                label: "Open Meta for Developers",
                url: "https://developers.facebook.com/apps",
              },
            },
            {
              id: "number",
              text: "Under WhatsApp, API Setup, copy the Phone number ID of the number that should answer.",
            },
            {
              id: "token",
              text: "In Business settings, create a system user with the whatsapp_business_messaging permission and generate a permanent access token for it.",
              link: {
                label: "Open Business settings",
                url: "https://business.facebook.com/settings/system-users",
              },
            },
            {
              id: "secret",
              text: "Under App settings, Basic, copy the App secret.",
            },
            {
              id: "verify",
              text: "Make up a verify token: any long random text. Enter it below and in Meta's webhook settings.",
            },
            {
              id: "webhook",
              text: "Under WhatsApp, Configuration, set the Callback URL to this Deskmates server's public address followed by the path below, enter the verify token, and subscribe to the messages field.",
              copy: { label: "Webhook path", value: "{webhookPath}" },
            },
          ],
        },
        fields: [
          {
            key: "phoneNumberId",
            label: "Phone number ID",
            kind: "text",
            required: true,
            help: "WhatsApp › API Setup in your Meta app. It is a long number, not the phone number itself.",
          },
          {
            key: "graphApiVersion",
            label: "Graph API version",
            kind: "text",
            placeholder: "v23.0",
            help: "Leave it empty to use v23.0.",
          },
          {
            key: "accessToken",
            label: "Access token",
            kind: "password",
            secret: true,
            required: true,
            help: "A system user's permanent token with whatsapp_business_messaging.",
          },
          {
            key: "appSecret",
            label: "App secret",
            kind: "password",
            secret: true,
            required: true,
            help: "App settings › Basic in your Meta app. Deskmates uses it to check that webhooks come from Meta.",
          },
          {
            key: "verifyToken",
            label: "Verify token",
            kind: "password",
            secret: true,
            required: true,
            help: "The same text you enter in Meta's webhook settings.",
          },
        ],
      },
    ],
  },
  create: async (context) => new WhatsAppPluginRuntime(context),
};
