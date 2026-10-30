// The release-bundled Telegram channel plugin on ChannelPlugin ABI 2 (ADR-0047). One connection is
// one Telegram bot (`telegram:bot:<bot user id>` from `getMe`) bound to one Agent; a workspace may
// hold several, each its own bot. The bot token is a secret field, so the Gateway keeps it in its
// Secret Store and hands it to `verify` and `open` only; this plugin never writes or logs it.
// Transport is the Bot API over HTTPS with long polling, so no public URL is needed. The
// capability matrix below is what this version implements; every provider-specific row is
// unverified against a live bot until ADR-0047's live journey records it.

import type {
  ChannelCapabilityMatrix,
  ChannelPluginManifestV2,
  ChannelPluginRuntimeV2,
  ChannelPluginV2,
} from "@deskmates/contracts";
import {
  TELEGRAM_API_BASE_DEFAULT,
  TelegramApiError,
  TelegramBotApi,
  type TelegramTransport,
  isTelegramBotToken,
} from "./bot-api.js";
import { REVOKED_MESSAGE, TelegramConnection } from "./connection.js";
import { TELEGRAM_COMMANDS } from "./menu.js";
import { TelegramState } from "./state.js";

export const TELEGRAM_PLUGIN_ID = "telegram";
export const TELEGRAM_PLUGIN_VERSION = "1.0.0";

export const TELEGRAM_CAPABILITIES: ChannelCapabilityMatrix = {
  directMessages: "available",
  groups: "unavailable",
  inboundImages: "available",
  inboundOtherMedia: "disabled",
  outboundReply: "available",
  // Telegram lets a bot write only to a person who started it; unverified, so reply-only.
  proactiveMessages: "unavailable",
  streaming: "disabled",
  approvals: "available",
  // A test message would be a proactive send.
  testMessage: "unavailable",
};

export const TELEGRAM_MANIFEST: ChannelPluginManifestV2 = {
  apiVersion: 2,
  id: TELEGRAM_PLUGIN_ID,
  version: TELEGRAM_PLUGIN_VERSION,
  displayName: "Telegram",
  description:
    "One Telegram bot per connection, answered by one Deskmates bot. Private chats only; text and images in, text replies out.",
  multipleConnections: true,
  commandMenu: TELEGRAM_COMMANDS,
  capabilities: TELEGRAM_CAPABILITIES,
  methods: [
    {
      id: "token",
      label: "Bot token",
      description:
        "Create a bot with @BotFather and paste its token. Each Deskmates bot needs its own Telegram bot. People must open the bot and press Start before it can reply.",
      // ADR-0047 amendment 2: the steps a person follows in Telegram.
      setup: {
        steps: [
          {
            id: "botfather",
            text: "In Telegram, open @BotFather and send /newbot.",
            link: { label: "Open BotFather", url: "https://t.me/BotFather" },
          },
          {
            id: "name",
            text: "Choose a display name and a username that ends in bot. BotFather answers with the bot's token.",
          },
          {
            id: "one-bot",
            text: "Use a new Telegram bot for each Deskmates bot: one Telegram bot is answered by exactly one Deskmates bot.",
          },
          {
            id: "paste",
            text: "Paste the token below and connect. Deskmates asks Telegram for new messages itself, so no public address is needed.",
          },
          {
            id: "start",
            text: "Open the bot in Telegram and press Start. Telegram lets a bot reply only to people who started it.",
          },
        ],
      },
      open: { label: "Open in Telegram", url: "https://t.me/{handle}" },
      fields: [
        {
          key: "webUrl",
          label: "Web settings URL (optional)",
          kind: "text",
          secret: false,
          required: false,
          help: "An HTTPS link to your Deskmates Web app. People must sign in with an authorized workspace account.",
        },
        {
          key: "token",
          label: "Bot token",
          kind: "password",
          secret: true,
          required: true,
          placeholder: "123456789:AA…",
          help: "The token BotFather sent, like 123456789:AA…. Whoever has it controls the bot; Deskmates stores it encrypted and never shows it again.",
        },
      ],
    },
  ],
  statusVocabulary: [
    "connecting",
    "connected",
    "reconnecting",
    "conflict",
    "revoked",
    "identity_mismatch",
    "stopped",
  ],
};

export interface TelegramPluginOptions {
  /** How requests reach Telegram; T1 tests pass a fake server. Defaults to `fetch`. */
  transport?: TelegramTransport;
  apiBaseUrl?: string;
  /** `getUpdates` long-poll timeout in seconds. */
  pollTimeoutSeconds?: number;
  /** Backoff for polling and relay retries. */
  retry?: { initialMs: number; maxMs: number };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long `verify` waits for `getMe`. */
  verifyTimeoutMs?: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createTelegramPlugin(options: TelegramPluginOptions = {}): ChannelPluginV2 {
  const transport: TelegramTransport = options.transport ?? ((url, init) => fetch(url, init));
  const apiFor = (token: string) =>
    new TelegramBotApi({
      token,
      transport,
      apiBaseUrl: options.apiBaseUrl ?? TELEGRAM_API_BASE_DEFAULT,
    });

  const runtime = (): ChannelPluginRuntimeV2 => {
    const live = new Map<string, TelegramConnection>();
    const closeOne = async (connectionId: string): Promise<void> => {
      const connection = live.get(connectionId);
      live.delete(connectionId);
      await connection?.close();
    };
    return {
      verify: async (request) => {
        if (request.method !== "token") throw new Error("unknown Telegram connection method");
        const token = (request.secrets.token ?? "").trim();
        if (!isTelegramBotToken(token)) throw new Error("that is not a Telegram bot token");
        let me: Awaited<ReturnType<TelegramBotApi["getMe"]>>;
        try {
          me = await apiFor(token).getMe(AbortSignal.timeout(options.verifyTimeoutMs ?? 15_000));
        } catch (error) {
          // The message is token-free: TelegramApiError scrubs the transport's text.
          if (error instanceof TelegramApiError) throw new Error(error.message);
          throw new Error("Telegram did not answer");
        }
        if (!me?.is_bot || typeof me.id !== "number") throw new Error("the token is not a bot's");
        const label = me.username ? `@${me.username}` : me.first_name?.trim() || `bot ${me.id}`;
        return { identityKey: `${TELEGRAM_PLUGIN_ID}:bot:${me.id}`, label };
      },
      open: async (request, host) => {
        await closeOne(request.connectionId);
        const token = (request.secrets.token ?? "").trim();
        if (!isTelegramBotToken(token)) return { phase: "revoked", message: REVOKED_MESSAGE };
        const connection = new TelegramConnection({
          request,
          host,
          api: apiFor(token),
          state: new TelegramState(request.stateDirectory, {
            binding: request.bindingGeneration,
            credential: request.credentialGeneration,
          }),
          pollTimeoutSeconds: options.pollTimeoutSeconds ?? 50,
          retry: options.retry ?? { initialMs: 1_000, maxMs: 60_000 },
          sleep: options.sleep ?? abortableSleep,
        });
        live.set(request.connectionId, connection);
        return connection.start();
      },
      // Telegram has no session to log out of (`logOut` would move the bot off the cloud API);
      // a disconnect stops polling and the Gateway deletes the token and the state directory.
      close: (connectionId) => closeOne(connectionId),
      status: async (connectionId) => live.get(connectionId)?.status() ?? { phase: "stopped" },
      commandMenu: async (connectionId, input) => {
        const connection = live.get(connectionId);
        if (!connection)
          throw new Error("Reconnect this Telegram connection before managing its menu.");
        return connection.commandMenu(input);
      },
      test: async () => {
        throw new Error("Telegram connections offer no test message");
      },
      webhook: async () => ({ status: 404, body: "this Telegram connection uses long polling" }),
      stop: async () => {
        await Promise.allSettled([...live.keys()].map((id) => closeOne(id)));
      },
    };
  };

  return {
    manifest: TELEGRAM_MANIFEST,
    create: async () => runtime(),
  };
}

/** The release entry point's export (ADR-0017 amendment 1 P2). */
export const channelPlugin: ChannelPluginV2 = createTelegramPlugin();
