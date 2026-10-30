// The Discord plugin's ABI-2 manifest (ADR-0047): one Discord application's bot user per
// connection, direct messages only, over the Discord Gateway websocket and the REST API. Every
// provider-specific cell of the capability matrix is read from Discord's public documentation and
// is unverified until a live journey records it (ADR-0047 decision 12, Verification "1 (live)").

import type { ChannelCapabilityMatrix, ChannelPluginManifestV2 } from "@deskmates/contracts";

export const DISCORD_PLUGIN_ID = "discord";
export const DISCORD_PLUGIN_VERSION = "1.0.0";
/** The only connection method: a bot token from the application's Bot page. */
export const DISCORD_METHOD_BOT_TOKEN = "bot_token";

export const DISCORD_CAPABILITIES: ChannelCapabilityMatrix = {
  directMessages: "available",
  // Owner ruling 2026-10-17: 1:1 only. Guild channels, threads and group DMs are not modelled.
  groups: "unavailable",
  inboundImages: "available",
  inboundOtherMedia: "disabled",
  outboundReply: "available",
  // A bot can open a DM to a user who shares a server with it; not verified, so reply-only.
  proactiveMessages: "unavailable",
  streaming: "disabled",
  approvals: "available",
  // A test message would be a proactive send.
  testMessage: "unavailable",
};

/** Phases `status` reports; the labels are safe to show to an operator. */
export const DISCORD_STATUS_VOCABULARY = [
  "connecting",
  "connected",
  "reconnecting",
  "revoked",
  "failed",
  "stopped",
] as const;

export type DiscordPhase = (typeof DISCORD_STATUS_VOCABULARY)[number];

export const discordManifest: ChannelPluginManifestV2 = {
  apiVersion: 2,
  id: DISCORD_PLUGIN_ID,
  version: DISCORD_PLUGIN_VERSION,
  displayName: "Discord",
  description:
    "One Discord bot per connection. People talk to it in direct messages; server channels and threads are ignored.",
  multipleConnections: true,
  capabilities: DISCORD_CAPABILITIES,
  methods: [
    {
      id: DISCORD_METHOD_BOT_TOKEN,
      label: "Bot token",
      description:
        "Create an application in the Discord developer portal, add a bot, and paste its token. People reach the bot by direct message; it needs no public URL.",
      // ADR-0047 amendment 2: the steps a person follows in the developer portal.
      setup: {
        steps: [
          {
            id: "create",
            text: "In the Discord developer portal, choose New Application and give it a name.",
            link: {
              label: "Open the developer portal",
              url: "https://discord.com/developers/applications",
            },
          },
          {
            id: "token",
            text: "Open Bot and press Reset Token, then copy the token. No privileged intent is needed: the bot reads only direct messages.",
          },
          {
            id: "paste",
            text: "Paste the token below and connect. The bot keeps its own connection to Discord, so no public address is needed.",
          },
          {
            id: "server",
            text: "Discord lets people message a bot only when they share a server with it. After connecting, add the bot to a server they are in.",
          },
        ],
      },
      open: {
        label: "Add to a Discord server",
        url: "https://discord.com/oauth2/authorize?client_id={id}&scope=bot",
      },
      fields: [
        {
          key: "token",
          label: "Bot token",
          kind: "password",
          secret: true,
          required: true,
          help: "Developer portal › your application › Bot › Reset Token. Whoever has it controls the bot.",
        },
      ],
    },
  ],
  statusVocabulary: DISCORD_STATUS_VOCABULARY,
};
