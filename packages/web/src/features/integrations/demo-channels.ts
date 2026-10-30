// The release channel plugins' manifests as the demo Gateway's catalog shows them: a copy of
// packages/channels made on 2026-10-22 (ADR-0047 amendment 2 guides included). The Web never
// imports packages/channels; this is demo data only, so a later guide change there does not
// reach the demo until this copy is refreshed.

import type { ChannelPluginManifestV2 } from "@deskmates/contracts";

export const DEMO_CHANNEL_MANIFESTS: ChannelPluginManifestV2[] = [
  {
    apiVersion: 2,
    id: "telegram",
    version: "1.0.0",
    displayName: "Telegram",
    description:
      "One Telegram bot per connection, answered by one Deskmates bot. Private chats only; text and images in, text replies out.",
    commandMenu: [
      { command: "start", description: "About this ongoing Agent conversation" },
      { command: "help", description: "Communication, results and approvals" },
      { command: "status", description: "Current work and message synchronization" },
      { command: "settings", description: "Open authorized Web settings" },
    ],
    multipleConnections: true,
    capabilities: {
      directMessages: "available",
      groups: "unavailable",
      inboundImages: "available",
      inboundOtherMedia: "disabled",
      outboundReply: "available",
      proactiveMessages: "unavailable",
      streaming: "disabled",
      approvals: "available",
      testMessage: "unavailable",
    },
    methods: [
      {
        id: "token",
        label: "Bot token",
        description:
          "Create a bot with @BotFather and paste its token. Each Deskmates bot needs its own Telegram bot. People must open the bot and press Start before it can reply.",
        setup: {
          steps: [
            {
              id: "botfather",
              text: "In Telegram, open @BotFather and send /newbot.",
              link: {
                label: "Open BotFather",
                url: "https://t.me/BotFather",
              },
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
        open: {
          label: "Open in Telegram",
          url: "https://t.me/{handle}",
        },
        fields: [
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
  },
  {
    apiVersion: 2,
    id: "whatsapp",
    version: "2.0.0",
    displayName: "WhatsApp",
    description: "Connect one WhatsApp account to one default Bot.",
    multipleConnections: false,
    senderAdmission: {
      mode: "blocklist",
    },
    capabilities: {
      directMessages: "available",
      groups: "unavailable",
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
        open: {
          label: "Open in WhatsApp",
          url: "https://wa.me/{handle}",
        },
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
              copy: {
                label: "Webhook path",
                value: "{webhookPath}",
              },
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
  {
    apiVersion: 2,
    id: "slack",
    version: "1.0.0",
    displayName: "Slack",
    description:
      "One Slack app per connection, installed in one Slack workspace; people message the Bot in the app's direct messages.",
    multipleConnections: true,
    capabilities: {
      directMessages: "available",
      groups: "unavailable",
      inboundImages: "available",
      inboundOtherMedia: "disabled",
      outboundReply: "available",
      proactiveMessages: "unavailable",
      streaming: "disabled",
      approvals: "available",
      testMessage: "unavailable",
    },
    methods: [
      {
        id: "socket-mode",
        label: "Slack app (Socket Mode)",
        description:
          "Create a Slack app with Socket Mode and the Messages tab on, subscribe it to the message.im bot event, give the bot the chat:write, im:history, files:read and users:read scopes, install it in your Slack workspace, then paste its bot token and an app-level token with connections:write.",
        setup: {
          steps: [
            {
              id: "create",
              text: "Create a Slack app: choose From a manifest, pick the Slack workspace people will use, and paste the app manifest below. Rename the app if you like.",
              link: {
                label: "Open Slack apps",
                url: "https://api.slack.com/apps?new_app=1",
              },
              copy: {
                label: "App manifest",
                value:
                  '{\n  "display_information": {\n    "name": "Deskmates"\n  },\n  "features": {\n    "app_home": {\n      "home_tab_enabled": false,\n      "messages_tab_enabled": true,\n      "messages_tab_read_only_enabled": false\n    },\n    "bot_user": {\n      "display_name": "Deskmates",\n      "always_online": true\n    }\n  },\n  "oauth_config": {\n    "scopes": {\n      "bot": [\n        "chat:write",\n        "im:history",\n        "files:read",\n        "users:read"\n      ]\n    }\n  },\n  "settings": {\n    "event_subscriptions": {\n      "bot_events": [\n        "message.im"\n      ]\n    },\n    "interactivity": {\n      "is_enabled": false\n    },\n    "org_deploy_enabled": false,\n    "socket_mode_enabled": true,\n    "token_rotation_enabled": false\n  }\n}',
              },
            },
            {
              id: "install",
              text: "Open Install App, install the app in the workspace, and copy the Bot User OAuth Token (xoxb-…).",
            },
            {
              id: "app-token",
              text: "Open Basic Information, App-Level Tokens: generate a token with the connections:write scope and copy it (xapp-…).",
            },
            {
              id: "paste",
              text: "Paste both tokens below and connect. Slack delivers messages over Socket Mode, so no public address is needed.",
            },
            {
              id: "message",
              text: "In Slack, open the app under Apps and write to it on its Messages tab.",
            },
          ],
        },
        open: {
          label: "Open in Slack",
          url: "https://slack.com/app_redirect?app={id}&team={namespace}",
        },
        fields: [
          {
            key: "botToken",
            label: "Bot token (xoxb-…)",
            kind: "password",
            secret: true,
            required: true,
            help: "Install App › Bot User OAuth Token. It starts with xoxb-.",
          },
          {
            key: "appToken",
            label: "App-level token (xapp-…)",
            kind: "password",
            secret: true,
            required: true,
            help: "Basic Information › App-Level Tokens, with the connections:write scope. It starts with xapp-.",
          },
        ],
      },
    ],
    statusVocabulary: ["connecting", "connected", "reconnecting", "revoked", "error", "stopped"],
  },
  {
    apiVersion: 2,
    id: "discord",
    version: "1.0.0",
    displayName: "Discord",
    description:
      "One Discord bot per connection. People talk to it in direct messages; server channels and threads are ignored.",
    multipleConnections: true,
    capabilities: {
      directMessages: "available",
      groups: "unavailable",
      inboundImages: "available",
      inboundOtherMedia: "disabled",
      outboundReply: "available",
      proactiveMessages: "unavailable",
      streaming: "disabled",
      approvals: "available",
      testMessage: "unavailable",
    },
    methods: [
      {
        id: "bot_token",
        label: "Bot token",
        description:
          "Create an application in the Discord developer portal, add a bot, and paste its token. People reach the bot by direct message; it needs no public URL.",
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
    statusVocabulary: ["connecting", "connected", "reconnecting", "revoked", "failed", "stopped"],
  },
];
