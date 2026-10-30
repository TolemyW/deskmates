// Release entry point of the Slack channel plugin (ChannelPlugin ABI 2, ADR-0047; issue
// deskmates-private#4). One connection is one Slack app installed in one Slack workspace, bound to
// one Bot; a workspace may hold several, each its own app. Socket Mode carries events, so no
// public ingress is needed; the Web API carries replies. 1:1 direct messages only.
//
// The capability matrix is what this version implements, not what Slack offers: groups, channels
// and threads are not implemented; inbound images are received; other files are refused with a
// notice; replies only, never a proactive send; no streaming; no test message (it would be a
// proactive send). Every Slack-specific cell is unverified against a live workspace.

import { CHANNEL_PLUGIN_API_VERSION_2, type ChannelPluginV2 } from "@deskmates/contracts";
import { SLACK_CHANNEL } from "./connection.js";
import { SLACK_METHOD_ID, SlackRuntime } from "./runtime.js";

/** The Slack app this plugin needs (Socket Mode, the Messages tab, DM events and four scopes). */
const SLACK_APP_MANIFEST = JSON.stringify(
  {
    display_information: { name: "Deskmates" },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: "Deskmates", always_online: true },
    },
    oauth_config: {
      scopes: { bot: ["chat:write", "im:history", "files:read", "users:read"] },
    },
    settings: {
      event_subscriptions: { bot_events: ["message.im"] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  },
  null,
  2,
);

export const channelPlugin: ChannelPluginV2 = {
  manifest: {
    apiVersion: CHANNEL_PLUGIN_API_VERSION_2,
    id: SLACK_CHANNEL,
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
        id: SLACK_METHOD_ID,
        label: "Slack app (Socket Mode)",
        description:
          "Create a Slack app with Socket Mode and the Messages tab on, subscribe it to the message.im bot event, give the bot the chat:write, im:history, files:read and users:read scopes, install it in your Slack workspace, then paste its bot token and an app-level token with connections:write.",
        // ADR-0047 amendment 2: the same app, created from a manifest instead of by hand.
        setup: {
          steps: [
            {
              id: "create",
              text: "Create a Slack app: choose From a manifest, pick the Slack workspace people will use, and paste the app manifest below. Rename the app if you like.",
              link: { label: "Open Slack apps", url: "https://api.slack.com/apps?new_app=1" },
              copy: { label: "App manifest", value: SLACK_APP_MANIFEST },
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
  create: async () => new SlackRuntime(),
};
